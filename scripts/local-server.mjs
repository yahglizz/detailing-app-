#!/usr/bin/env node
// Local backend for the website + owner dashboard, with no Supabase and no accounts needed.
//
//   node scripts/local-server.mjs            (then open http://localhost:8794/)
//   PORT=9000 node scripts/local-server.mjs
//
// It serves the site (/) and the dashboard (/admin) and answers the same API calls the real
// `detail` and `admin` edge functions answer (/detail, /api), so the front end runs end to end:
// pick a package, book, pay the DEMO deposit, then confirm, invoice and mark paid in the dashboard.
//
// This is a STAND-IN, not the production backend: one process, one JSON file, no real database
// locking, no real emails (the "owner email" is printed here), no real payments, and the dashboard
// accepts any staff code. It binds to 127.0.0.1 only. Never expose it to the internet.
//
// Prices come from the seed in supabase/migrations/0015_detail_booking.sql (the same numbers the
// real backend uses). State is saved to .local-data/ (git-ignored); delete the folder to reset.
// The live site's data and the live Supabase project are never touched: the two Supabase
// addresses in the pages are rewritten to this server on the way out.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8794);
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(ROOT, '.local-data');
const STATE_FILE = path.join(DATA, 'state.json');
const LIVE_SUPABASE = 'https://fiaadogbkvjcddehnymj.supabase.co';

// ---- prices: the migration seed is the single source ----
function seedPricing() {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/0015_detail_booking.sql'), 'utf8');
  const region = sql.split('-- detailPricing:begin')[1].split('-- detailPricing:end')[0];
  return JSON.parse(region.match(/\$json\$([\s\S]*)\$json\$/)[1]);
}

// ---- state (persisted) ----
fs.mkdirSync(path.join(DATA, 'photos'), { recursive: true });
let saved = {}; try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first run */ }
const pricing = saved.pricing || seedPricing();
// Plan numbers added by migration 0017 (rank, stamps per car, top-up bonus, % off): fill any missing.
const PLAN_NUMBERS = { bronze: { rank: 1, stampsPerCar: 1, topupBonusPercent: 5, discountPercent: 10 }, silver: { rank: 2, stampsPerCar: 2, topupBonusPercent: 10, discountPercent: 15 }, gold: { rank: 3, stampsPerCar: 3, topupBonusPercent: 15, discountPercent: 20 } };
const withPlanNumbers = () => { for (const t of Object.keys(PLAN_NUMBERS)) pricing.membership[t] = { ...PLAN_NUMBERS[t], ...pricing.membership[t] }; };
withPlanNumbers();
const bookings = new Map((saved.bookings || []).map((b) => [b.id, b]));
for (const x of bookings.values()) { // state saved before multi-car: one car
  if (!x.cars) x.cars = [{ ...x.vehicle, vehicleType: x.vehicleType, service: x.service, condition: x.condition, petHair: x.petHair }];
  if (!x.inv.lines) x.inv.lines = [{ car: 0, price: x.inv.servicePrice, covered: false }];
}
const photoTypes = saved.photoTypes || {};
const save = () => { const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ pricing, bookings: [...bookings.values()], photoTypes })); fs.renameSync(tmp, STATE_FILE); };

const SLOTS = Array.from({ length: 9 }, (_, i) => String(9 + i).padStart(2, '0') + ':00');
const SERVICES = ['exterior', 'refresh', 'deep', 'full', 'premium'];
const VEHICLES = ['sedan', 'suv', 'large'];
const CONDITIONS = ['light', 'moderate', 'heavy'];
const H = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const send = (res, code, body) => { res.writeHead(code, H); res.end(JSON.stringify(body)); };
const iso = (d) => d.toISOString().slice(0, 10);
const todayStr = () => iso(new Date());
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const isSunday = (s) => new Date(s + 'T12:00:00').getDay() === 0;
const windowDays = () => pricing.bookingWindowDays || 14;
const holding = (day) => [...bookings.values()].filter((b) => b.day === day && b.slot && !['declined', 'refunded'].includes(b.status));
const taken = (day) => holding(day).map((b) => b.slot);
const priceOf = (s, v) => pricing.services[s].prices[v];
const depOf = (s, v) => Math.min(pricing.deposits[v], priceOf(s, v));
const str = (x, max) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const MAX_CARS = 6;
// One line per car, deposits summed (each capped at its car's price): same as quoteCars().
const quoteCars = (cars) => {
  const lines = cars.map((c) => ({ service: c.service, vehicleType: c.vehicleType, startingPrice: priceOf(c.service, c.vehicleType), deposit: depOf(c.service, c.vehicleType) }));
  return { lines, subtotal: lines.reduce((n, l) => n + l.startingPrice, 0), deposit: lines.reduce((n, l) => n + l.deposit, 0) };
};
const carText = (c) => `${c.year} ${c.make} (${pricing.services[c.service].name}, ${pricing.vehicleTypes[c.vehicleType]})`;

function membershipView() {
  return Object.fromEntries(Object.entries(pricing.membership).map(([t, m]) => {
    const ents = SERVICES.filter((s) => (m.visits[s] || 0) > 0);
    return [t, {
      name: m.name, tagline: m.tagline, perks: m.perks, rank: m.rank, stampsPerCar: m.stampsPerCar, topupBonusPercent: m.topupBonusPercent, discountPercent: m.discountPercent, includes: ents.map((s) => `${m.visits[s]} × ${pricing.services[s].name}`),
      prices: Object.fromEntries(VEHICLES.map((v) => { const worth = ents.reduce((a, s) => a + m.visits[s] * pricing.services[s].prices[v], 0); return [v, { price: m.prices[v], worth, save: Math.max(0, worth - m.prices[v]) }]; })),
    }];
  }));
}

// ---- the website's `detail` API: each handler returns [status, body] ----
const detail = {
  config: () => [200, { pricing, membership: membershipView(), slots: SLOTS, today: todayStr() }],
  quote: (b) => {
    if (b.cars !== undefined) { // multi-car body -> { lines, subtotal, deposit }
      if (!Array.isArray(b.cars) || b.cars.length < 1 || b.cars.length > MAX_CARS) return [400, { error: 'bad_cars' }];
      if (b.cars.some((c) => !c || !SERVICES.includes(c.service) || !VEHICLES.includes(c.vehicleType))) return [400, { error: 'bad_service' }];
      return [200, quoteCars(b.cars)];
    }
    if (!SERVICES.includes(b.service) || !VEHICLES.includes(b.vehicleType)) return [400, { error: 'bad_service' }];
    const p = priceOf(b.service, b.vehicleType), d = depOf(b.service, b.vehicleType);
    return [200, { startingPrice: p, deposit: d, balance: p - d }];
  },
  availability: (b) => {
    const days = []; for (let i = 0; i <= windowDays(); i++) { const d = addDays(i); days.push({ day: d, capacity: 9, booked: taken(d).length, closed: isSunday(d) }); }
    const out = { days, slots: SLOTS, today: todayStr(), windowDays: windowDays() };
    if (b.day) { out.taken = taken(b.day); out.holders = Object.fromEntries(holding(b.day).map((x) => [x.slot, x.rank || 0])); if (b.day === todayStr()) out.minSlot = String(Math.min(24, new Date().getHours() + 2)).padStart(2, '0') + ':00'; }
    return [200, out];
  },
  reserve: (b) => {
    const name = str(b.name, 60), phone = str(b.phone, 30), email = str(b.email, 254).toLowerCase(), street = str(b.street, 120), zip = str(b.zip, 10);
    if (!name || !phone || !email || !street || !zip || !b.day || !b.slot) return [400, { error: 'missing_fields' }];
    const raw = b.cars === undefined ? [{ ...b.vehicle, vehicleType: b.vehicleType, service: b.service, condition: b.condition, petHair: b.petHair }] : b.cars;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CARS) return [400, { error: 'bad_cars' }];
    const cars = [];
    for (const c of raw) {
      const o = c && typeof c === 'object' ? c : {}, year = str(o.year, 4), make = str(o.make, 40);
      if (!year || !make) return [400, { error: 'missing_fields' }];
      if (!SERVICES.includes(o.service)) return [400, { error: 'bad_service' }];
      if (!VEHICLES.includes(o.vehicleType)) return [400, { error: 'bad_vehicle_type' }];
      if (!CONDITIONS.includes(o.condition)) return [400, { error: 'bad_condition' }];
      if (!/^(19|20)\d{2}$/.test(year)) return [400, { error: 'bad_vehicle' }];
      if (typeof o.petHair !== 'boolean') return [400, { error: 'bad_answer' }];
      cars.push({ year, make, vehicleType: o.vehicleType, service: o.service, condition: o.condition, petHair: o.petHair });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return [400, { error: 'bad_email' }];
    const digits = phone.replace(/\D/g, ''); if (digits.length < 10 || digits.length > 15) return [400, { error: 'bad_phone' }];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.day) || b.day < todayStr() || b.day > addDays(windowDays())) return [400, { error: 'bad_day' }];
    if (!SLOTS.includes(b.slot)) return [400, { error: 'bad_slot' }];
    if (!/^\d{5}$/.test(zip)) return [400, { error: 'bad_zip' }];
    const exts = Array.isArray(b.photoExts) ? b.photoExts.map((e) => String(e).toLowerCase()) : [];
    if (exts.length > 4 || exts.some((e) => !['jpg', 'jpeg', 'png', 'heic', 'webp'].includes(e))) return [400, { error: 'bad_photos' }];
    if (isSunday(b.day)) return [409, { error: 'day_closed' }];
    if (taken(b.day).length >= 9) return [409, { error: 'day_full' }];
    if (taken(b.day).includes(b.slot)) return [409, { error: 'slot_taken' }]; // guests only here: no VIP bump in the stand-in
    // the price is always worked out here; any price the browser sends is ignored
    const q = quoteCars(cars);
    const id = crypto.randomUUID(), payKey = crypto.randomBytes(16).toString('hex');
    bookings.set(id, { id, payKey, status: 'pending_payment', depositStatus: 'pending', createdAt: new Date().toISOString(), day: b.day, slot: b.slot, rank: 0, cars, startingPrice: q.subtotal, deposit: q.deposit, name, phone, email, street, zip, notes: str(b.notes, 500), photos: exts.length,
      inv: { lines: q.lines.map((l, i) => ({ car: i, price: l.startingPrice, covered: false })), servicePrice: q.subtotal, extras: [], status: 'draft', paidAt: null, paidMethod: null } });
    save();
    return [200, { bookingId: id, payKey, quote: q, uploads: exts.map((_, i) => ({ path: `${id}/${i}`, signedUrl: `${BASE}/up/${id}/${i}` })), escalated: false, paidFromBalance: false }];
  },
  'pay-demo': (b) => {
    const x = bookings.get(b.bookingId); if (!x || x.payKey !== b.payKey) return [404, { error: 'not_found' }];
    if (x.status !== 'pending_payment') return [409, { error: 'not_pending' }];
    x.status = 'requested'; x.depositStatus = 'demo'; save(); // demo: never 'paid'
    console.log(`  [owner email] New detail request: ${x.name}, ${x.cars.map(carText).join(' + ')}, ${x.day} ${x.slot}`);
    return [200, { ok: true, demo: true }];
  },
  release: (b) => {
    const x = bookings.get(b.bookingId); // a wrong key is a harmless no-op, same as the real function
    if (x && x.payKey === b.payKey && x.status === 'pending_payment') { x.status = 'declined'; save(); }
    return [200, { ok: true }];
  },
};

// ---- the dashboard's `admin` API ----
const credit = (x) => (x.depositStatus === 'paid' ? x.deposit : 0); // a demo deposit took no money
const tot = (x) => { const total = x.inv.servicePrice + x.inv.extras.reduce((s, e) => s + e.price, 0); const c = Math.min(credit(x), total); return { total, credit: c, balance: total - c, refundDue: credit(x) - c }; };
const invOut = (x) => { const t = tot(x); return { ...x.inv, depositCredit: t.credit, total: t.total, balance: t.balance }; };
const shape = (x) => {
  const t = tot(x), paid = x.status === 'paid';
  return { id: x.id, day: x.day, slot: x.slot, window: x.slot < '12:00' ? 'morning' : 'afternoon', status: x.status, when: null, address: `${x.street}, ${x.zip}`, notes: x.notes, remainderMethod: 'cash', payMode: null, createdAt: x.createdAt, items: x.cars.map((c) => ({ service: c.service, vehicle: c.vehicleType })), customer: { id: 'c-' + x.email, name: x.name, email: x.email }, reports: 0, total: t.total, payable: t.total, paidOnline: 0, walletUsed: 0, creditsUsed: 0, savings: 0, balanceDue: t.balance, collected: paid ? t.balance : 0, owing: paid ? 0 : t.balance, tier: null, member: false, test: false, payments: [], flow: 'detail_v2', depositStatus: x.depositStatus, phone: x.phone };
};
const live = () => [...bookings.values()].filter((x) => !['pending_payment', 'declined'].includes(x.status));
const ME = { id: 'owner', name: 'Owner (local)', role: 'owner', open: true };
const get = (b) => bookings.get(b.id);
const whole = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const validPricing = (n) => {
  if (!n || typeof n !== 'object' || !whole(n.bookingWindowDays, 1, 60)) return false;
  if (!VEHICLES.every((v) => whole(n.deposits?.[v], 1, 10000) && typeof n.vehicleTypes?.[v] === 'string')) return false;
  if (!SERVICES.every((s) => n.services?.[s] && VEHICLES.every((v) => whole(n.services[s].prices?.[v], 1, 10000)))) return false;
  if (SERVICES.filter((s) => n.services[s].popular).length !== 1) return false;
  const RANGES = { rank: [1, 3], stampsPerCar: [1, 10], topupBonusPercent: [0, 50], discountPercent: [0, 50] }; // missing = the tier default
  if (!['bronze', 'silver', 'gold'].every((t) => { const m = n.membership?.[t]; return m && VEHICLES.every((v) => whole(m.prices?.[v], 1, 10000)) && Object.values(m.visits || {}).some((c) => whole(c, 1, 8)) && Object.values(m.visits || {}).every((c) => whole(c, 1, 8))
    && Object.entries(RANGES).every(([k, [lo, hi]]) => m[k] === undefined || whole(m[k], lo, hi)); })) return false;
  return new Set(['bronze', 'silver', 'gold'].map((t) => n.membership[t].rank ?? PLAN_NUMBERS[t].rank)).size === 3;
};
const admin = {
  me: () => ME,
  overview: () => ({ me: ME, today: todayStr(), newLeads: 0, bookings: live().map(shape), stats: { today: live().filter((x) => x.day === todayStr()).length, upcoming: live().length, awaiting: live().filter((x) => x.status === 'requested').length, owing: 0 } }),
  booking: (b) => (get(b) ? shape(get(b)) : 'not_found'),
  confirm: (b) => { const x = get(b); if (!x) return 'not_found'; x.status = 'confirmed'; if (b.day) x.day = b.day; if (b.slot) x.slot = b.slot; save();
    const d = new Date(x.day + 'T12:00:00'), h = Number(String(x.slot || '').slice(0, 2));
    return { ok: true, when: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + (x.slot ? ` at ${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}` : '') };
  },
  detail_get: (b) => {
    const x = get(b); if (!x) return 'not_found';
    const c0 = x.cars[0]; // car 1 also at the top level for the dashboard that shows one car
    return { detail: { name: x.name, phone: x.phone, vehicle: { year: c0.year, make: c0.make }, condition: c0.condition, petHair: c0.petHair, cars: x.cars, notes: x.notes }, photos: Array.from({ length: x.photos }, (_, i) => `${BASE}/up/${x.id}/${i}`), depositStatus: x.depositStatus, depositCreditable: credit(x), startingPrice: x.startingPrice, invoice: invOut(x) };
  },
  invoice_save: (b) => {
    const x = get(b); if (!x) return 'not_found'; if (x.inv.status === 'paid') return ['already_paid', 409];
    const ex = b.extras ?? x.inv.extras;
    if (!Array.isArray(ex) || ex.some((e) => !e || !String(e.name ?? e.label ?? '').trim() || !whole(e.price, 0, 10000))) return 'bad_invoice';
    let lines = x.inv.lines.map((l) => ({ ...l }));
    if (Array.isArray(b.lines)) { // per-car prices, in car order
      if (b.lines.length !== lines.length || b.lines.some((l) => !whole(Number(l?.price ?? l), 0, 10000))) return 'bad_invoice';
      lines = lines.map((l, i) => ({ ...l, price: Number(b.lines[i]?.price ?? b.lines[i]) }));
    } else if (b.servicePrice !== undefined) { // one-price dashboard: the change lands on the last car
      const sp = Number(b.servicePrice), last = lines[lines.length - 1], p = last.price + sp - lines.reduce((n, l) => n + l.price, 0);
      if (!whole(sp, 0, 10000) || p < 0) return 'bad_invoice';
      last.price = p;
    }
    x.inv = { ...x.inv, lines, servicePrice: lines.reduce((n, l) => n + l.price, 0), extras: ex }; save(); return invOut(x);
  },
  invoice_pay: (b) => {
    const x = get(b); if (!x) return 'not_found'; if (!['confirmed', 'done'].includes(x.status)) return ['not_open', 409]; if (x.inv.status === 'paid') return ['already_paid', 409];
    if (b.method !== 'cash' && b.method !== 'card') return 'bad_method';
    x.inv = { ...x.inv, status: 'paid', paidAt: new Date().toISOString(), paidMethod: b.method }; x.status = 'done'; save(); return { ok: true, ...tot(x) }; // paid = job done
  },
  detail_pricing_get: () => ({ detailPricing: pricing }),
  detail_pricing_save: (b) => { if (!validPricing(b.detailPricing)) return 'bad_pricing'; for (const k of Object.keys(pricing)) delete pricing[k]; Object.assign(pricing, b.detailPricing); withPlanNumbers(); save(); return { ok: true, detailPricing: pricing }; },
  pricing_get: () => ({ config: { services: { outside: 45, inside: 60, full: 120 }, extras: {}, sizeMultipliers: { sedan: 1, suv: 1.25, truck: 1.5 }, depositPercent: 25, plans: {}, packages: { ministry: 220 }, topup: { min: 10, max: 500 } } }),
  customers: () => [], leads: () => [],
  calendar: () => ({ month: todayStr().slice(0, 7), today: todayStr(), schedule: { dailyCapacity: 9, closedWeekdays: [0] }, days: [], overrides: [], jobs: live().filter((x) => x.status === 'confirmed').map((x) => ({ id: x.id, day: x.day, slot: x.slot, customer: x.name, status: x.status })) }),
};

const run = (table, b, res) => {
  const h = table[b.action]; if (!h) return send(res, 400, { error: 'unknown_action' });
  const out = h(b);
  if (table === detail) return send(res, out[0], out[1]);
  if (typeof out === 'string') return send(res, 400, { error: out });
  if (Array.isArray(out)) return send(res, out[1], { error: out[0] });
  send(res, 200, out);
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4', '.json': 'application/json', '.woff2': 'font/woff2' };
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, H); return res.end(); }
  const u = req.url.split('?')[0];

  if (u.startsWith('/up/')) { // photo upload (PUT) and view (GET); names are the booking id + index
    if (!/^\/up\/[0-9a-f-]{36}\/[0-3]$/.test(u)) { res.writeHead(404, H); return res.end(); }
    const file = path.join(DATA, 'photos', u.slice(4).replace('/', '-'));
    if (req.method === 'PUT') {
      const c = []; let n = 0;
      req.on('data', (d) => { n += d.length; if (n <= 10 * 1024 * 1024) c.push(d); });
      return req.on('end', () => { if (n > 10 * 1024 * 1024) { res.writeHead(413, H); return res.end(); } fs.writeFileSync(file, Buffer.concat(c)); photoTypes[u] = req.headers['content-type'] || 'image/jpeg'; save(); res.writeHead(200, H); res.end('{}'); });
    }
    if (!fs.existsSync(file)) { res.writeHead(404, H); return res.end(); }
    res.writeHead(200, { 'content-type': photoTypes[u] || 'image/jpeg', 'access-control-allow-origin': '*' }); return res.end(fs.readFileSync(file));
  }

  if (u.startsWith('/sb/')) { // stands in for the live Supabase REST address the page used to call (quote leads, catalog)
    if (req.method === 'POST') { req.resume(); return req.on('end', () => { res.writeHead(201, H); res.end('[]'); }); }
    res.writeHead(200, H); return res.end('[]');
  }

  if (req.method === 'POST' && (u === '/detail' || u === '/api')) {
    let body = ''; req.on('data', (c) => { if (body.length < 1e6) body += c; });
    return req.on('end', () => {
      let b; try { b = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'bad_json' }); }
      console.log(new Date().toTimeString().slice(0, 8), u, b.action);
      try { run(u === '/detail' ? detail : admin, b, res); } catch (e) { console.error(e); send(res, 500, { error: 'server_error' }); }
    });
  }

  let p; try { p = decodeURIComponent(u); } catch { res.writeHead(400); return res.end(); }
  if (p === '/') p = '/Brotherly Love Detailing.dc.html'; if (p === '/admin' || p === '/admin/') p = '/admin/index.html';
  const f = path.join(ROOT, p);
  // serve the site only: never the repo's code, data or secrets
  const ok = f.startsWith(ROOT + path.sep) && /^\/(Brotherly Love Detailing\.dc\.html|support\.js|image-slot\.js|assets\/|admin\/|uploads\/)/.test(p) && !p.includes('..');
  if (!ok || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  let data = fs.readFileSync(f); const ext = path.extname(f);
  if (p.endsWith('.dc.html')) data = Buffer.from(data.toString().split(LIVE_SUPABASE).join(BASE + '/sb'));
  if (p === '/assets/booking.js') data = Buffer.from(data.toString().replace(`'${LIVE_SUPABASE}/functions/v1/detail'`, `'${BASE}/detail'`));
  if (p === '/admin/app.js') data = Buffer.from(data.toString().replace('`${SUPABASE_URL}/functions/v1/admin`', '`${location.origin}/api`')); // /admin works with no ?api=
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(data);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`BLD local backend running (stand-in, demo payments, nothing live is touched)\n  Website:   ${BASE}/\n  Dashboard: ${BASE}/admin   (any staff code works)\n  Data:      ${DATA}\n  Ctrl+C to stop`);
});
