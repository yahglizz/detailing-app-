// Books a detail. No sign-in: a customer with a code (member, or a balance account) is
// identified by it, a guest by the name + email they type. Members get their member
// price; anyone with a balance spends it first. The rest goes through Stripe Checkout —
// this returns the URL of a hosted checkout page for exactly this booking, and the app
// opens it. When the customer comes back (paid, backed out, or closed the sheet) the app
// calls this again with action 'settle' and gets the final answer.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { priceOrder } from '../_shared/pricing.ts';
import { getProvider } from '../_shared/payments/provider.ts';
import { APP_LINK, checkoutLine, cleanItems, formatWhen, splitPayment, type PayMode } from '../_shared/payments/checkout.ts';
import { functionsBaseUrl } from '../_shared/notify.ts';
import { memberPrice, rankOf, type MemberCatalog, type RewardKey, REWARD_LABELS } from '../_shared/membership.ts';
import { clientIp, resolveCode, type Account } from '../_shared/codes.ts';
import { walletBalance } from '../_shared/wallet.ts';
import { decideBump } from '../_shared/bump.ts';
import { declinePending, fulfillBooking, settleBooking } from '../_shared/booking_payment.ts';

interface BookBody {
  items: unknown; // validated by cleanItems
  address: string;
  preferredDay: string; // YYYY-MM-DD
  timeSlot?: string; // 24h "HH:MM"
  window: 'morning' | 'afternoon' | 'either';
  notes: string;
  remainderMethod: 'cash' | 'card';
  name: string;
  email?: string; // guests; with a code, the email on their account is used
  expectedTotal: number;
  memberCode?: string; // a member code or a balance-account code
  anchor?: boolean;
  payMode?: PayMode;
  returnUrl?: string; // the app's deep link; Stripe sends the customer back through checkout-return
}

const MEMBER_WINDOW_DAYS = 30;
const PUBLIC_WINDOW_DAYS = 7;

Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  let raw: Record<string, unknown>;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object') return Response.json({ error: 'bad_json' }, { status: 400 });
  if (raw.action === 'settle') return settle(admin, raw);
  const body = raw as unknown as BookBody;

  const address = String(body.address ?? '').trim();
  const name = String(body.name ?? '').trim().slice(0, 60);
  if (!address || address.length > 200 || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.preferredDay))) {
    return Response.json({ error: 'missing_fields' }, { status: 400 });
  }
  if (body.timeSlot && !/^[0-2][0-9]:[0-5][0-9]$/.test(body.timeSlot)) {
    return Response.json({ error: 'bad_time_slot' }, { status: 400 });
  }

  const { data: cat, error: catErr } = await admin.from('catalog').select('config').eq('id', 1).single();
  if (catErr) return Response.json({ error: 'catalog_unavailable' }, { status: 500 });
  const cfg = cat.config as MemberCatalog;
  const items = cleanItems(body.items, cfg);
  if (!items) return Response.json({ error: 'bad_items' }, { status: 400 });

  // ——— who: a code (member or balance account = identity) or a guest's email ———
  let acct: Account | null = null;
  if (body.memberCode) {
    const r = await resolveCode(admin, body.memberCode, clientIp(req));
    if (r === 'rate_limited') return Response.json({ error: 'rate_limited' }, { status: 429 });
    if (r === 'invalid_code') return Response.json({ error: 'invalid_code' }, { status: 403 });
    acct = r;
  }
  const membership = acct?.membership ?? null; // active members only
  const guestEmail = String(body.email ?? '').trim().toLowerCase();
  if (!acct) {
    if (!name) return Response.json({ error: 'missing_fields' }, { status: 400 });
    if (guestEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) {
      return Response.json({ error: 'bad_email' }, { status: 400 });
    }
  }
  const bookerRank = rankOf(membership?.tier, cfg);

  // ——— booking window: members 30 days out, everyone else 7 ———
  const today = new Date();
  const limit = new Date(today);
  limit.setDate(limit.getDate() + (membership ? MEMBER_WINDOW_DAYS : PUBLIC_WINDOW_DAYS));
  if (body.preferredDay > limit.toISOString().slice(0, 10)) {
    return Response.json({ error: 'too_far_out', maxDays: membership ? MEMBER_WINDOW_DAYS : PUBLIC_WINDOW_DAYS }, { status: 400 });
  }

  // ——— slot: refuse a taken slot now, before any money. Bumps and equal-tier
  // conflicts are acted on once paid (fulfillBooking decides again then). ———
  if (body.timeSlot) {
    const { data: clash } = await admin
      .from('bookings')
      .select('id, rank, anchored')
      .eq('preferred_day', body.preferredDay)
      .eq('time_slot', body.timeSlot)
      .not('status', 'in', '("declined","refunded")')
      .order('anchored', { ascending: false }).order('rank', { ascending: false })
      .limit(1);
    const holder = clash?.[0] ?? null;
    if (decideBump(bookerRank, holder ? { rank: holder.rank, anchored: holder.anchored } : null) === 'blocked') {
      return Response.json({ error: 'slot_taken' }, { status: 409 });
    }
  }

  // ——— price: retail quote, then the member price (credits, issued reward, tier %
  // off), then the anchor; then the prepaid balance, then the card ———
  const quote = priceOrder(items, cfg);
  if (body.expectedTotal !== quote.total) {
    return Response.json({ error: 'price_changed', quote }, { status: 409 });
  }

  let payable = quote.total;
  let creditsUsed = 0;
  let memberDiscount = 0;
  let appliedRedemption: { id: string; reward: RewardKey } | null = null;
  if (membership) {
    const [{ data: creditRows }, { data: issued }] = await Promise.all([
      admin.from('credit_ledger').select('delta').eq('membership_id', membership.id),
      // Oldest first — the same one the app shows (member profile issuedRewards[0]).
      admin.from('redemptions').select('id, reward').eq('membership_id', membership.id).eq('status', 'issued')
        .order('created_at').limit(1),
    ]);
    const credits = (creditRows ?? []).reduce((s, r) => s + r.delta, 0);
    const reward = (issued?.[0] ?? null) as { id: string; reward: RewardKey } | null;
    const priced = memberPrice(quote, cfg.plans[membership.tier], credits, reward?.reward ?? null);
    payable = priced.payable;
    creditsUsed = priced.creditsUsed;
    memberDiscount = priced.memberDiscount;
    if (priced.rewardUsed) appliedRedemption = reward;
  }
  const anchored = !membership && body.anchor === true;
  if (anchored) payable += cfg.anchorPrice;

  const payMode: PayMode = body.payMode === 'full' ? 'full' : 'deposit';
  const wallet = acct ? await walletBalance(admin, acct.customerId) : 0;
  const { walletUsed, rest, deposit, due, atDetail } = splitPayment(payable, wallet, quote.depositPercent, payMode);
  const returnUrl = String(body.returnUrl ?? '');
  const pay = due > 0 ? await getProvider(admin) : null;
  if (due > 0) {
    if (!pay) return Response.json({ error: 'payments_not_configured' }, { status: 503 });
    if (returnUrl.length > 300 || !APP_LINK.test(returnUrl)) return Response.json({ error: 'bad_return_url' }, { status: 400 });
  }

  // ——— the customer row this booking hangs off ———
  // A code already points at one (keyed by their unique email); only the name is
  // refreshed. Guests reuse the row for a known email — a returning guest, or a
  // member booking without their code — and otherwise get a new one.
  let customerId: string;
  let customerEmail: string;
  if (acct) {
    customerId = acct.customerId;
    if (name) await admin.from('customers').update({ name }).eq('id', customerId);
    const { data: c } = await admin.from('customers').select('email').eq('id', customerId).single();
    customerEmail = c?.email ?? '';
  } else {
    await admin.from('customers')
      .upsert({ id: crypto.randomUUID(), email: guestEmail, name }, { onConflict: 'email', ignoreDuplicates: true });
    const { data: c } = await admin.from('customers').select('id').eq('email', guestEmail).single();
    if (!c) return Response.json({ error: 'booking_insert_failed' }, { status: 500 });
    customerId = c.id;
    customerEmail = guestEmail;
  }

  const confirmToken = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const fullQuote = {
    ...quote, payable, deposit, remainder: rest - deposit, creditsUsed, anchored,
    payMode, paidOnline: due, balanceDue: atDetail, walletUsed, memberDiscount,
    savings: membership ? quote.total - payable : 0,
    tier: membership?.tier ?? null, reward: appliedRedemption?.reward ?? null,
    ...(acct?.isTest ? { test: true } : {}),
  };
  const { data: booking, error: insErr } = await admin
    .from('bookings')
    .insert({
      customer_id: customerId,
      items,
      quote: fullQuote,
      address,
      preferred_day: body.preferredDay,
      time_slot: body.timeSlot ?? null,
      time_window: body.window,
      notes: String(body.notes ?? '').slice(0, 500),
      remainder_method: body.remainderMethod,
      status: 'pending_payment',
      confirm_token: confirmToken,
      membership_id: membership?.id ?? null,
      anchored,
      rank: bookerRank,
      paid_with_credit: creditsUsed > 0,
      pay_mode: payMode,
    })
    .select('id')
    .single();
  if (insErr) return Response.json({ error: 'booking_insert_failed' }, { status: 500 });

  // ——— reserve the member's credits and reward, and the balance, BEFORE any money moves ———
  // All are scarce: a concurrent booking may have just spent them. Reserving first
  // means a conflict costs nothing (no charge to refund); a checkout the customer walks
  // away from hands them back (declinePending).
  if (membership && creditsUsed > 0) {
    // The credit_ledger non-negative trigger surfaces over-spend as an error.
    const { error: debitErr } = await admin.from('credit_ledger').insert({
      membership_id: membership.id, delta: -creditsUsed, reason: 'wash', booking_id: booking.id,
    });
    if (debitErr) {
      await declinePending(admin, booking.id);
      return Response.json({ error: 'credit_conflict' }, { status: 409 });
    }
  }
  if (appliedRedemption) {
    // Conditional flip: only claim the reward if it is still 'issued', so a single
    // reward can never discount two washes.
    const { data: flipped } = await admin.from('redemptions')
      .update({ status: 'applied', booking_id: booking.id })
      .eq('id', appliedRedemption.id).eq('status', 'issued')
      .select('id');
    if (!flipped || flipped.length === 0) {
      await declinePending(admin, booking.id); // hands the reserved credit back
      return Response.json({ error: 'reward_conflict' }, { status: 409 });
    }
  }
  if (walletUsed > 0) {
    // The wallet_ledger trigger refuses to go below zero (a concurrent spend won).
    const { error: walletErr } = await admin.from('wallet_ledger').insert({
      customer_id: customerId, delta: -walletUsed, reason: 'booking', booking_id: booking.id, ref: `book:${booking.id}`,
    });
    if (walletErr) {
      await declinePending(admin, booking.id);
      return Response.json({ error: 'balance_conflict' }, { status: 409 });
    }
  }

  // Nothing to pay now (credit or balance covers it, or it's all due at the detail):
  // booked right now.
  if (due === 0) {
    await fulfillBooking(admin, booking.id, null);
    const { data: done } = await admin.from('bookings').select('time_slot').eq('id', booking.id).single();
    return Response.json({
      bookingId: booking.id, paid: true, escalated: !!body.timeSlot && !done?.time_slot, quote: fullQuote, payable, creditsUsed, walletUsed,
    });
  }

  const perks = [
    creditsUsed ? `${creditsUsed} member credit${creditsUsed > 1 ? 's' : ''} applied` : '',
    appliedRedemption ? REWARD_LABELS[appliedRedemption.reward] : '',
    memberDiscount ? `${membership!.tier.toUpperCase()} member price −$${memberDiscount}` : '',
    walletUsed ? `$${walletUsed} from your balance` : '',
    anchored ? 'Slot Anchor' : '',
  ].filter(Boolean);
  const line = checkoutLine({
    items, mode: payMode, balance: atDetail, perks, address,
    when: formatWhen(body.preferredDay, body.timeSlot, body.window),
  });
  const session = await pay!.createCheckout({
    kind: 'booking', ref: booking.id, amountCents: due * 100, email: customerEmail, ...line,
    returnUrl: `${functionsBaseUrl()}/checkout-return?to=${encodeURIComponent(returnUrl)}`,
  });
  if (!session.ok) {
    await declinePending(admin, booking.id);
    return Response.json({ error: 'payments_unavailable' }, { status: 502 });
  }
  const { error: linkErr } = await admin.from('bookings').update({ stripe_session_id: session.id }).eq('id', booking.id);
  if (linkErr) {
    await pay!.expireCheckout(session.id);
    await declinePending(admin, booking.id);
    return Response.json({ error: 'booking_insert_failed' }, { status: 500 });
  }
  return Response.json({ bookingId: booking.id, checkoutUrl: session.url, sessionId: session.id, quote: fullQuote, payable, creditsUsed, walletUsed });
});

// The customer is back from Stripe Checkout. The session id is the proof: only the
// app that opened this checkout has it.
// deno-lint-ignore no-explicit-any
async function settle(admin: any, raw: Record<string, unknown>): Promise<Response> {
  const sessionId = String(raw.sessionId ?? '');
  const { data: b } = await admin.from('bookings')
    .select('id, status, stripe_session_id, pay_mode')
    .eq('id', String(raw.bookingId ?? '')).maybeSingle();
  if (!b || !sessionId || b.stripe_session_id !== sessionId) return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const status = await settleBooking(admin, await getProvider(admin), b);
    const { data: after } = await admin.from('bookings').select('time_slot').eq('id', b.id).single();
    return Response.json({ status, escalated: status === 'paid' && !after?.time_slot });
  } catch (e) {
    console.error('settle failed', b.id, (e as Error).message);
    return Response.json({ error: 'payments_unavailable' }, { status: 502 });
  }
}
