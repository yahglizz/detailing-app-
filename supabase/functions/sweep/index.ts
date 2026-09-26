import { createClient } from 'npm:@supabase/supabase-js@2';
import { getProvider } from '../_shared/payments/provider.ts';
import { sendEmail, ownerEmail, functionsBaseUrl, button } from '../_shared/notify.ts';
import { restoreMemberBalances } from '../_shared/member_refund.ts';
import { refundBooking, settleBooking } from '../_shared/booking_payment.ts';
import { settleTopup } from '../_shared/wallet.ts';

Deno.serve(async () => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const dayAgo = new Date(Date.now() - 24 * 3600e3).toISOString();
  const twoDaysAgo = new Date(Date.now() - 48 * 3600e3).toISOString();
  let reminded = 0, refunded = 0, settled = 0;

  // ——— checkouts nobody came back from ———
  // A pending booking holds its slot. The Stripe session expires after 35 minutes and
  // the webhook normally settles it; this catches any the webhook missed (paid →
  // fulfilled, never paid → slot freed). Balance top-ups the same way.
  const stale45 = new Date(Date.now() - 45 * 60e3).toISOString();
  const [{ data: pending }, { data: pendingTopups }] = await Promise.all([
    db.from('bookings').select('id, status, stripe_session_id, pay_mode').eq('status', 'pending_payment').lt('created_at', stale45),
    db.from('topups').select('id, status, stripe_session_id').eq('status', 'pending').lt('created_at', stale45),
  ]);
  if (pending?.length || pendingTopups?.length) {
    const pay = await getProvider(db);
    for (const b of pending ?? []) {
      try {
        if ((await settleBooking(db, pay, b)) !== 'processing') settled++;
      } catch (e) {
        console.error('sweep settle failed', b.id, (e as Error).message);
      }
    }
    for (const t of pendingTopups ?? []) {
      try {
        if ((await settleTopup(db, pay, t)) !== 'processing') settled++;
      } catch (e) {
        console.error('sweep top-up settle failed', t.id, (e as Error).message);
      }
    }
  }

  // Wrong-code records only matter for 15 minutes (codes.ts).
  await db.from('code_attempts').delete().lt('created_at', dayAgo);

  const { data: stale } = await db.from('bookings')
    .select('id, confirm_token, created_at, quote, reminder_sent_at, membership_id, customers(email)')
    .eq('status', 'requested').lt('created_at', dayAgo);

  for (const b of stale ?? []) {
    if (b.created_at < twoDaysAgo) {
      // Claim first so the owner declining at the same moment can't double-refund.
      const { data: won } = await db.from('bookings').update({ status: 'refunded' })
        .eq('id', b.id).eq('status', 'requested').select('id');
      if (!won?.length) continue;
      const r = await refundBooking(db, b.id);
      if (!r.ok) {
        // Leave it for the next hourly run rather than tell them it was refunded.
        await db.from('bookings').update({ status: 'requested' }).eq('id', b.id);
        continue;
      }
      const walletBack = await restoreMemberBalances(db, b);
      await sendEmail((b.customers as unknown as { email: string }).email,
        r.amountCents ? 'Your payment has been refunded' : 'About your detail request',
        `<h2 style="color:#A855F7;margin:0 0 12px">Sorry about that</h2>
         <p>We couldn't get to your request in time${r.amountCents ? `, so your $${r.amountCents / 100} payment has been refunded in full` : ''}.</p>
         ${walletBack ? `<p>The $${walletBack} from your balance is back on your balance.</p>` : ''}`);
      refunded++;
    } else if (!b.reminder_sent_at) {
      await sendEmail(ownerEmail(), 'Unanswered detail request — auto-refund in 24h',
        `<h2 style="color:#A855F7;margin:0 0 12px">Still waiting on you</h2>
         <p>A detail request from yesterday hasn't been answered. It auto-refunds at 48 hours.</p>
         ${button(`${functionsBaseUrl()}/confirm?token=${b.confirm_token}`, 'Handle it now →')}`);
      await db.from('bookings').update({ reminder_sent_at: new Date().toISOString() }).eq('id', b.id);
      reminded++;
    }
  }

  // ——— monthly membership credit grants ———
  // Grant credits_per_period for every WHOLE month elapsed since period_start,
  // keeping the original day-of-month as the billing anchor (clamped when the
  // target month is shorter — e.g. a Jan-31 anchor grants on Feb-28, not Mar-3).
  // Idempotent: the ledger row is keyed by the new period date, so a failed
  // period_start update just makes the next hourly run skip (no double-grant),
  // and a failed insert leaves period_start put (retried next run, no skip).
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  const todayY = today.getUTCFullYear(), todayM = today.getUTCMonth(), todayD = today.getUTCDate();
  let granted = 0;
  const { data: members } = await db.from('memberships')
    .select('id, credits_per_period, period_start, created_at').eq('active', true);
  for (const m of members ?? []) {
    const start = new Date(String(m.period_start) + 'T00:00:00Z');
    // Anchor day comes from the immutable signup date, not the mutable
    // period_start — otherwise clamping a 31st anchor to Feb-28 would ratchet
    // every later month down to the 28th and never recover.
    const anchorDay = new Date(String(m.created_at)).getUTCDate();
    let elapsed = (todayY - start.getUTCFullYear()) * 12 + (todayM - start.getUTCMonth());
    // The current month isn't complete until its clamped anchor day. Clamp the
    // threshold to this month's length so a 31st anchor still comes due on the
    // last day of a short month (e.g. Feb 28), not slip to next month.
    const daysThisMonth = new Date(Date.UTC(todayY, todayM + 1, 0)).getUTCDate();
    if (todayD < Math.min(anchorDay, daysThisMonth)) elapsed--;
    if (elapsed <= 0) continue;

    const mi = start.getUTCMonth() + elapsed;
    const ny = start.getUTCFullYear() + Math.floor(mi / 12);
    const nm = ((mi % 12) + 12) % 12;
    const daysInMonth = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    const newStart = `${ny}-${pad(nm + 1)}-${pad(Math.min(anchorDay, daysInMonth))}`;
    const reason = `monthly grant→${newStart}`;

    // Skip if this period was already granted (a prior run inserted but its
    // period_start update failed) — makes the whole grant idempotent.
    const { data: dup } = await db.from('credit_ledger')
      .select('id').eq('membership_id', m.id).eq('reason', reason).limit(1);
    if (dup && dup.length > 0) {
      await db.from('memberships').update({ period_start: newStart }).eq('id', m.id);
      continue;
    }
    const { error: insErr } = await db.from('credit_ledger').insert({
      membership_id: m.id, delta: m.credits_per_period * elapsed, reason,
    });
    if (insErr) continue; // leave period_start; retry next run
    await db.from('memberships').update({ period_start: newStart }).eq('id', m.id);
    granted += elapsed;
  }
  return Response.json({ reminded, refunded, settled, granted });
});
