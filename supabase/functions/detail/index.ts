// Public booking API for the website and the app (flow = 'detail_v2'). 1–6 cars per booking.
// POST { action, ... }:
//   config                                  -> { pricing, membership, slots, today }
//   quote { cars: [{service, vehicleType}], memberCode? }
//                                           -> { lines, subtotal, deposit, member? }
//   quote { service, vehicleType }          -> { startingPrice, deposit, balance }   (old single-car shape)
//   availability { from?, to? }             -> { days, slots, today, windowDays }
//   availability { day }                    -> same, plus { taken: ["10:00", ...], holders: {"10:00": rank}, minSlot }
//   reserve { ...request }                  -> { bookingId, payKey, quote, uploads, escalated, paidFromBalance }
//   pay-demo { bookingId, payKey }          -> { ok, demo: true }
//   release { bookingId, payKey }           -> { ok }   (frees an unpaid hold)
//
// Every number is computed here from catalog.config.detailPricing; anything price-shaped in a
// request body is ignored (expectedTotal is only compared). A member code (app only) gives the
// member's price, VIP rank and the prepaid balance; without one nobody can spend a balance.
// Payments are demo-only: pay-demo works only while app_config.payments_mode is exactly 'demo'
// and records deposit_status 'demo', never 'paid'. A balance-paid deposit is real money and is
// taken inside detail_reserve (migration 0017) together with the insert and any VIP bump.
// Deployed with verify_jwt=false (browsers preflight without a JWT), like `admin`.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { ALL_SLOTS } from '../_shared/bump.ts';
import { validateReserve } from '../_shared/detail_booking.ts';
import {
  billingMonthStart, DEFAULT_DETAIL_PRICING, easternMidnight, isService, isVehicle, MAX_CARS, memberQuote, membershipView, quoteCars,
  quoteDetail, SERVICES, validateDetailPricing,
  type CarLine, type DetailPricing, type DetailService, type MemberCtx, type RewardKey,
} from '../_shared/detail_pricing.ts';
import { clientIp, resolveCode, type Account } from '../_shared/codes.ts';
import { walletBalance } from '../_shared/wallet.ts';
import { adminLink, button, esc, ownerEmail, sendEmail } from '../_shared/notify.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const CORS = {
  'Access-Control-Allow-Origin': '*', // no cookies; the payKey is the capability
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const bad = (error: string, status = 400) => json({ error }, status);

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUCKET = 'booking-photos';
const REWARDS: RewardKey[] = ['tireShine', 'miniSpray', 'percent25', 'freeWash'];
// Bookings that hold a visit (declined/refunded give it back, so an abandoned hold frees it).
const LIVE = ['pending_payment', 'requested', 'confirmed', 'done'];
// Abuse caps (5 per email, 10 per IP per hour, every status) live in the bookings insert
// trigger in migration 0015, where they are atomic. ponytail: no captcha / email verification yet.
// Keyed hash of the caller's IP, so stored values can't be brute-forced back to addresses.
const ipHashOf = async (ip: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// The business runs on Eastern time; "today" is its day, not UTC's.
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const money = (n: number) => `$${n}`;
// Earliest start time bookable today: the next whole hour at least LEAD_HOURS away (Eastern).
// '24:00' means nothing is left today. Any other day: '00:00'.
const LEAD_HOURS = 2;
function minSlotFor(day: string): string {
  if (day !== todayISO()) return '00:00';
  const h = Number(new Date().toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).slice(0, 2));
  const next = h + LEAD_HOURS + 1;
  return next > 17 ? '24:00' : `${String(Math.max(next, 9)).padStart(2, '0')}:00`;
}

async function pricing(): Promise<DetailPricing> {
  const { data, error } = await db.from('catalog').select('config').eq('id', 1).single();
  if (error) throw error;
  const v = validateDetailPricing(data.config?.detailPricing);
  if (v.ok) return v.value;
  console.error('detailPricing in catalog is invalid, using defaults:', v.error);
  return DEFAULT_DETAIL_PRICING;
}

// A code in the body -> the account, an error response, or null (no code = guest).
async function account(code: unknown, req: Request): Promise<Account | Response | null> {
  if (typeof code !== 'string' || !code.trim()) return null;
  const a = await resolveCode(db, code, clientIp(req));
  if (a === 'rate_limited') return bad('rate_limited', 429);
  if (a === 'invalid_code') return bad('invalid_code', 404);
  return a;
}

// An active member's pricing context: plan vehicle size, visits left this billing month (plan
// visits minus the visits recorded on this membership's live bookings since the anniversary),
// and the oldest issued reward. Fails closed: a read error throws instead of granting visits.
// This count prices the quote; detail_reserve recounts under a per-member lock at insert, so two
// bookings at once can't both spend the last visit (the loser gets price_changed + a new quote).
type Member = {
  ctx: MemberCtx; membershipId: string; rank: number; rewardId: string | null;
  periodStart: string; visitCap: Partial<Record<DetailService, number>>;
};
async function memberOf(acct: Account, cfg: DetailPricing): Promise<Member | null> {
  const m = acct.membership;
  if (!m) return null; // a balance-only account: guest prices, rank 0
  // the billing month starts at 00:00 Eastern on the anniversary day
  const periodStart = easternMidnight(billingMonthStart(String(m.period_start), todayISO()));
  const [own, used, rew] = await Promise.all([
    db.from('memberships').select('vehicle_type').eq('id', m.id).single(),
    db.from('bookings').select('quote').eq('membership_id', m.id).in('status', LIVE)
      .gte('created_at', periodStart),
    db.from('redemptions').select('id, reward').eq('membership_id', m.id).eq('status', 'issued')
      .order('created_at').limit(1),
  ]);
  if (own.error || used.error || rew.error) throw new Error('member lookup failed');
  const plan = cfg.membership[m.tier];
  const visitsLeft: Partial<Record<DetailService, number>> = {};
  for (const s of SERVICES) {
    if (!plan.visits[s]) continue;
    const n = ((used.data ?? []) as Obj[]).reduce((t, b) => {
      const u = b.quote?.visitsUsed;
      return t + (u && typeof u === 'object' && Number.isInteger(u[s]) ? u[s] : 0);
    }, 0);
    visitsLeft[s] = Math.max(0, (plan.visits[s] as number) - n);
  }
  const r = rew.data?.[0] as { id: string; reward: string } | undefined;
  const reward = r && (REWARDS as string[]).includes(r.reward) ? r.reward as RewardKey : null;
  return {
    ctx: { tier: m.tier, planVehicle: isVehicle(own.data?.vehicle_type) ? own.data.vehicle_type : 'sedan', visitsLeft, reward },
    membershipId: m.id, rank: plan.rank, rewardId: reward ? r!.id : null, periodStart, visitCap: plan.visits,
  };
}

// The quote stored on the booking (and returned by reserve). detail_invoice_pay reads lines
// (covered/credit), memberPercent and rewardPercent from it to build the job invoice.
// `balance` is for the website build that is live before the multi-car one ships.
function bookingQuote(cfg: DetailPricing, cars: CarLine[], mem: Member | null) {
  const shape = (o: {
    lines: unknown[]; subtotal: number; payable: number; deposit: number; memberPercent: number; rewardPercent: number;
    visitsUsed: Obj; rewardId: string | null; tier: string | null;
  }) => ({
    lines: o.lines, subtotal: o.subtotal, total: o.payable, payable: o.payable, deposit: o.deposit,
    memberPercent: o.memberPercent, rewardPercent: o.rewardPercent, visitsUsed: o.visitsUsed, rewardId: o.rewardId,
    startingPrice: o.subtotal, remainder: o.payable, balanceDue: o.payable, // nothing is paid until the deposit step
    balance: o.payable - o.deposit, paidOnline: 0, // `balance` = estimated after deposit (website display)
    tier: o.tier,
  });
  if (!mem) {
    const q = quoteCars(cfg, cars);
    return shape({ ...q, payable: q.subtotal, memberPercent: 0, rewardPercent: 0, visitsUsed: {}, rewardId: null, tier: null });
  }
  const mq = memberQuote(cfg, cars, mem.ctx);
  return shape({ ...mq, rewardId: mq.rewardUsed ? mem.rewardId : null, tier: mem.ctx.tier });
}

// Database errors from detail_reserve and the capacity trigger -> HTTP.
const RESERVE_ERRORS: [string, string, number][] = [
  ['slot_taken', 'slot_taken', 409], ['insufficient_balance', 'balance_changed', 409],
  ['day_full', 'day_full', 409], ['day_closed', 'day_closed', 409], ['too_many', 'too_many', 429],
];

const loadRow = async (id: string) => (await db.from('bookings')
  .select('id, status, deposit_status, membership_id, preferred_day, time_slot, quote, address, detail, customers(email, name)')
  .eq('id', id).eq('flow', 'detail_v2').maybeSingle()).data as Obj | null;

const handlers: Record<string, (b: Obj, req: Request) => Promise<Response>> = {
  config: async () => {
    const p = await pricing();
    return json({ pricing: p, membership: membershipView(p), slots: ALL_SLOTS, today: todayISO() });
  },

  quote: async (b, req) => {
    const cfg = await pricing();
    if (b.cars === undefined) { // old single-car shape
      if (!isService(b.service)) return bad('bad_service');
      if (!isVehicle(b.vehicleType)) return bad('bad_vehicle_type');
      return json(quoteDetail(cfg, b.service, b.vehicleType));
    }
    if (!Array.isArray(b.cars) || b.cars.length < 1 || b.cars.length > MAX_CARS) return bad('bad_cars');
    const cars: CarLine[] = [];
    for (const c of b.cars) {
      if (!isService(c?.service)) return bad('bad_service');
      if (!isVehicle(c?.vehicleType)) return bad('bad_vehicle_type');
      cars.push({ service: c.service, vehicleType: c.vehicleType });
    }
    const out: Obj = quoteCars(cfg, cars);
    const acct = await account(b.memberCode, req);
    if (acct instanceof Response) return acct;
    const mem = acct && await memberOf(acct, cfg);
    if (mem) {
      out.member = {
        ...memberQuote(cfg, cars, mem.ctx),
        tier: mem.ctx.tier, planVehicle: mem.ctx.planVehicle, visitsLeft: mem.ctx.visitsLeft, reward: mem.ctx.reward,
      };
    }
    return json(out);
  },

  availability: async (b) => {
    const cfg = await pricing();
    const today = todayISO();
    const last = addDays(today, cfg.bookingWindowDays);
    const isoOk = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const from = isoOk(b.from) && b.from > today ? b.from : today;
    const to = isoOk(b.to) && b.to < last ? b.to : last;
    const { data: days, error } = await db.rpc('day_states', { from_day: from, to_day: to < from ? from : to });
    if (error) throw error;
    const noneToday = minSlotFor(today) === '24:00';
    const out: Obj = {
      days: (days as Obj[]).map((x) => (x.day === today && noneToday ? { ...x, closed: true } : x)),
      slots: ALL_SLOTS, today, windowDays: cfg.bookingWindowDays,
    };
    if (b.day !== undefined) {
      if (!isoOk(b.day) || b.day < today || b.day > last) return bad('bad_day');
      const [taken, held] = await Promise.all([
        db.rpc('booked_slots', { day: b.day }),
        db.from('bookings').select('time_slot, rank, anchored, status')
          .eq('preferred_day', b.day).not('time_slot', 'is', null).not('status', 'in', '(declined,refunded)'),
      ]);
      if (taken.error) throw taken.error;
      if (held.error) throw held.error;
      out.taken = taken.data ?? [];
      // slot -> holder's VIP rank, only for slots a member could bump: every holder there is
      // unanchored and still pending_payment|requested.
      const holders: Record<string, number> = {};
      const locked = new Set<string>();
      for (const h of (held.data ?? []) as { time_slot: string; rank: number | null; anchored: boolean; status: string }[]) {
        if (h.anchored || !['pending_payment', 'requested'].includes(h.status)) locked.add(h.time_slot);
        holders[h.time_slot] = Math.max(holders[h.time_slot] ?? 0, h.rank ?? 0);
      }
      for (const s of locked) delete holders[s];
      out.holders = holders;
      out.minSlot = minSlotFor(b.day);
    }
    return json(out);
  },

  reserve: async (b, req) => {
    const cfg = await pricing();
    const today = todayISO();
    const v = validateReserve(b, cfg, today, { minSlot: minSlotFor(today) });
    if (!v.ok) return bad(v.error);
    const r = v.value;

    // A code makes this the code holder's booking (their customer row, balance, member price).
    // The email typed is then ignored; name and phone stay on the booking.
    const acct = await account(r.memberCode, req);
    if (acct instanceof Response) return acct;
    const mem = acct && await memberOf(acct, cfg);
    const cars: CarLine[] = r.cars.map((c) => ({ service: c.service, vehicleType: c.vehicleType }));
    const quote = bookingQuote(cfg, cars, mem); // server price, never the client's
    if (r.expectedTotal !== null && r.expectedTotal !== quote.payable) return json({ error: 'price_changed', quote }, 409);

    // Only Cloudflare's header is trusted for the IP hash (the platform overwrites it); without
    // it the per-IP cap is skipped and the per-email cap still applies.
    const cfIp = req.headers.get('cf-connecting-ip');
    const ipHash = cfIp ? await ipHashOf(cfIp) : null;

    let customerId: string;
    if (acct) {
      customerId = acct.customerId;
    } else {
      // customer row keyed by email, same as `book`. An existing row is never renamed: anyone
      // can type any email here, so the name they give lives on this booking (detail.name) only.
      await db.from('customers').upsert({ id: crypto.randomUUID(), email: r.email, name: r.name }, { onConflict: 'email', ignoreDuplicates: true });
      const { data: cust } = await db.from('customers').select('id').eq('email', r.email).single();
      if (!cust) return bad('server_error', 500);
      customerId = cust.id;
    }

    // Balance only with a code (a guest's email proves nothing). Short balance = the normal
    // demo-deposit step; a balance spent in the meantime is caught in detail_reserve.
    const debit = acct && r.useBalance && quote.deposit > 0 && await walletBalance(db, customerId) >= quote.deposit
      ? quote.deposit : 0;

    const bookingId = crypto.randomUUID();
    const payKey = crypto.randomUUID().replaceAll('-', '');
    const photos = r.photoExts.map((ext) => `${bookingId}/${crypto.randomUUID()}.${ext === 'jpeg' ? 'jpg' : ext}`);
    const first = r.cars[0];
    const row = {
      id: bookingId,
      customer_id: customerId,
      flow: 'detail_v2',
      anchored: false, // VIP bumping may move it until the owner confirms the time
      status: 'pending_payment',
      deposit_status: 'pending',
      items: r.cars.map((c) => ({ service: c.service, vehicle: c.vehicleType })),
      quote,
      address: `${r.street}, ${r.zip}`,
      preferred_day: r.day,
      time_slot: r.slot,
      time_window: r.slot < '12:00' ? 'morning' : 'afternoon',
      notes: r.notes,
      remainder_method: 'cash', // placeholder; invoice_pay records the real method
      confirm_token: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
      membership_id: mem?.membershipId ?? null,
      rank: mem?.rank ?? 0,
      detail: {
        payKey, ipHash, name: r.name, phone: r.phone, cars: r.cars, zip: r.zip, notes: r.notes, photos,
        ...(acct?.isTest ? { test: true } : {}),
        // Booked with a member/account code: the only bookings whose balance may pay at the job
        // (a guest can type anyone's email, so the customer row alone proves nothing).
        ...(acct ? { viaCode: true } : {}),
        // first car in the old single-car fields, for dashboard code that predates cars[]
        vehicle: { year: first.year, make: first.make }, vehicleType: first.vehicleType, service: first.service,
        condition: first.condition, petHair: first.petHair,
      },
    };

    const { data: res, error: rpcErr } = await db.rpc('detail_reserve', {
      p_row: row, p_rank: row.rank, p_wallet_debit: debit,
      p_visit_cap: mem ? mem.visitCap : null, p_period_start: mem ? mem.periodStart : null,
    });
    if (rpcErr) {
      const msg = rpcErr.message ?? '';
      // another booking used the included visits this price counted on, or the reward it used
      // was spent elsewhere (balance path): send the new price
      if (msg.includes('price_changed')) {
        return json({ error: 'price_changed', quote: bookingQuote(cfg, cars, acct && await memberOf(acct, cfg)) }, 409);
      }
      // the advisory lock should make the unique slot index unreachable; belt and braces
      if (rpcErr.code === '23505') return bad('slot_taken', 409);
      const hit = RESERVE_ERRORS.find(([k]) => msg.includes(k));
      if (hit) return bad(hit[1], hit[2]);
      console.error('detail reserve failed', msg);
      return bad('booking_insert_failed', 500);
    }

    // The deposit step is done: tell the owner now, and anyone a VIP bump moved. Otherwise the
    // moved customer hears at pay-demo; an abandoned hold undoes the bump (release, sweep).
    const paidFromBalance = debit > 0;
    if (paidFromBalance) {
      if (res?.bumpedId) await notifyBumped(String(res.bumpedId), r.name);
      const saved = await loadRow(bookingId);
      if (saved) await notify(saved, cfg);
    }

    // Same order and length as the request's photoExts (null where signing failed), so the
    // client pairs each file with its own URL.
    const uploads = await Promise.all(photos.map(async (path) => {
      const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
      return !error && data ? { path, signedUrl: data.signedUrl } : null;
    }));
    return json({ bookingId, payKey, quote, uploads, escalated: !!res?.escalated, paidFromBalance });
  },

  // The customer closed the dialog on the deposit step: free their held time right away.
  release: async (b) => {
    if (!UUID.test(String(b.bookingId)) || typeof b.payKey !== 'string' || !b.payKey) return bad('not_found', 404);
    const { data } = await db.from('bookings').update({ status: 'declined' })
      .eq('id', b.bookingId).eq('flow', 'detail_v2').eq('status', 'pending_payment').eq('detail->>payKey', b.payKey)
      .select('id, detail');
    if (data?.length) await undoBumps(b.bookingId, data[0].detail?.name);
    return json({ ok: true });
  },

  'pay-demo': async (b) => {
    const { data: mode } = await db.from('app_config').select('value').eq('key', 'payments_mode').maybeSingle();
    if (String(mode?.value ?? '') !== 'demo') return bad('payments_not_demo', 503); // fail closed
    if (!UUID.test(String(b.bookingId)) || typeof b.payKey !== 'string' || !b.payKey) return bad('not_found', 404);
    // One transaction (detail_pay_demo, migration 0017): payKey check, the quote's reward spent,
    // pending_payment -> requested. A reward spent elsewhere meanwhile = price_changed and the
    // booking stays pending_payment.
    const { data: paid, error } = await db.rpc('detail_pay_demo', { p_booking: b.bookingId, p_paykey: b.payKey });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('not_found')) return bad('not_found', 404);
      if (msg.includes('not_pending')) return bad('not_pending', 409);
      if (msg.includes('price_changed')) return bad('price_changed', 409);
      throw error;
    }
    const row = await loadRow(b.bookingId);
    if (row) await notify(row, await pricing());
    // the bookings this one moved, marked bumpNotified by detail_pay_demo (told once)
    for (const id of (Array.isArray(paid?.bumped) ? paid.bumped : []) as string[]) {
      await notifyBumped(String(id), row?.detail?.name);
    }
    return json({ ok: true, demo: true });
  },
};

const clock = (slot: string) => {
  const [h, m] = slot.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

// A VIP took a held time: tell the bumped customer (where they are now) and the owner. The
// booking stands either way.
async function notifyBumped(bumpedId: string, vipName: unknown) {
  try {
    const row = await loadRow(bumpedId);
    if (!row) return;
    const day = String(row.preferred_day);
    const to = row.time_slot ? clock(String(row.time_slot)) : null;
    const from = row.detail?.bumpedFrom ? clock(String(row.detail.bumpedFrom)) : 'their old time';
    const email = row.customers?.email;
    if (email) {
      await sendEmail(email, 'Your detail time moved',
        `<p>Hi, your Brotherly Love Detailing appointment on ${esc(day)} moved to ${to ? esc(to) : "a new time. We'll call to set it"}.</p>
         <p>Questions? Just reply to this email.</p>`);
    }
    await sendEmail(ownerEmail(), 'VIP booking moved a customer',
      `<p>VIP booking by ${esc(vipName)} moved ${esc(row.detail?.name)} from ${esc(from)} to ${to ? esc(to) : 'no time yet'} on ${esc(day)}.</p>`);
  } catch (e) {
    console.error('bump notify failed', (e as Error).message);
  }
}

// A VIP hold was released before its deposit: put the bookings it moved back (detail_unbump,
// migration 0017). One whose old time was taken meanwhile keeps its new time and hasn't been
// told yet (that waits for the VIP's deposit), so tell it now. Never fails the release.
// sweep/index.ts does the same for holds that expire.
async function undoBumps(vipId: string, vipName: unknown) {
  try {
    const { error } = await db.rpc('detail_unbump', { p_booking: vipId });
    if (error) throw error;
    const { data: kept, error: e2 } = await db.from('bookings').select('id')
      .eq('detail->>bumpedBy', vipId).in('status', ['pending_payment', 'requested']).is('detail->>bumpNotified', null);
    if (e2) throw e2;
    for (const h of kept ?? []) await notifyBumped(String(h.id), vipName);
  } catch (e) {
    console.error('unbump failed', vipId, (e as Error).message);
  }
}

// Only the owner is emailed here. The customer sees the on-screen confirmation, and gets an
// email when the owner confirms a time (`confirm`). That keeps this public endpoint from
// sending mail to an address nobody has verified.
async function notify(row: Obj, cfg: DetailPricing) {
  const d = row.detail ?? {};
  const q = row.quote ?? {};
  // rows saved before cars[] existed carry one car in the old fields
  const cars: Obj[] = Array.isArray(d.cars) ? d.cars : [{
    year: d.vehicle?.year, make: d.vehicle?.make, service: d.service, vehicleType: d.vehicleType,
    condition: d.condition, petHair: d.petHair,
  }];
  const lines: Obj[] = Array.isArray(q.lines) ? q.lines : [{ startingPrice: q.startingPrice }];
  const svc = (s: string) => cfg.services[s as DetailService]?.name ?? s;
  const veh = (v: string) => cfg.vehicleTypes[v as keyof DetailPricing['vehicleTypes']] ?? v;
  const carRows = cars.map((c, i) => {
    const l = lines[i] ?? {};
    const price = l.covered ? 'included' : money(l.payable ?? l.startingPrice);
    return `${esc(`${c.year ?? ''} ${c.make ?? ''}`.trim())} · ${esc(svc(c.service))} · ${esc(veh(c.vehicleType))} — ${price}` +
      `<br><span style="color:#888">Interior: ${esc(c.condition)} · Pet hair: ${c.petHair ? 'yes' : 'no'}</span>`;
  }).join('<br>');
  const tier = typeof q.tier === 'string' ? cfg.membership[q.tier as keyof DetailPricing['membership']]?.name ?? q.tier : null;
  const when = row.time_slot ? `${row.preferred_day} at ${row.time_slot}` : `${row.preferred_day}, no time yet`;
  const paid = row.deposit_status === 'paid';
  const deposit = q.deposit > 0
    ? `Deposit ${money(q.deposit)} ${paid ? '<b>paid from balance</b>' : '(<b>demo, no money taken</b>)'}.`
    : 'No deposit (fully covered).';
  try {
    await sendEmail(ownerEmail(), `${d.test ? '[TEST] ' : ''}New detail request: ${cars.length} car${cars.length > 1 ? 's' : ''}, ${when}`,
      `<h2 style="margin:0 0 8px">New detail request</h2>
       <p><b>${esc(d.name)}</b> · ${esc(d.phone)} · ${esc(row.customers?.email)}${tier ? ` · <b>${esc(tier)} member</b>` : ''}</p>
       <p>${carRows}</p>
       <p>${esc(when)}<br>${esc(row.address)}</p>
       ${row.time_slot ? '' : '<p><b>Same-tier VIP clash: pick a time with the customer.</b></p>'}
       <p>${tier ? `Member price ${money(q.payable ?? q.total)} (starting ${money(q.subtotal ?? q.total)})` : `Starting at ${money(q.total)}`}. ${deposit}</p>
       ${d.notes ? `<p>Notes: ${esc(d.notes)}</p>` : ''}
       ${button(adminLink(row.id), 'Open in dashboard')}`);
  } catch (e) {
    console.error('detail notify failed', (e as Error).message); // the booking stands either way
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return bad('method_not_allowed', 405);
  let body: Obj;
  try {
    body = await req.json();
  } catch {
    return bad('bad_json');
  }
  if (!body || typeof body !== 'object') return bad('bad_json');
  const handler = Object.hasOwn(handlers, String(body.action)) ? handlers[String(body.action)] : null;
  if (!handler) return bad('unknown_action');
  try {
    return await handler(body, req);
  } catch (e) {
    console.error('detail failed', body.action, (e as Error).message);
    return bad('server_error', 500);
  }
});
