// What the owner and managers do to a booking from the dashboard: confirm (or move) its
// time, decline and refund it, and mark it done. Each one claims the booking's status in
// the same UPDATE that changes it, so a double-click or two staff at once can't email,
// refund or grant stamps twice.
import { esc, sendEmail } from './notify.ts';
import { refundBooking } from './booking_payment.ts';
import { restoreMemberBalances } from './member_refund.ts';
import { formatWhen } from './payments/checkout.ts';
import { ALL_SLOTS } from './bump.ts';
import { detailPricingOf } from './membership.ts';

// deno-lint-ignore no-explicit-any
type Db = any;
export type ActionResult = { ok: true; [k: string]: unknown } | { ok: false; error: string };

const OPEN = ['requested', 'confirmed'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Confirm a requested booking at a day + slot, or move a confirmed one. The owner may put
// a job on a full day (their call), but never on top of another job's slot.
export async function confirmBooking(db: Db, id: string, day: string, slot: string | null, expectSlot?: string | null): Promise<ActionResult> {
  if (!ISO_DAY.test(day) || (slot !== null && !ALL_SLOTS.includes(slot))) return { ok: false, error: 'bad_time' };
  const { data: b } = await db.from('bookings')
    .select('id, status, preferred_day, time_slot, time_window, address, customers(email)').eq('id', id).maybeSingle();
  if (!b) return { ok: false, error: 'not_found' };
  if (!OPEN.includes(b.status)) return { ok: false, error: 'not_open' };

  if (slot) {
    const { data: clash } = await db.from('bookings').select('id')
      .eq('preferred_day', day).eq('time_slot', slot).neq('id', id)
      .not('status', 'in', '("declined","refunded")').limit(1);
    if (clash?.length) return { ok: false, error: 'slot_taken' };
  }

  const when = formatWhen(day, slot, b.time_window);
  const moved = b.status === 'confirmed' && (b.preferred_day !== day || (b.time_slot ?? null) !== slot);
  // expectSlot = the slot the dashboard showed; a VIP bump may have moved the row since
  let upd = db.from('bookings')
    .update({ status: 'confirmed', preferred_day: day, time_slot: slot, scheduled_note: when })
    .eq('id', id).eq('status', b.status);
  if (expectSlot !== undefined) upd = expectSlot === null ? upd.is('time_slot', null) : upd.eq('time_slot', expectSlot);
  const { data: won } = await upd.select('id');
  if (!won?.length) {
    if (expectSlot !== undefined) {
      const { data: now } = await db.from('bookings').select('time_slot').eq('id', id).maybeSingle();
      if (now && (now.time_slot ?? null) !== expectSlot) return { ok: false, error: 'slot_changed' };
    }
    return { ok: false, error: 'not_open' };
  }

  const email = (b.customers as { email: string } | null)?.email ?? '';
  if (b.status === 'requested') {
    await sendEmail(email, `You're confirmed for ${when}`,
      `<h2 style="color:#A855F7;margin:0 0 12px">You're confirmed ✓</h2>
       <p>We'll see you <b>${esc(when)}</b> at ${esc(b.address)}.</p>
       <p style="color:#A9A4AF">Reply to this email if anything changes.</p>`);
  } else if (moved) {
    await sendEmail(email, `Your detail moved to ${when}`,
      `<h2 style="color:#A855F7;margin:0 0 12px">New time for your detail</h2>
       <p>Your detail is now <b>${esc(when)}</b> at ${esc(b.address)}.</p>
       <p style="color:#A9A4AF">Reply to this email if that doesn't work.</p>`);
  }
  return { ok: true, when };
}

// Cancel a booking and give everything back: the card payment (Stripe refund), then the
// balance, credits and reward it used. A failed refund puts the status back untouched.
export async function declineBooking(db: Db, id: string): Promise<ActionResult> {
  const { data: b } = await db.from('bookings')
    .select('id, status, membership_id, customers(email)').eq('id', id).maybeSingle();
  if (!b) return { ok: false, error: 'not_found' };
  if (!OPEN.includes(b.status)) return { ok: false, error: 'not_open' };

  const { data: won } = await db.from('bookings').update({ status: 'refunded' })
    .eq('id', id).eq('status', b.status).select('id');
  if (!won?.length) return { ok: false, error: 'not_open' };
  const r = await refundBooking(db, id);
  if (!r.ok) {
    await db.from('bookings').update({ status: b.status }).eq('id', id);
    return { ok: false, error: 'refund_failed' };
  }
  const walletBack = await restoreMemberBalances(db, b);
  await sendEmail((b.customers as { email: string } | null)?.email ?? '',
    r.amountCents ? 'Your payment has been refunded' : 'About your detail request',
    `<h2 style="color:#A855F7;margin:0 0 12px">Sorry — we couldn't take this one</h2>
     ${r.amountCents ? `<p>Your $${r.amountCents / 100} payment has been refunded in full. It can take 5–10 days to show on your statement.</p>` : ''}
     ${walletBack ? `<p>The $${walletBack} from your balance is back on your balance.</p>` : ''}
     <p style="color:#A9A4AF">Hope to catch you next time.</p>`);
  return { ok: true, refundedCents: r.amountCents, walletBack };
}

// Job finished. Members earn stamps (cars × their tier's stampsPerCar). Money taken at
// the detail (cash or card on the spot) is recorded so "balance due" is accurate.
export async function markDone(
  db: Db, id: string, collected: { amount: number; method: 'cash' | 'card' } | null,
): Promise<ActionResult> {
  if (collected && (!Number.isInteger(collected.amount) || collected.amount <= 0 || collected.amount > 100000
    || !['cash', 'card'].includes(collected.method))) {
    return { ok: false, error: 'bad_amount' };
  }
  const { data: won } = await db.from('bookings').update({ status: 'done' })
    .eq('id', id).in('status', OPEN).select('id');
  if (!won?.length) return { ok: false, error: 'not_open' };

  if (collected) {
    await db.from('payments').insert({
      booking_id: id, kind: 'remainder', amount_cents: collected.amount * 100, status: 'succeeded',
      provider: collected.method === 'cash' ? 'cash' : 'card_in_person',
    });
  }

  // the job is already marked done: a stamp failure is logged (the owner can add stamps by hand)
  const stamps = await awardStamps(db, id).catch((e) => {
    console.error('stamps after done failed', id, (e as Error)?.message ?? e);
    return 0;
  });
  return { ok: true, stamps };
}

// The stamps a finished job earns: cars x the member's tier stampsPerCar (0 for a non-member
// booking). Read-only; throws on a read error so a payment never goes through without them.
// admin invoice_pay passes this to detail_invoice_pay, which records it in the payment's
// transaction, once per booking.
export async function stampsFor(db: Db, bookingId: string): Promise<number> {
  const { data: b, error } = await db.from('bookings')
    .select('items, detail, membership_id').eq('id', bookingId).maybeSingle();
  if (error) throw error;
  if (!b?.membership_id) return 0;
  const [mem, cat] = await Promise.all([
    db.from('memberships').select('tier').eq('id', b.membership_id).maybeSingle(),
    db.from('catalog').select('config').eq('id', 1).single(),
  ]);
  if (mem.error || cat.error) throw mem.error ?? cat.error;
  if (!mem.data?.tier) return 0;
  const perCar = detailPricingOf(cat.data?.config).membership[mem.data.tier as 'bronze' | 'silver' | 'gold']?.stampsPerCar ?? 1;
  const cars = (b.detail as { cars?: unknown[] } | null)?.cars?.length
    || (Array.isArray(b.items) ? b.items.length : 0) || 1;
  return cars * perCar;
}

// Tell the member the stamps they just earned and their new total.
export async function sendStampEmail(db: Db, bookingId: string, stamps: number): Promise<void> {
  const { data: b } = await db.from('bookings').select('membership_id, customers(email)').eq('id', bookingId).maybeSingle();
  if (!b?.membership_id) return;
  const { data: bal } = await db.from('reward_ledger').select('delta').eq('membership_id', b.membership_id);
  const total = ((bal ?? []) as { delta: number }[]).reduce((s, r) => s + r.delta, 0);
  const c = b.customers as { email: string } | null;
  await sendEmail(c?.email ?? '', `+${stamps} stamp${stamps > 1 ? 's' : ''} earned — you have ${total}`,
    `<h2 style="color:#A855F7;margin:0 0 12px">Stamp${stamps > 1 ? 's' : ''} earned 🎉</h2>
     <p>Wash complete — you earned <b>${stamps} stamp${stamps > 1 ? 's' : ''}</b>. You now have <b>${total}</b>. Open the app to redeem rewards.</p>`);
}

// markDone's path (old app rows): record the stamps, then email. Safe to call twice: a booking
// that already has its 'wash completed' row earns nothing more.
async function awardStamps(db: Db, bookingId: string): Promise<number> {
  const stamps = await stampsFor(db, bookingId);
  if (!stamps) return 0;
  const { data: done } = await db.from('reward_ledger').select('id')
    .eq('booking_id', bookingId).eq('reason', 'wash completed').limit(1);
  if (done?.length) return 0;
  const { data: b } = await db.from('bookings').select('membership_id').eq('id', bookingId).single();
  await db.from('reward_ledger').insert({
    membership_id: b.membership_id, delta: stamps, reason: 'wash completed', booking_id: bookingId,
  });
  await sendStampEmail(db, bookingId, stamps);
  return stamps;
}
