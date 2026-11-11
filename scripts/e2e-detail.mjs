#!/usr/bin/env node
// End-to-end proof for the starting-price booking flow, run against the LIVE project:
// the `detail` function (quote, availability, reserve, demo payment), the admin invoice
// actions, the sweep rules and the pricing editor. Needs migration 0015 applied and the
// `detail`, `admin` and `sweep` functions deployed.
//
// Proves: all 15 price cells and the deposit cap, a tampered body can't change the price,
// a second request for the same slot / a closed day / a full day is refused, the demo
// deposit is stored as 'demo' and NEVER 'paid', pay-demo works once, the owner invoice
// can't be paid before the time is confirmed, paying marks the job done, the deposit is
// credited only if it was really paid and the balance is right, and the pricing editor
// round-trips.
//
// Leaves nothing behind: test customers use the prefix e2e-detail-<time>, and the
// existing `e2e-setup` cleanup removes their bookings and payments (invoices cascade).
// The owner gets a "New detail request" email per paid-demo booking (2 per run).
//
// Run:  BLD_OWNER_TOKEN=<owner key> node scripts/e2e-detail.mjs
// Requires Node 18+. No npm deps. Re-running more than ~4 times in an hour from one
// network trips the per-IP cap (10 bookings/hour) on purpose.

const SUPABASE_URL = 'https://fiaadogbkvjcddehnymj.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpYWFkb2dia3ZqY2RkZWhueW1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjQ1OTUsImV4cCI6MjA5OTgwMDU5NX0.XR44tZS4Ntuvg7NZBdB5A_4_y6WjeTEgwweFeqwp8rE';
const OWNER = process.env.BLD_OWNER_TOKEN || '';
if (!OWNER) {
  console.error('Set BLD_OWNER_TOKEN (the owner key) before running.');
  process.exit(1);
}

const MATRIX = {
  exterior: { sedan: 40, suv: 50, large: 60 },
  refresh: { sedan: 80, suv: 95, large: 110 },
  deep: { sedan: 150, suv: 175, large: 200 },
  full: { sedan: 175, suv: 205, large: 235 },
  premium: { sedan: 260, suv: 295, large: 335 },
};
const DEPOSIT = { sedan: 25, suv: 35, large: 45 };

let passes = 0;
const pass = (step) => { passes++; console.log(`PASS: ${step}`); };
const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`); };

async function call(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const post = (fn, headers, payload) => call(`${SUPABASE_URL}/functions/v1/${fn}`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload),
});
const detail = (action, payload = {}) => post('detail', {}, { ...payload, action });
const owner = (action, payload = {}) => post('admin', { 'x-staff-code': OWNER }, { ...payload, action });
const setup = (action, payload = {}) => post('e2e-setup', {}, { token: OWNER, action, ...payload });

const stamp = Date.now();
const prefix = `e2e-detail-${stamp}`;
const emailOf = (tag) => `${prefix}-${tag}@bldtest.co`;
const cleanup = [];

const body = (over = {}) => ({
  name: 'E2E TEST Customer', phone: '(302) 555-0148', email: emailOf('a'),
  vehicle: { year: '2021', make: 'Cadillac' }, vehicleType: 'sedan', service: 'full',
  condition: 'moderate', petHair: true, day: '', slot: '', street: '1 Test St', zip: '19801',
  notes: 'E2E TEST', photoExts: [], ...over,
});

async function main() {
  // 1. config + all 15 price cells + deposits
  const cfg = await detail('config');
  assert(cfg.status === 200 && cfg.body.pricing?.services, `config: ${cfg.status} ${JSON.stringify(cfg.body).slice(0, 200)}`);
  let cells = 0;
  for (const [s, row] of Object.entries(MATRIX)) {
    for (const [v, price] of Object.entries(row)) {
      assert(cfg.body.pricing.services[s].prices[v] === price, `config price ${s}/${v}`);
      const q = await detail('quote', { service: s, vehicleType: v });
      const dep = Math.min(DEPOSIT[v], price);
      assert(q.status === 200 && q.body.startingPrice === price && q.body.deposit === dep && q.body.balance === price - dep,
        `quote ${s}/${v}: ${JSON.stringify(q.body)}`);
      cells++;
    }
  }
  assert(cells === 15, 'cell count');
  pass('1. config and quote: all 15 price cells, deposits and balances match the brief');

  // 2. bad ids refused
  for (const [service, vehicleType] of [['__proto__', 'sedan'], ['FULL', 'sedan'], ['full', 'truck'], ['constructor', 'constructor']]) {
    const q = await detail('quote', { service, vehicleType });
    assert(q.status === 400, `quote ${service}/${vehicleType} should be 400, got ${q.status}`);
  }
  pass('2. quote refuses unknown service / vehicle ids (400)');

  // 3. availability: pick a free day and slot
  const av = await detail('availability', {});
  assert(av.status === 200 && Array.isArray(av.body.days) && av.body.slots.length === 9, `availability: ${av.status}`);
  const open = av.body.days.filter((d) => !d.closed && d.booked < d.capacity && d.day > av.body.today).map((d) => d.day);
  assert(open.length >= 3, `need 3 open days in the window, found ${open.length}`);
  const [dayA, dayB, dayC] = open;
  const taken = await detail('availability', { day: dayA });
  assert(taken.status === 200 && Array.isArray(taken.body.taken), 'availability day -> taken[]');
  const freeSlots = av.body.slots.filter((s) => !taken.body.taken.includes(s));
  assert(freeSlots.length >= 2, 'need 2 free slots');
  const [slot1, slot2] = freeSlots;
  pass(`3. availability: ${open.length} open days in the window; ${dayA} has ${freeSlots.length} free slots`);

  // 4. validation
  const v1 = await detail('reserve', body({ day: dayA, slot: slot1, zip: '1234' }));
  const v2 = await detail('reserve', body({ day: '2020-01-01', slot: slot1 }));
  const v3 = await detail('reserve', body({ day: dayA, slot: '08:00' }));
  assert(v1.status === 400 && v1.body.error === 'bad_zip', `bad zip: ${JSON.stringify(v1.body)}`);
  assert(v2.status === 400 && v2.body.error === 'bad_day', `past day: ${JSON.stringify(v2.body)}`);
  assert(v3.status === 400 && v3.body.error === 'bad_slot', `bad slot: ${JSON.stringify(v3.body)}`);
  pass('4. reserve validation: bad ZIP, past day and bad slot refused (400)');

  // 5. tampered body: price/deposit ignored; photo upload; server numbers win
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
  const r1 = await detail('reserve', body({ day: dayA, slot: slot1, photoExts: ['jpg'], price: 1, deposit: 1, total: 1, startingPrice: 1 }));
  assert(r1.status === 200 && r1.body.bookingId && r1.body.payKey, `reserve: ${r1.status} ${JSON.stringify(r1.body)}`);
  const id1 = r1.body.bookingId;
  assert(r1.body.quote.startingPrice === 175 && r1.body.quote.deposit === 25 && r1.body.quote.balance === 150,
    `tampered price leaked: ${JSON.stringify(r1.body.quote)}`);
  assert(r1.body.uploads.length === 1, 'one signed upload url');
  const put = await fetch(r1.body.uploads[0].signedUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg });
  assert(put.ok, `photo upload: ${put.status}`);
  pass('5. reserve: price/deposit in the body ignored (sedan full = 175 / 25 / 150); photo uploaded');

  // 6. same slot refused, even for someone else
  const r2 = await detail('reserve', body({ email: emailOf('clash'), day: dayA, slot: slot1 }));
  assert(r2.status === 409 && r2.body.error === 'slot_taken', `slot clash: ${r2.status} ${JSON.stringify(r2.body)}`);
  pass('6. second request for the same day + slot is refused (409 slot_taken)');

  // 7. closed day and full day
  {
    const set = await owner('set_day', { day: dayB, closed: true, note: 'e2e' });
    assert(set.status === 200, `set_day closed: ${set.status}`);
    cleanup.push(() => owner('set_day', { day: dayB, clear: true }));
    const c = await detail('reserve', body({ email: emailOf('closed'), day: dayB, slot: slot1 }));
    assert(c.status === 409 && c.body.error === 'day_closed', `closed: ${JSON.stringify(c.body)}`);
    const set2 = await owner('set_day', { day: dayB, closed: false, capacity: 0, note: 'e2e' });
    assert(set2.status === 200, 'set_day cap 0');
    const f = await detail('reserve', body({ email: emailOf('full'), day: dayB, slot: slot1 }));
    assert(f.status === 409 && f.body.error === 'day_full', `full: ${JSON.stringify(f.body)}`);
    await owner('set_day', { day: dayB, clear: true });
  }
  pass('7. a closed day (409 day_closed) and a full day (409 day_full) are refused');

  // 8. demo payment: wrong key, right key, twice
  {
    const wrong = await detail('pay-demo', { bookingId: id1, payKey: 'nope' });
    assert(wrong.status === 404, `wrong payKey: ${wrong.status}`);
    const ok = await detail('pay-demo', { bookingId: id1, payKey: r1.body.payKey });
    assert(ok.status === 200 && ok.body.demo === true, `pay-demo: ${JSON.stringify(ok.body)}`);
    const again = await detail('pay-demo', { bookingId: id1, payKey: r1.body.payKey });
    assert(again.status === 409 && again.body.error === 'not_pending', `pay-demo twice: ${JSON.stringify(again.body)}`);
  }
  pass('8. pay-demo: wrong key 404, works once, second call 409 not_pending');

  // 9. dashboard view: demo deposit, never paid; photos; no secrets leaked
  {
    const bk = await owner('booking', { id: id1 });
    assert(bk.status === 200 && bk.body.flow === 'detail_v2', `booking: ${JSON.stringify(bk.body).slice(0, 200)}`);
    assert(bk.body.depositStatus === 'demo', `deposit status must be demo, got ${bk.body.depositStatus}`);
    assert(bk.body.status === 'requested' && bk.body.total === 175 && bk.body.paidOnline === 0, `booking numbers: ${JSON.stringify(bk.body)}`);
    assert(bk.body.customer.name === 'E2E TEST Customer', 'detail name shown');
    const dg = await owner('detail_get', { id: id1 });
    assert(dg.status === 200 && dg.body.photos.length === 1, `detail_get photos: ${JSON.stringify(dg.body).slice(0, 200)}`);
    assert(!JSON.stringify(dg.body).includes(r1.body.payKey), 'payKey must not reach the dashboard');
    assert(dg.body.invoice.servicePrice === 175 && dg.body.invoice.depositCredit === 0 && dg.body.invoice.balance === 175, `draft invoice (demo deposit = no credit): ${JSON.stringify(dg.body.invoice)}`);
    const img = await fetch(dg.body.photos[0]);
    assert(img.ok, `photo signed url: ${img.status}`);
  }
  pass('9. dashboard: deposit_status is demo (never paid), photo viewable, payKey hidden, draft invoice = 175 with no credit (no money was taken)');

  // 10. invoice rules
  {
    const early = await owner('invoice_pay', { id: id1, method: 'cash' });
    assert(early.status === 409, `pay while only requested should be refused, got ${early.status}`);
    const conf = await owner('confirm', { id: id1, day: dayA, slot: slot1 });
    assert(conf.status === 200, `confirm: ${JSON.stringify(conf.body)}`);
    for (const extras of [[{ name: 'Bad', price: -5 }], [{ name: 'Bad', price: 'x' }], [{ name: '', price: 5 }]]) {
      const bad = await owner('invoice_save', { id: id1, servicePrice: 200, extras });
      assert(bad.status === 400 && bad.body.error === 'bad_invoice', `bad extras ${JSON.stringify(extras)}: ${JSON.stringify(bad.body)}`);
    }
    const save = await owner('invoice_save', { id: id1, servicePrice: 200, extras: [{ name: 'Pet hair removal', price: 30 }] });
    assert(save.status === 200 && save.body.total === 230 && save.body.depositCredit === 0 && save.body.balance === 230 && save.body.status === 'draft',
      `invoice_save: ${JSON.stringify(save.body)}`);
    const changed = await owner('invoice_save', { id: id1, servicePrice: 210, extras: [{ name: 'Pet hair removal', price: 30 }] });
    assert(changed.status === 200 && changed.body.total === 240, `change price: ${JSON.stringify(changed.body)}`);
    const bk = await owner('booking', { id: id1 });
    assert(bk.body.total === 240 && bk.body.owing === 240, `dashboard follows the invoice: ${JSON.stringify({ t: bk.body.total, o: bk.body.owing })}`);
    const paid = await owner('invoice_pay', { id: id1, method: 'cash' });
    assert(paid.status === 200 && paid.body.total === 240 && paid.body.credit === 0 && paid.body.balance === 240 && paid.body.refundDue === 0, `pay: ${JSON.stringify(paid.body)}`);
    const twice = await owner('invoice_pay', { id: id1, method: 'cash' });
    assert(twice.status === 409 && twice.body.error === 'already_paid', `pay twice: ${JSON.stringify(twice.body)}`);
    const after = await owner('invoice_save', { id: id1, servicePrice: 1, extras: [] });
    assert(after.status === 409 && after.body.error === 'already_paid', 'no edits after paid');
    const fin = await owner('booking', { id: id1 });
    assert(fin.body.status === 'done' && fin.body.owing === 0 && fin.body.depositStatus === 'demo', `final state: ${JSON.stringify(fin.body)}`);
  }
  pass('10. invoice: no pay before the time is confirmed; bad extras refused; demo deposit gives no credit so the full 240 is collected; paying marks the job done; pay once; locked after paid; deposit stays demo');

  // 11. demo deposit: no credit, even on a tiny invoice
  {
    const r = await detail('reserve', body({ email: emailOf('cap'), service: 'exterior', day: dayC, slot: slot2 }));
    assert(r.status === 200 && r.body.quote.startingPrice === 40 && r.body.quote.deposit === 25, `exterior sedan: ${JSON.stringify(r.body.quote)}`);
    await detail('pay-demo', { bookingId: r.body.bookingId, payKey: r.body.payKey });
    await owner('confirm', { id: r.body.bookingId, day: dayC, slot: slot2 });
    const s2 = await owner('invoice_save', { id: r.body.bookingId, servicePrice: 20, extras: [] });
    assert(s2.body.total === 20 && s2.body.depositCredit === 0 && s2.body.balance === 20, `no credit: ${JSON.stringify(s2.body)}`);
    const p = await owner('invoice_pay', { id: r.body.bookingId, method: 'card' });
    assert(p.status === 200 && p.body.balance === 20, `pay: ${JSON.stringify(p.body)}`);
    // a paid invoice is locked even against a direct edit
    const edit = await owner('invoice_save', { id: r.body.bookingId, servicePrice: 5, extras: [] });
    assert(edit.status === 409 && edit.body.error === 'already_paid', `paid invoice must be locked: ${JSON.stringify(edit.body)}`);
  }
  pass('11. demo deposit gives no credit (a $20 invoice owes $20); a paid invoice cannot be edited');

  // 11b. closing the dialog releases the held time
  {
    const day = dayB; // free again: step 7 cleared its override
    const first = await detail('reserve', body({ email: emailOf('rel1'), day, slot: slot1 }));
    assert(first.status === 200, `reserve before release: ${JSON.stringify(first.body)}`);
    // a wrong key is a harmless no-op (it reveals nothing); what matters is it frees nothing
    const bad = await detail('release', { bookingId: first.body.bookingId, payKey: 'wrong' });
    assert(bad.status === 200 || bad.status === 404, `release with a wrong key: ${bad.status}`);
    const blocked = await detail('reserve', body({ email: emailOf('rel2'), day, slot: slot1 }));
    assert(blocked.status === 409 && blocked.body.error === 'slot_taken', 'a wrong-key release must NOT free the held slot');
    const rel = await detail('release', { bookingId: first.body.bookingId, payKey: first.body.payKey });
    assert(rel.status === 200, `release: ${rel.status}`);
    const again = await detail('reserve', body({ email: emailOf('rel2'), day, slot: slot1 }));
    assert(again.status === 200, `slot should be free after release: ${JSON.stringify(again.body)}`);
    const late = await detail('pay-demo', { bookingId: first.body.bookingId, payKey: first.body.payKey });
    assert(late.status === 409 && late.body.error === 'not_pending', `a released hold can't be paid: ${JSON.stringify(late.body)}`);
  }
  pass('11b. release frees the held slot (a wrong key frees nothing); a released hold cannot be paid');

  // 12. pricing editor round trip (restored afterwards)
  {
    const g = await owner('detail_pricing_get');
    assert(g.status === 200 && g.body.detailPricing?.deposits, `pricing_get: ${g.status}`);
    const original = g.body.detailPricing;
    cleanup.push(() => owner('detail_pricing_save', { detailPricing: original }));
    const edited = JSON.parse(JSON.stringify(original));
    edited.deposits.sedan = 26;
    const s = await owner('detail_pricing_save', { detailPricing: edited });
    assert(s.status === 200, `pricing_save: ${JSON.stringify(s.body)}`);
    const q = await detail('quote', { service: 'full', vehicleType: 'sedan' });
    assert(q.body.deposit === 26 && q.body.balance === 149, `edit reaches quote: ${JSON.stringify(q.body)}`);
    const broken = JSON.parse(JSON.stringify(original));
    broken.services.full.prices.sedan = 1.5;
    const b = await owner('detail_pricing_save', { detailPricing: broken });
    assert(b.status === 400, `fractional price must be refused, got ${b.status}`);
  }
  pass('12. pricing editor: edit reaches quote; invalid edit refused (400)');
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error(`FAIL: ${e.message}`);
} finally {
  console.log('\n--- cleanup ---');
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { console.error(`cleanup step failed: ${e.message}`); } }
  const c = await setup('cleanup', { emailLike: prefix });
  console.log(c.status === 200 && c.body.ok ? `removed test data (${c.body.bookings ?? 0} bookings)` : `cleanup failed: ${c.status} ${JSON.stringify(c.body)}`);
}
console.log(failed ? `\nFAILED after ${passes} passing steps` : `\nALL ${passes} STEPS PASSED`);
process.exit(failed ? 1 : 0);
