// Prepaid balance ("wallet" in code, "balance" in the app), in whole dollars.
// Loaded through Stripe Checkout (the topup function), spent at checkout (book reserves
// it, member_refund hands it back if the booking is voided).
//
// A top-up's lifecycle mirrors a booking's: topup inserts it as pending and opens a
// checkout; paid → fulfillTopup, never paid → cancelTopup. The webhook, the app's return
// (topup action 'settle') and sweep all drive it; whichever lands first does the work.
import { esc, ownerEmail, sendEmail } from './notify.ts';
import { loginCode } from './codes.ts';
import { settleCheckout, type Settled } from './booking_payment.ts';
import type { Payments } from './payments/provider.ts';

// deno-lint-ignore no-explicit-any
type Db = any;

export async function walletBalance(db: Db, customerId: string): Promise<number> {
  const { data } = await db.from('wallet_ledger').select('delta').eq('customer_id', customerId);
  return ((data ?? []) as { delta: number }[]).reduce((s, r) => s + r.delta, 0);
}

// Paid: credit the amount and bonus, then mark the top-up paid and send the receipt.
// Ledger rows are keyed by the payment, so a repeat call inserts nothing, and only the
// call that flips the status emails. false = the balance couldn't be written; retry.
export async function fulfillTopup(db: Db, topupId: string, paymentRef: string): Promise<boolean> {
  const { data: t } = await db.from('topups').select('id, customer_id, amount, bonus').eq('id', topupId).single();
  if (!t) return false;
  const rows = [{ customer_id: t.customer_id, topup_id: t.id, delta: t.amount, reason: 'top-up', ref: `topup:${paymentRef}` }];
  if (t.bonus > 0) rows.push({ customer_id: t.customer_id, topup_id: t.id, delta: t.bonus, reason: 'top-up bonus', ref: `topup:${paymentRef}:bonus` });
  for (const row of rows) {
    const { error } = await db.from('wallet_ledger').insert(row);
    // 23505 = the other path already credited it.
    if (error && error.code !== '23505') {
      console.error('top-up credit failed', t.id, error.message);
      return false;
    }
  }
  let code: string;
  try {
    code = await loginCode(db, t.customer_id); // before the claim: a failure here is retried
  } catch (e) {
    console.error('top-up login code failed', t.id, (e as Error).message);
    return false;
  }
  // A checkout can't be paid after it expires, but if money ever lands on a cancelled
  // top-up it is still the customer's.
  const { data: claimed } = await db.from('topups').update({ status: 'paid', payment_ref: paymentRef })
    .eq('id', t.id).in('status', ['pending', 'cancelled']).select('id');
  if (!claimed?.length) return true;

  const [{ data: c }, balance] = await Promise.all([
    db.from('customers').select('email, name').eq('id', t.customer_id).single(),
    walletBalance(db, t.customer_id),
  ]);
  await sendEmail(c.email, `$${t.amount + t.bonus} added to your BLD balance`,
    `<h2 style="color:#A855F7;margin:0 0 12px">You're loaded${c.name ? ', ' + esc(c.name) : ''}!</h2>
     <p>We added <b>$${t.amount}</b>${t.bonus ? ` plus a <b>$${t.bonus} member bonus</b>` : ''} to your balance. You now have <b>$${balance}</b>.</p>
     <p>Your login code:</p>
     <p style="font-family:monospace;font-size:28px;color:#F5B942;letter-spacing:3px">${code}</p>
     <p style="color:#A9A4AF">Open the BLD app → "Log in with your code". Your balance pays for your next detail at checkout.</p>`);
  await sendEmail(ownerEmail(), `Balance top-up — $${t.amount} from ${esc(c.name || c.email)}`,
    `<h2 style="color:#A855F7;margin:0 0 12px">Balance top-up</h2>
     <p>${esc(c.name) || '—'} · ${esc(c.email)} paid $${t.amount}${t.bonus ? ` (+$${t.bonus} member bonus)` : ''}. Their balance is now $${balance}.</p>`);
  return true;
}

export async function cancelTopup(db: Db, topupId: string): Promise<void> {
  await db.from('topups').update({ status: 'cancelled' }).eq('id', topupId).eq('status', 'pending');
}

export async function settleTopup(
  db: Db, pay: Payments | null, t: { id: string; status: string; stripe_session_id: string | null },
): Promise<Settled> {
  if (t.status === 'paid') return 'paid';
  if (t.status === 'cancelled') return 'cancelled';
  return await settleCheckout(pay, t.stripe_session_id,
    (ref) => fulfillTopup(db, t.id, ref),
    () => cancelTopup(db, t.id));
}

// The owner refunded a top-up in Stripe: take the refunded share of it (bonus included)
// back off the balance, as far as the balance still covers it. Stripe reports the
// refunded total so far, so each partial refund takes back only what earlier ones
// didn't. Payments that aren't top-ups (booking refunds) are ignored.
export async function takeBackRefund(
  db: Db, charge: { paymentRef: string | null; amountCents: number; refundedCents: number },
): Promise<void> {
  if (!charge.paymentRef || !charge.amountCents) return;
  const { data: t } = await db.from('topups').select('id, customer_id, amount, bonus')
    .eq('payment_ref', charge.paymentRef).maybeSingle();
  if (!t) return;
  const target = Math.round(((t.amount + t.bonus) * charge.refundedCents) / charge.amountCents);
  const { data: rows } = await db.from('wallet_ledger').select('delta').eq('topup_id', t.id).eq('reason', 'top-up refund');
  const taken = -((rows ?? []) as { delta: number }[]).reduce((s, r) => s + r.delta, 0);
  const owed = target - taken;
  if (owed <= 0) return; // already taken back (a repeat, or a later refund got here first)
  const take = Math.min(owed, await walletBalance(db, t.customer_id));
  if (take > 0) {
    // The ref chains on what was already taken, so two refund events landing at once
    // can't both take the same share: the second one collides and Stripe retries it.
    const { error } = await db.from('wallet_ledger').insert({
      customer_id: t.customer_id, topup_id: t.id, delta: -take, reason: 'top-up refund',
      ref: `topup_refund:${t.id}:${taken}`,
    });
    if (error) throw new Error(error.message); // collided, or spent in the same moment: the webhook retries
  }
  if (take < owed) {
    await sendEmail(ownerEmail(), `Refunded top-up was already spent — $${owed - take}`,
      `<h2 style="color:#A855F7;margin:0 0 12px">Heads up</h2>
       <p>You refunded a balance top-up, but $${owed - take} of it had already been spent on a detail, so it couldn't come off their balance.</p>`);
  }
}
