// Public booking API for the website's starting-price flow (flow = 'detail_v2').
// POST { action, ... }:
//   config                         -> { pricing, slots, today }
//   quote { service, vehicleType } -> { startingPrice, deposit, balance }
//   availability { from?, to? }    -> { days, slots, today, windowDays }
//   availability { day }           -> same, plus { taken: ["10:00", ...] }
//   reserve { ...request }         -> { bookingId, payKey, quote, uploads }
//   pay-demo { bookingId, payKey } -> { ok, demo: true }
//
// Every number is computed here from catalog.config.detailPricing; anything price-shaped in a
// request body is ignored. Payments are demo-only: pay-demo works only while
// app_config.payments_mode is exactly 'demo' and records deposit_status 'demo', never 'paid'.
// Deployed with verify_jwt=false (browsers preflight without a JWT), like `admin`.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { ALL_SLOTS } from '../_shared/bump.ts';
import { validateReserve } from '../_shared/detail_booking.ts';
import {
  DEFAULT_DETAIL_PRICING, isService, isVehicle, quoteDetail, validateDetailPricing, type DetailPricing,
} from '../_shared/detail_pricing.ts';
import { clientIp } from '../_shared/codes.ts';
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
// Abuse caps per rolling hour. Every attempt counts, whatever its status, so cancelling or
// abandoning holds doesn't reset them. ponytail: no captcha / email verification yet.
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 10;
const sha256 = async (t: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');

// The business runs on Eastern time; "today" is its day, not UTC's.
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const money = (n: number) => `$${n}`;

async function pricing(): Promise<DetailPricing> {
  const { data, error } = await db.from('catalog').select('config').eq('id', 1).single();
  if (error) throw error;
  const v = validateDetailPricing(data.config?.detailPricing);
  if (v.ok) return v.value;
  console.error('detailPricing in catalog is invalid, using defaults:', v.error);
  return DEFAULT_DETAIL_PRICING;
}

const handlers: Record<string, (b: Obj, req: Request) => Promise<Response>> = {
  config: async () => json({ pricing: await pricing(), slots: ALL_SLOTS, today: todayISO() }),

  quote: async (b) => {
    if (!isService(b.service)) return bad('bad_service');
    if (!isVehicle(b.vehicleType)) return bad('bad_vehicle_type');
    return json(quoteDetail(await pricing(), b.service, b.vehicleType));
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
    const out: Obj = { days, slots: ALL_SLOTS, today, windowDays: cfg.bookingWindowDays };
    if (b.day !== undefined) {
      if (!isoOk(b.day) || b.day < today || b.day > last) return bad('bad_day');
      const { data: taken, error: tErr } = await db.rpc('booked_slots', { day: b.day });
      if (tErr) throw tErr;
      out.taken = taken ?? [];
    }
    return json(out);
  },

  reserve: async (b, req) => {
    const cfg = await pricing();
    const today = todayISO();
    const v = validateReserve(b, cfg, today);
    if (!v.ok) return bad(v.error);
    const r = v.value;
    const q = quoteDetail(cfg, r.service, r.vehicleType); // server price, never the client's

    // day open and not full; slot not taken by ANY booking (app rows included)
    const { data: dayRows, error: dayErr } = await db.rpc('day_states', { from_day: r.day, to_day: r.day });
    if (dayErr) throw dayErr;
    const st = dayRows?.[0] as { capacity: number; booked: number; closed: boolean } | undefined;
    if (!st) return bad('bad_day');
    if (st.closed) return bad('day_closed', 409);
    if (st.booked >= st.capacity) return bad('day_full', 409);
    const { data: taken, error: takenErr } = await db.rpc('booked_slots', { day: r.day });
    if (takenErr) throw takenErr;
    if ((taken as string[] | null)?.includes(r.slot)) return bad('slot_taken', 409);

    // abuse caps, before anything is written
    const since = new Date(Date.now() - 3600e3).toISOString();
    const ipHash = await sha256(clientIp(req));
    const [{ count: byEmail }, { count: byIp }] = await Promise.all([
      db.from('bookings').select('id, customers!inner(email)', { count: 'exact', head: true })
        .eq('flow', 'detail_v2').eq('customers.email', r.email).gt('created_at', since),
      db.from('bookings').select('id', { count: 'exact', head: true })
        .eq('flow', 'detail_v2').eq('detail->>ipHash', ipHash).gt('created_at', since),
    ]);
    if ((byEmail ?? 0) >= MAX_PER_EMAIL || (byIp ?? 0) >= MAX_PER_IP) return bad('too_many', 429);

    // customer row keyed by email, same as `book`. An existing row is never renamed: anyone
    // can type any email here, so the name they give lives on this booking (detail.name) only.
    await db.from('customers').upsert({ id: crypto.randomUUID(), email: r.email, name: r.name }, { onConflict: 'email', ignoreDuplicates: true });
    const { data: cust } = await db.from('customers').select('id').eq('email', r.email).single();
    if (!cust) return bad('server_error', 500);

    const bookingId = crypto.randomUUID();
    const payKey = crypto.randomUUID().replaceAll('-', '');
    const photos = r.photoExts.map((ext) => `${bookingId}/${crypto.randomUUID()}.${ext === 'jpeg' ? 'jpg' : ext}`);
    const { error: insErr } = await db.from('bookings').insert({
      id: bookingId,
      customer_id: cust.id,
      flow: 'detail_v2',
      status: 'pending_payment',
      deposit_status: 'pending',
      items: [{ service: r.service, vehicle: r.vehicleType }],
      quote: { startingPrice: q.startingPrice, total: q.startingPrice, deposit: q.deposit, remainder: q.balance, balanceDue: q.balance, paidOnline: 0 },
      address: `${r.street}, ${r.zip}`,
      preferred_day: r.day,
      time_slot: r.slot,
      time_window: r.slot < '12:00' ? 'morning' : 'afternoon',
      notes: r.notes,
      remainder_method: 'cash', // placeholder; invoice_pay records the real method
      confirm_token: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
      detail: {
        payKey, ipHash, name: r.name, phone: r.phone, vehicle: r.vehicle, vehicleType: r.vehicleType, service: r.service,
        condition: r.condition, petHair: r.petHair, water: r.water, power: r.power, zip: r.zip, notes: r.notes, photos,
      },
    });
    if (insErr) {
      // the unique index closes the race two people can run on the same slot
      if (insErr.code === '23505') return bad('slot_taken', 409);
      // the capacity trigger (migration 0015) is the atomic guarantee behind the checks above
      if (insErr.message.includes('day_full')) return bad('day_full', 409);
      if (insErr.message.includes('day_closed')) return bad('day_closed', 409);
      console.error('detail reserve insert failed', insErr.message);
      return bad('booking_insert_failed', 500);
    }

    const uploads: { path: string; signedUrl: string }[] = [];
    for (const path of photos) {
      const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
      if (!error && data) uploads.push({ path, signedUrl: data.signedUrl });
    }
    return json({ bookingId, payKey, quote: q, uploads });
  },

  'pay-demo': async (b) => {
    const { data: mode } = await db.from('app_config').select('value').eq('key', 'payments_mode').maybeSingle();
    if (String(mode?.value ?? '') !== 'demo') return bad('payments_not_demo', 503); // fail closed
    if (!UUID.test(String(b.bookingId)) || typeof b.payKey !== 'string' || !b.payKey) return bad('not_found', 404);
    const { data: row } = await db.from('bookings')
      .select('id, status, preferred_day, time_slot, quote, address, detail, customers(email, name)')
      .eq('id', b.bookingId).eq('flow', 'detail_v2').maybeSingle();
    if (!row || row.detail?.payKey !== b.payKey) return bad('not_found', 404);

    // one transition, ever: only a pending_payment row can become requested
    const { data: won } = await db.from('bookings')
      .update({ status: 'requested', deposit_status: 'demo' })
      .eq('id', row.id).eq('status', 'pending_payment').select('id');
    if (!won?.length) return bad('not_pending', 409);

    await notify(row, await pricing());
    return json({ ok: true, demo: true });
  },
};

// Only the owner is emailed here. The customer sees the on-screen confirmation, and gets an
// email when the owner confirms a time (`confirm`). That keeps this public endpoint from
// sending mail to an address nobody has verified.
// deno-lint-ignore no-explicit-any
async function notify(row: any, cfg: DetailPricing) {
  const d = row.detail ?? {};
  const q = row.quote ?? {};
  const svc = cfg.services[d.service as keyof DetailPricing['services']]?.name ?? d.service;
  const veh = cfg.vehicleTypes[d.vehicleType as keyof DetailPricing['vehicleTypes']] ?? d.vehicleType;
  const car = `${d.vehicle?.year ?? ''} ${d.vehicle?.make ?? ''} ${d.vehicle?.model ?? ''}`.trim();
  const when = `${row.preferred_day}${row.time_slot ? ` at ${row.time_slot}` : ''}`;
  const flags = [!d.water && 'No water on site', !d.power && 'No power on site'].filter(Boolean) as string[];
  try {
    await sendEmail(ownerEmail(), `New detail request: ${svc}, ${when}`,
      `<h2 style="margin:0 0 8px">New detail request</h2>
       <p><b>${esc(d.name)}</b> · ${esc(d.phone)} · ${esc(row.customers?.email)}</p>
       <p>${esc(svc)} · ${esc(veh)}<br>${esc(car)}<br>${esc(when)}<br>${esc(row.address)}</p>
       <p>Starting at ${money(q.total)}. Deposit ${money(q.deposit)} (<b>demo, no money taken</b>).</p>
       <p>Interior: ${esc(d.condition)} · Pet hair: ${d.petHair ? 'yes' : 'no'}${flags.length ? `<br><b>${esc(flags.join('. '))}.</b>` : ''}</p>
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
