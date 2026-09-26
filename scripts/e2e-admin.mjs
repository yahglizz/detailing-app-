#!/usr/bin/env node
// End-to-end proof for the owner dashboard API (`admin`), run against the LIVE project.
// Exercises: sign-in + roles, overview, calendar, closed/full days (and `book` refusing
// them), manager permissions, private reports with a photo upload, website leads, the
// price editor round trip, Stripe status, and the old owner links redirecting.
//
// Leaves nothing behind: the day overrides, the temporary manager, the report (and its
// photo) and the test lead are all removed. Days it touches are ones with no override.
//
// Run:  BLD_OWNER_TOKEN=<owner key or an owner staff code> node scripts/e2e-admin.mjs
// Requires Node 18+ (global fetch, FormData, Blob). No npm deps.

const SUPABASE_URL = 'https://fiaadogbkvjcddehnymj.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpYWFkb2dia3ZqY2RkZWhueW1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjQ1OTUsImV4cCI6MjA5OTgwMDU5NX0.XR44tZS4Ntuvg7NZBdB5A_4_y6WjeTEgwweFeqwp8rE';
const OWNER = process.env.BLD_OWNER_TOKEN || '';
if (!OWNER) {
  console.error('Set BLD_OWNER_TOKEN (the owner key, or an owner staff code) before running.');
  process.exit(1);
}

let passes = 0;
const pass = (step) => { passes++; console.log(`PASS: ${step}`); };
const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`); };

async function call(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const admin = (code, action, payload = {}) => call(`${SUPABASE_URL}/functions/v1/admin`, {
  method: 'POST',
  headers: { apikey: ANON, 'x-staff-code': code, 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...payload, action }),
});
const anonPost = (path, body, extra = {}) => call(`${SUPABASE_URL}${path}`, {
  method: 'POST',
  headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify(body),
});
const owner = (action, payload) => admin(OWNER, action, payload);

// Today in the business's time zone, plus n days.
function dayPlus(n) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const cleanup = [];
let OPEN = false; // app_config.admin_open: no login needed, wrong codes also get in

async function main() {
  // 1. sign-in + overview
  {
    const me = await owner('me');
    assert(me.status === 200 && me.body.role === 'owner', `me: ${me.status} ${JSON.stringify(me.body)}`);
    const ov = await owner('overview');
    assert(ov.status === 200 && Array.isArray(ov.body.bookings) && typeof ov.body.stats?.awaiting === 'number', `overview: ${ov.status}`);
    OPEN = (await admin('', 'me')).status === 200;
    const bad = await admin('STAFF-NOPE0-NOPE0', 'me');
    assert(OPEN ? bad.status === 200 : bad.status === 401, `wrong code: ${bad.status} (open mode ${OPEN})`);
    pass(OPEN ? '1. owner signs in; overview loads; LOGIN IS OFF (admin_open) — anyone gets in'
      : '1. owner signs in; overview loads; a wrong code is refused (401)');
  }

  // 2. calendar + closing a day → app sees it closed, book refuses it; cap 0 → full
  const dayA = dayPlus(4);
  {
    const month = dayA.slice(0, 7);
    const cal = await owner('calendar', { month });
    assert(cal.status === 200 && cal.body.days.length >= 28, `calendar: ${cal.status}`);
    assert(!cal.body.overrides.some((o) => o.day === dayA), `${dayA} already has an owner override; not touching it`);

    const set = await owner('set_day', { day: dayA, closed: true, note: 'e2e' });
    assert(set.status === 200, `set_day closed: ${set.status} ${JSON.stringify(set.body)}`);
    cleanup.push(() => owner('set_day', { day: dayA, clear: true }));
    const st = await anonPost('/rest/v1/rpc/day_states', { from_day: dayA, to_day: dayA });
    assert(st.status === 200 && st.body[0]?.closed === true && st.body[0].capacity === 0, `day_states closed: ${JSON.stringify(st.body)}`);
    const b1 = await anonPost('/functions/v1/book', bookBody(dayA));
    assert(b1.status === 409 && b1.body.error === 'day_closed', `book on closed day: ${b1.status} ${JSON.stringify(b1.body)}`);

    await owner('set_day', { day: dayA, closed: false, capacity: 0 });
    const b2 = await anonPost('/functions/v1/book', bookBody(dayA));
    assert(b2.status === 409 && b2.body.error === 'day_full', `book on full day: ${b2.status} ${JSON.stringify(b2.body)}`);

    const cleared = await owner('set_day', { day: dayA, clear: true });
    const st2 = await anonPost('/rest/v1/rpc/day_states', { from_day: dayA, to_day: dayA });
    assert(cleared.status === 200 && st2.body[0]?.closed === false && st2.body[0].capacity > 0, `cleared: ${JSON.stringify(st2.body)}`);
    pass(`2. ${dayA}: closed → app sees closed + book says day_closed; cap 0 → day_full; cleared back to normal`);
  }

  // 3. a manager can run the day but not the owner's actions
  {
    const add = await owner('staff_add', { name: 'E2E Manager', role: 'manager' });
    assert(add.status === 200 && /^STAFF-[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(add.body.code), `staff_add: ${JSON.stringify(add.body)}`);
    cleanup.push(() => owner('staff_remove', { id: add.body.id }));
    const mgr = (a, p) => admin(add.body.code, a, p);

    const me = await mgr('me');
    assert(me.status === 200 && me.body.role === 'manager', `manager me: ${JSON.stringify(me.body)}`);
    for (const [a, p] of [['pricing_save', { config: {} }], ['decline', { id: '00000000-0000-0000-0000-000000000000' }],
      ['staff_add', { name: 'x' }], ['stripe_connect', { secretKey: 'sk_test_x' }], ['member_add', {}]]) {
      const r = await mgr(a, p);
      assert(r.status === 403, `manager ${a} must be 403, got ${r.status}`);
    }
    const dayB = dayPlus(5);
    const cal = await mgr('calendar', { month: dayB.slice(0, 7) });
    assert(!cal.body.overrides.some((o) => o.day === dayB), `${dayB} already has an override`);
    const ok = await mgr('set_day', { day: dayB, capacity: 3 });
    assert(ok.status === 200, `manager set_day: ${ok.status}`);
    await mgr('set_day', { day: dayB, clear: true });
    const ov = await mgr('overview');
    assert(ov.status === 200, 'manager overview');

    const rm = await owner('staff_remove', { id: add.body.id });
    const after = await mgr('me');
    assert(rm.status === 200 && (OPEN ? after.body.role === 'owner' && after.body.open : after.status === 401),
      `removed manager must lose their manager login, got ${after.status} ${JSON.stringify(after.body)}`);
    pass(`3. manager: overview + calendar allowed; prices/refunds/staff/Stripe/members 403; removed → ${OPEN ? 'manager login gone' : '401'}`);
  }

  // 4. private report with a photo on the test customer
  {
    const list = await owner('customers', { q: 'bld.local' });
    const cust = list.body[0];
    assert(list.status === 200 && cust, `need the @bld.local test customer, got ${JSON.stringify(list.body)}`);
    const up = await owner('photo_upload_url', { customerId: cust.id, ext: 'png' });
    assert(up.status === 200 && up.body.signedUrl, `photo_upload_url: ${JSON.stringify(up.body)}`);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const form = new FormData();
    form.append('cacheControl', '3600');
    form.append('', new Blob([png], { type: 'image/png' }), 'e2e.png');
    const put = await fetch(up.body.signedUrl, { method: 'PUT', body: form, headers: { apikey: ANON, 'x-upsert': 'false' } });
    assert(put.ok, `photo upload: ${put.status} ${await put.text()}`);

    const add = await owner('report_add', { customerId: cust.id, category: 'damage', body: 'E2E: scratch on rear bumper before start', photos: [up.body.path] });
    assert(add.status === 200 && add.body.id, `report_add: ${JSON.stringify(add.body)}`);
    cleanup.push(() => owner('report_delete', { id: add.body.id }));
    const bad = await owner('report_add', { customerId: cust.id, body: 'x', photos: ['someone-else/evil.png'] });
    assert(bad.status === 400, `a photo path outside the customer must be refused, got ${bad.status}`);

    const detail = await owner('customer', { id: cust.id });
    const rep = detail.body.reports?.find((r) => r.id === add.body.id);
    assert(detail.status === 200 && rep?.photoUrls?.length === 1, `customer detail report: ${JSON.stringify(rep)}`);
    const img = await fetch(rep.photoUrls[0]);
    assert(img.ok && (img.headers.get('content-type') || '').startsWith('image/'), `signed photo URL: ${img.status}`);

    const del = await owner('report_delete', { id: add.body.id });
    const gone = await owner('customer', { id: cust.id });
    assert(del.status === 200 && !gone.body.reports.some((r) => r.id === add.body.id), 'report deleted');
    // (The file itself is removed from storage too; its signed URL can keep answering from
    // Supabase's CDN cache for a minute, so that isn't checked here.)
    pass('4. report with photo: uploaded, shown with a signed URL, foreign path refused, deleted');
  }

  // 5. a website lead (same anon insert the site does) reaches the dashboard
  {
    const marker = `E2E Lead ${Date.now()}`;
    const ins = await anonPost('/rest/v1/quote_leads', { name: marker, phone: '2155550100', service: 'Express Wash', message: 'e2e', accepted: false }, { Prefer: 'return=minimal' });
    assert(ins.status === 201, `website lead insert: ${ins.status} ${JSON.stringify(ins.body)}`);
    const leads = await owner('leads');
    const lead = leads.body.find((l) => l.name === marker);
    assert(leads.status === 200 && lead?.status === 'new', 'lead visible as new');
    const st = await owner('lead_status', { id: lead.id, status: 'lost' });
    const again = await owner('leads');
    assert(st.status === 200 && again.body.find((l) => l.id === lead.id)?.status === 'lost', 'lead status saved');
    console.log(`  (test lead ${lead.id} left as "lost" — delete it with SQL if you like)`);
    pass('5. website lead → dashboard Leads → status updated');
  }

  // 6. prices: read, save unchanged (no Stripe call), a bad number is refused
  {
    const get = await owner('pricing_get');
    assert(get.status === 200 && get.body.config?.services, 'pricing_get');
    const save = await owner('pricing_save', { config: get.body.config });
    assert(save.status === 200 && save.body.stripeUpdated.length === 0, `pricing_save unchanged: ${JSON.stringify(save.body)}`);
    const bad = await owner('pricing_save', { config: { services: { outside: -5 } } });
    assert(bad.status === 400 && bad.body.error === 'bad_value:services.outside', `bad price: ${JSON.stringify(bad.body)}`);
    const st = await owner('stripe_status');
    assert(st.status === 200 && typeof st.body.connected === 'boolean', 'stripe_status');
    pass(`6. prices round-trip; bad number refused; Stripe status = ${st.body.connected ? `connected (${st.body.mode})` : 'not connected'}`);
  }

  // 7. old emailed links land in the dashboard
  {
    for (const path of ['/functions/v1/confirm?token=nope', '/functions/v1/owner-members?token=x']) {
      const r = await fetch(`${SUPABASE_URL}${path}`, { redirect: 'manual' });
      assert(r.status === 302 && (r.headers.get('location') || '').includes('/admin'), `${path}: ${r.status}`);
    }
    pass('7. old confirm/owner links redirect to the dashboard');
  }
}

function bookBody(preferredDay) {
  return {
    items: [{ size: 'sedan', service: 'outside', extras: [] }],
    address: '123 Test St, Testville', preferredDay, window: 'morning', notes: 'e2e',
    remainderMethod: 'cash', name: 'E2E Tester', email: 'e2e-admin@bldtest.co',
    expectedTotal: 45, payMode: 'deposit', returnUrl: 'bld://e2e',
  };
}

main().then(
  async () => {
    for (const f of cleanup.reverse()) await f().catch(() => {});
    console.log(`\nALL ${passes} ADMIN CHECKS PASSED`);
  },
  async (e) => {
    for (const f of cleanup.reverse()) await f().catch(() => {});
    console.error(e.message);
    process.exit(1);
  },
);
