import { createClient } from 'npm:@supabase/supabase-js@2';
import { priceOrder, type CarItem, type CatalogConfig } from '../_shared/pricing.ts';
import { getProvider } from '../_shared/payments/provider.ts';
import type { CardDetails } from '../_shared/payments/types.ts';
import { sendEmail, ownerEmail, functionsBaseUrl, button } from '../_shared/notify.ts';
import { applyCredits, applyReward, rankOf, type MemberCatalog, type RewardKey, REWARD_LABELS } from '../_shared/membership.ts';
import { decideBump, nextOpenSlot } from '../_shared/bump.ts';

interface BookBody {
  items: CarItem[];
  address: string;
  preferredDay: string; // YYYY-MM-DD
  timeSlot?: string; // 24h "HH:MM"
  window: 'morning' | 'afternoon' | 'either';
  notes: string;
  remainderMethod: 'cash' | 'card';
  name: string;
  expectedTotal: number;
  card?: CardDetails;
  memberCode?: string;
  anchor?: boolean;
}

const MEMBER_WINDOW_DAYS = 30;
const PUBLIC_WINDOW_DAYS = 7;

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user || !user.email) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let body: BookBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  if (!body.address?.trim() || !body.preferredDay) return Response.json({ error: 'missing_fields' }, { status: 400 });
  if (body.timeSlot && !/^[0-2][0-9]:[0-5][0-9]$/.test(body.timeSlot)) {
    return Response.json({ error: 'bad_time_slot' }, { status: 400 });
  }

  const { data: cat, error: catErr } = await admin.from('catalog').select('config').eq('id', 1).single();
  if (catErr) return Response.json({ error: 'catalog_unavailable' }, { status: 500 });
  const cfg = cat.config as MemberCatalog;

  // ——— membership lookup (code = identity) ———
  let membership: { id: string; tier: string; customer_id: string } | null = null;
  if (body.memberCode) {
    const { data: m } = await admin.from('memberships')
      .select('id, tier, active, customer_id')
      .eq('code', body.memberCode.trim().toUpperCase())
      .single();
    if (!m || !m.active) return Response.json({ error: 'invalid_code' }, { status: 403 });
    membership = m;
  }
  const bookerRank = rankOf(membership?.tier as 'bronze' | 'silver' | 'gold' | undefined, cfg);

  // ——— booking window: members 30 days out, everyone else 7 ———
  const today = new Date();
  const limit = new Date(today);
  limit.setDate(limit.getDate() + (membership ? MEMBER_WINDOW_DAYS : PUBLIC_WINDOW_DAYS));
  if (body.preferredDay > limit.toISOString().slice(0, 10)) {
    return Response.json({ error: 'too_far_out', maxDays: membership ? MEMBER_WINDOW_DAYS : PUBLIC_WINDOW_DAYS }, { status: 400 });
  }

  // ——— slot decision: open / bump / blocked / escalate ———
  let bumped = false;
  let escalated = false;
  let holderBooking: { id: string; rank: number; anchored: boolean; customer_id: string } | null = null;
  if (body.timeSlot) {
    const { data: clash } = await admin
      .from('bookings')
      .select('id, rank, anchored, customer_id')
      .eq('preferred_day', body.preferredDay)
      .eq('time_slot', body.timeSlot)
      .not('status', 'in', '("declined","refunded")')
      .limit(1);
    holderBooking = clash?.[0] ?? null;
    const decision = decideBump(bookerRank, holderBooking ? { rank: holderBooking.rank, anchored: holderBooking.anchored } : null);
    if (decision === 'blocked') return Response.json({ error: 'slot_taken' }, { status: 409 });
    if (decision === 'escalate') escalated = true;
    if (decision === 'bump') bumped = true;
  }

  // ——— price: retail quote, then credits, then issued reward, then anchor ———
  let quote;
  try {
    quote = priceOrder(body.items, cfg as CatalogConfig);
  } catch (e) {
    return Response.json({ error: String((e as Error).message) }, { status: 400 });
  }
  if (body.expectedTotal !== quote.total) {
    return Response.json({ error: 'price_changed', quote }, { status: 409 });
  }

  let payable = quote.total;
  let creditsUsed = 0;
  let appliedRedemption: { id: string; reward: RewardKey } | null = null;
  if (membership) {
    const plan = cfg.plans[membership.tier as keyof typeof cfg.plans];
    const { data: creditRows } = await admin.from('credit_ledger').select('delta').eq('membership_id', membership.id);
    const balance = (creditRows ?? []).reduce((s, r) => s + r.delta, 0);
    const applied = applyCredits(quote, plan, balance);
    payable = applied.payable;
    creditsUsed = applied.creditsUsed;

    const { data: issued } = await admin.from('redemptions')
      .select('id, reward').eq('membership_id', membership.id).eq('status', 'issued')
      .order('created_at').limit(1);
    if (issued?.[0]) {
      appliedRedemption = issued[0] as { id: string; reward: RewardKey };
      payable = applyReward(payable, appliedRedemption.reward, quote);
    }
  }
  const anchored = !membership && body.anchor === true;
  if (anchored) payable += cfg.anchorPrice;

  const depositPercent = quote.depositPercent;
  const deposit = payable === 0 ? 0 : Math.round((payable * depositPercent) / 100);
  if (deposit > 0 && !body.card) return Response.json({ error: 'card_required' }, { status: 400 });

  await admin.from('customers').upsert({ id: user.id, email: user.email, name: body.name ?? '' });

  const confirmToken = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const fullQuote = { ...quote, payable, deposit, remainder: payable - deposit, creditsUsed, anchored };
  const { data: booking, error: insErr } = await admin
    .from('bookings')
    .insert({
      customer_id: user.id,
      items: body.items,
      quote: fullQuote,
      address: body.address.trim(),
      preferred_day: body.preferredDay,
      time_slot: escalated ? null : body.timeSlot ?? null,
      time_window: body.window,
      notes: body.notes ?? '',
      remainder_method: body.remainderMethod,
      status: 'pending_payment',
      confirm_token: confirmToken,
      membership_id: membership?.id ?? null,
      anchored,
      rank: bookerRank,
      paid_with_credit: creditsUsed > 0,
    })
    .select()
    .single();
  if (insErr) return Response.json({ error: 'booking_insert_failed' }, { status: 500 });

  if (deposit > 0) {
    const charge = await getProvider().chargeDeposit({
      bookingId: booking.id,
      amountCents: deposit * 100,
      card: body.card!,
    });
    if (!charge.ok) return Response.json({ error: charge.error }, { status: 402 });
    await admin.from('payments').insert({
      booking_id: booking.id, kind: 'deposit', amount_cents: deposit * 100,
      status: 'succeeded', provider: 'fake', provider_ref: charge.ref,
    });
  }

  // ——— commit side effects AFTER money: credits, redemption, bump ———
  if (membership && creditsUsed > 0) {
    await admin.from('credit_ledger').insert({
      membership_id: membership.id, delta: -creditsUsed, reason: 'wash', booking_id: booking.id,
    });
  }
  if (appliedRedemption) {
    await admin.from('redemptions').update({ status: 'applied', booking_id: booking.id }).eq('id', appliedRedemption.id);
  }

  if (bumped && holderBooking) {
    const { data: takenRows } = await admin.rpc('slot_states', { day: body.preferredDay });
    const taken = ((takenRows ?? []) as { slot: string }[]).map((r) => r.slot);
    const target = nextOpenSlot([...taken, body.timeSlot!], body.timeSlot!);
    if (target) {
      await admin.from('bookings')
        .update({ time_slot: target, bumped_from: body.timeSlot, time_window: Number(target.slice(0, 2)) < 12 ? 'morning' : 'afternoon' })
        .eq('id', holderBooking.id);
      const { data: holderCust } = await admin.from('customers').select('email').eq('id', holderBooking.customer_id).single();
      if (holderCust?.email) {
        await sendEmail(holderCust.email, `Your detail moved to ${target} — here's why`,
          `<h2 style="color:#A855F7;margin:0 0 12px">Small schedule change</h2>
           <p>A VIP member reserved your original window, so your detail on <b>${body.preferredDay}</b> moved from ${body.timeSlot} to <b>${target}</b>.</p>
           <p style="color:#A9A4AF">Members never get bumped — ask us about membership, or add a $${cfg.anchorPrice} Slot Anchor next time to lock your time.</p>`);
      }
    } else {
      // Nowhere to move the holder — do not double-book. Escalate instead.
      escalated = true;
      await admin.from('bookings').update({ time_slot: null }).eq('id', booking.id);
      await sendEmail(ownerEmail(), `Slot conflict needs you — ${body.preferredDay} ${body.timeSlot}`,
        `<h2 style="color:#A855F7;margin:0 0 12px">No room to bump</h2>
         <p>A rank-${bookerRank} member booked ${body.preferredDay} ${body.timeSlot}, but the day is full so nobody can be moved automatically. Set the exact time on the confirm page.</p>
         ${button(`${functionsBaseUrl()}/confirm?token=${confirmToken}`, 'Resolve →')}`);
    }
  }
  if (escalated && !bumped) {
    await sendEmail(ownerEmail(), `Two members want ${body.preferredDay} ${body.timeSlot} — pick one`,
      `<h2 style="color:#A855F7;margin:0 0 12px">Equal-rank conflict</h2>
       <p>Two members of the same tier want <b>${body.preferredDay} ${body.timeSlot}</b>. The newer booking has no time yet — set its exact time on the confirm page.</p>
       ${button(`${functionsBaseUrl()}/confirm?token=${confirmToken}`, 'Resolve →')}`);
  }

  await admin.from('bookings').update({ status: 'requested' }).eq('id', booking.id);

  const summary = body.items
    .map((i, n) => `<div>Car ${n + 1}: <b>${i.service}</b> / ${i.size}${i.extras.length ? ' + ' + i.extras.join(', ') : ''}</div>`)
    .join('');
  const link = `${functionsBaseUrl()}/confirm?token=${confirmToken}`;
  const shortSummary = body.items.map((i) => `${i.service}/${i.size}`).join(', ');
  const memberTag = membership ? ` — MEMBER ${membership.tier.toUpperCase()}${creditsUsed ? ` (${creditsUsed} credit)` : ''}` : '';
  const rewardTag = appliedRedemption ? `<p style="color:#F5B942">Reward attached: ${REWARD_LABELS[appliedRedemption.reward]}</p>` : '';

  await sendEmail(
    ownerEmail(),
    `New detail — ${shortSummary}${memberTag} — $${deposit} deposit${deposit ? ' PAID' : ' (credit)'}`,
    `<h2 style="color:#A855F7;margin:0 0 12px">New Detail Request${memberTag}</h2>
     ${summary}${rewardTag}
     <p style="color:#A9A4AF">${body.preferredDay} · ${escalated ? 'TIME CONFLICT — resolve' : body.timeSlot ?? body.window} · ${body.address}</p>
     <p style="color:#A9A4AF">Notes: ${body.notes || '—'}</p>
     <p>Retail $${quote.total} · Payable $${payable} · Deposit $${deposit} · $${payable - deposit} due (${body.remainderMethod})${anchored ? ' · ANCHORED' : ''}</p>
     ${button(link, 'Confirm or decline →')}`,
  );

  await sendEmail(
    user.email,
    membership && payable === 0
      ? 'Your member wash is booked'
      : `We got your detail request — $${deposit} deposit received`,
    `<h2 style="color:#A855F7;margin:0 0 12px">Thanks${body.name ? ', ' + body.name : ''}!</h2>
     ${summary}${rewardTag}
     <p style="color:#A9A4AF">${body.preferredDay} · ${escalated ? "we'll confirm your exact time shortly" : body.timeSlot ?? body.window} · ${body.address}</p>
     ${creditsUsed ? `<p>Paid with ${creditsUsed} membership credit${creditsUsed > 1 ? 's' : ''}.</p>` : ''}
     ${deposit ? `<p>Deposit paid: $${deposit}. Due at the detail: $${payable - deposit} (${body.remainderMethod}).</p>` : ''}
     ${anchored ? `<p>Slot Anchor active — your time is locked. 🔒</p>` : ''}
     <p style="color:#A9A4AF">We'll email you shortly to lock in your exact time.</p>`,
  );

  return Response.json({ bookingId: booking.id, quote: fullQuote, payable, creditsUsed, bumped, escalated });
});
