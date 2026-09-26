// A booking's payment lifecycle, shared by book, stripe-webhook, confirm and sweep.
//
// book inserts the booking as pending_payment (slot held, any member credit/reward
// already reserved) and sends the customer to Stripe Checkout. Then:
//   paid      → fulfillBooking: record the payment, settle the slot, status requested, emails
//   abandoned → declinePending: status declined, reserved credit/reward handed back
// Both the Stripe webhook and the app's return drive this; whichever lands first does
// the work and the other is a no-op (conditional status updates, deduped payment rows).
import { sendEmail, ownerEmail, adminLink, button, esc } from './notify.ts';
import { decideBump, nextOpenSlot } from './bump.ts';
import { REWARD_LABELS, type RewardKey } from './membership.ts';
import { restoreMemberBalances } from './member_refund.ts';
import { formatWhen } from './payments/checkout.ts';
import { getProvider, type Payments } from './payments/provider.ts';
import type { CarItem } from './pricing.ts';

// deno-lint-ignore no-explicit-any
type Db = any;

export interface Paid { kind: 'deposit' | 'full'; amountCents: number; ref: string }

interface FrozenQuote {
  total: number; payable: number; creditsUsed: number; anchored: boolean;
  tier?: string | null; reward?: RewardKey | null;
  walletUsed?: number; savings?: number; test?: boolean; // since the prepaid balance (0012)
}

// Returns false only when the payment couldn't be recorded — the caller should retry
// (webhook → 500 so Stripe resends) rather than fulfill a booking refunds can't find.
export async function fulfillBooking(db: Db, bookingId: string, paid: Paid | null): Promise<boolean> {
  if (paid) {
    const { error } = await db.from('payments').insert({
      booking_id: bookingId, kind: paid.kind, amount_cents: paid.amountCents,
      status: 'succeeded', provider: 'stripe', provider_ref: paid.ref,
    });
    // 23505 = the other path already recorded this payment.
    if (error && error.code !== '23505') {
      console.error('payment record failed', bookingId, error.message);
      return false;
    }
  }

  const { data: claimed } = await db.from('bookings').update({ status: 'requested' })
    .eq('id', bookingId).eq('status', 'pending_payment').select('id');
  if (!claimed?.length) {
    // Already fulfilled by the other path — unless we'd let the booking go, in which
    // case money arrived for nothing (shouldn't happen): give it straight back.
    if (paid) {
      const { data: cur } = await db.from('bookings').select('status').eq('id', bookingId).single();
      if (cur?.status === 'declined') {
        console.error('payment for a declined booking — refunding', bookingId, paid.ref);
        await refundBooking(db, bookingId);
      }
    }
    return true;
  }

  const { data: b } = await db.from('bookings').select('*, customers(email, name)').eq('id', bookingId).single();
  const q = b.quote as FrozenQuote;
  const items = b.items as CarItem[];
  const customer = b.customers as { email: string; name: string };
  const link = adminLink(b.id);

  // ——— slot: decide again now the money is in — up to 35 minutes have passed ———
  let escalated = false;
  if (b.time_slot) {
    const { data: others } = await db.from('bookings')
      .select('id, rank, anchored, customer_id, status')
      .eq('preferred_day', b.preferred_day).eq('time_slot', b.time_slot).neq('id', b.id)
      .not('status', 'in', '("declined","refunded")')
      .order('anchored', { ascending: false }).order('rank', { ascending: false }).limit(1);
    const holder = others?.[0] ?? null;
    const decision = decideBump(b.rank, holder);
    let why = '';
    if (decision === 'bump') {
      const { data: takenRows } = await db.rpc('slot_states', { day: b.preferred_day });
      const target = nextOpenSlot(((takenRows ?? []) as { slot: string }[]).map((r) => r.slot), b.time_slot);
      if (target) {
        await db.from('bookings')
          .update({ time_slot: target, bumped_from: b.time_slot, time_window: Number(target.slice(0, 2)) < 12 ? 'morning' : 'afternoon' })
          .eq('id', holder.id);
        // A holder still at checkout will see the new time in their own confirmation.
        const { data: holderCust } = holder.status === 'pending_payment'
          ? { data: null }
          : await db.from('customers').select('email').eq('id', holder.customer_id).single();
        if (holderCust?.email) {
          await sendEmail(holderCust.email, `Your detail moved to ${target} — here's why`,
            `<h2 style="color:#A855F7;margin:0 0 12px">Small schedule change</h2>
             <p>A VIP member reserved your original window, so your detail on <b>${b.preferred_day}</b> moved from ${b.time_slot} to <b>${target}</b>.</p>
             <p style="color:#A9A4AF">Members never get bumped — ask us about membership, or add a Slot Anchor next time to lock your time.</p>`);
        }
      } else {
        why = 'the day is full, so nobody can be moved automatically';
      }
    } else if (decision !== 'open') {
      why = decision === 'escalate'
        ? 'another member of the same tier already holds it'
        : 'someone with priority took it while this customer was checking out';
    }
    if (why) {
      escalated = true;
      await db.from('bookings').update({ time_slot: null }).eq('id', b.id);
      await sendEmail(ownerEmail(), `Slot conflict needs you — ${b.preferred_day} ${b.time_slot}`,
        `<h2 style="color:#A855F7;margin:0 0 12px">Pick a time for this one</h2>
         <p>A booking wants <b>${formatWhen(b.preferred_day, b.time_slot, b.time_window)}</b>, but ${why}. It has no time yet — set its exact time in the dashboard.</p>
         ${button(link, 'Resolve →')}`);
    }
  }

  // ——— emails ———
  const paidNow = paid ? paid.amountCents / 100 : 0;
  const walletUsed = q.walletUsed ?? 0;
  const balance = q.payable - walletUsed - paidNow; // due at the detail
  const when = escalated
    ? `${formatWhen(b.preferred_day, null, b.time_window)} — exact time to be confirmed`
    : formatWhen(b.preferred_day, b.time_slot, b.time_window);
  const summary = items
    .map((i, n) => `<div>Car ${n + 1}${i.label ? ` (${esc(i.label)})` : ''}: <b>${i.service}</b> / ${i.size}${i.extras.length ? ' + ' + i.extras.join(', ') : ''}</div>`)
    .join('');
  const shortSummary = items.map((i) => `${i.service}/${i.size}`).join(', ');
  const memberTag = q.tier ? ` — MEMBER ${q.tier.toUpperCase()}${q.creditsUsed ? ` (${q.creditsUsed} credit)` : ''}` : '';
  const rewardTag = q.reward ? `<p style="color:#F5B942">Reward attached: ${REWARD_LABELS[q.reward]}</p>` : '';
  const money = !paid ? (walletUsed ? `$${walletUsed} from balance` : '(credit)') : balance > 0 ? `$${paidNow} deposit PAID` : `$${paidNow} PAID IN FULL`;

  await sendEmail(
    ownerEmail(),
    `${q.test ? 'TEST ACCOUNT — ' : ''}New detail — ${shortSummary}${memberTag} — ${money}`,
    `<h2 style="color:#A855F7;margin:0 0 12px">New Detail Request${memberTag}</h2>
     ${summary}${rewardTag}
     <p style="color:#A9A4AF">${escalated ? 'TIME CONFLICT — resolve · ' : ''}${when} · ${esc(b.address)}</p>
     <p style="color:#A9A4AF">Customer: ${esc(customer.name) || '—'} · ${esc(customer.email)}</p>
     <p style="color:#A9A4AF">Notes: ${esc(b.notes) || '—'}</p>
     ${q.test ? '<p style="color:#F97066">Booked from an owner TEST account — the balance and credits are not real money.</p>' : ''}
     <p>Retail $${q.total} · Payable $${q.payable}${walletUsed ? ` · From balance $${walletUsed}` : ''} · Paid online $${paidNow} · $${balance} due${balance > 0 ? ` (${b.remainder_method})` : ''}${q.anchored ? ' · ANCHORED' : ''}</p>
     ${button(link, 'Confirm or decline →')}`,
  );

  await sendEmail(
    customer.email,
    !paid
      ? (q.tier ? 'Your member wash is booked' : 'Your detail is booked')
      : balance > 0 ? `We got your detail request — $${paidNow} deposit received` : `You're booked — $${paidNow} paid in full`,
    `<h2 style="color:#A855F7;margin:0 0 12px">Thanks${customer.name ? ', ' + esc(customer.name) : ''}!</h2>
     ${summary}${rewardTag}
     <p style="color:#A9A4AF">${when} · ${esc(b.address)}</p>
     ${q.creditsUsed ? `<p>Paid with ${q.creditsUsed} membership credit${q.creditsUsed > 1 ? 's' : ''}.</p>` : ''}
     ${walletUsed ? `<p>Paid $${walletUsed} from your balance.</p>` : ''}
     ${q.savings && q.tier ? `<p style="color:#F5B942">You saved $${q.savings} with your ${q.tier.toUpperCase()} membership.</p>` : ''}
     ${paid ? (balance > 0
       ? `<p>Deposit paid: $${paidNow}. Due at the detail: $${balance} (${b.remainder_method}).</p>`
       : `<p>Paid in full: $${paidNow}. Nothing due at the detail.</p>`) : balance > 0 ? `<p>Due at the detail: $${balance} (${b.remainder_method}).</p>` : ''}
     ${q.anchored ? `<p>Slot Anchor active — your time is locked. 🔒</p>` : ''}
     <p style="color:#A9A4AF">We'll email you shortly to lock in your exact time.</p>`,
  );
  return true;
}

// A checkout that will never be paid: free the slot and hand back the reserved
// credit, reward and balance. Conditional on pending_payment, so it runs at most once.
export async function declinePending(db: Db, bookingId: string): Promise<void> {
  const { data } = await db.from('bookings').update({ status: 'declined' })
    .eq('id', bookingId).eq('status', 'pending_payment').select('id, membership_id');
  if (data?.[0]) await restoreMemberBalances(db, data[0]);
}

export type Settled = 'paid' | 'cancelled' | 'processing';

// Brings a checkout to its final state from Stripe's own record of it: paid → onPaid,
// never paid → onCancel. Called when the customer comes back from checkout (paid,
// backed out, or closed the sheet) and by sweep for anything still pending. Safe to
// call repeatedly. Shared by bookings and balance top-ups.
export async function settleCheckout(
  pay: Payments | null, sessionId: string | null,
  onPaid: (ref: string, amountCents: number) => Promise<boolean>, onCancel: () => Promise<void>,
): Promise<Settled> {
  if (!sessionId) {
    await onCancel(); // never reached checkout
    return 'cancelled';
  }
  if (!pay) return 'processing';

  let s = await pay.getCheckout(sessionId);
  if (s.status === 'open') {
    // They left without paying. Close the session so it can't be paid later, then
    // re-read: they may have paid in the moment before it closed.
    await pay.expireCheckout(sessionId);
    s = await pay.getCheckout(sessionId);
  }
  if (s.status === 'complete') {
    if (!s.paid || !s.paymentRef) return 'processing';
    return (await onPaid(s.paymentRef, s.amountCents)) ? 'paid' : 'processing';
  }
  if (s.status === 'open') return 'processing';
  await onCancel();
  return 'cancelled';
}

export async function settleBooking(
  db: Db, pay: Payments | null,
  b: { id: string; status: string; stripe_session_id: string | null; pay_mode: string },
): Promise<Settled> {
  if (b.status === 'declined') return 'cancelled';
  if (b.status !== 'pending_payment') return 'paid';
  return await settleCheckout(pay, b.stripe_session_id,
    (ref, amountCents) => fulfillBooking(db, b.id, { kind: b.pay_mode === 'full' ? 'full' : 'deposit', amountCents, ref }),
    () => declinePending(db, b.id));
}

// Refunds whatever was paid online for a booking (deposit or full). Credit-covered
// bookings have nothing to refund. ok=false means no money went back — the caller
// must not tell the customer they were refunded.
export async function refundBooking(db: Db, bookingId: string): Promise<{ ok: boolean; amountCents: number }> {
  const { data: rows } = await db.from('payments').select('provider, provider_ref, amount_cents')
    .eq('booking_id', bookingId).in('kind', ['deposit', 'full']).eq('status', 'succeeded').limit(1);
  const p = rows?.[0];
  if (!p?.provider_ref) return { ok: true, amountCents: 0 };
  let ref = `refund_${p.provider_ref}`; // bookings from before Stripe used a fake processor
  if (p.provider === 'stripe') {
    const pay = await getProvider(db);
    const r = pay ? await pay.refund(p.provider_ref) : null;
    if (!r?.ok) return { ok: false, amountCents: 0 };
    ref = r.ref;
  }
  await db.from('payments').insert({
    booking_id: bookingId, kind: 'refund', amount_cents: p.amount_cents,
    status: 'succeeded', provider: p.provider, provider_ref: ref,
  });
  return { ok: true, amountCents: p.amount_cents };
}
