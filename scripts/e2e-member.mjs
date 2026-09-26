#!/usr/bin/env node
// End-to-end acceptance proof for BLD member mode + prepaid balance, run against the
// LIVE Supabase project. Exercises: member creation via the owner page, credit-covered
// bookings, member prices, balance-paid bookings, rank-based bumping, slot anchors,
// booking-window enforcement, stamps per car, reward redemption, equal-rank
// escalation, and the credit / reward / balance give-back on decline.
//
// Nothing here pays through Stripe: every booking is covered by member credits or a
// test balance (e2e-setup wallet-credit), so nothing is due at checkout. The test days
// are picked from days with no bookings at all, so no real customer is ever bumped.
// Exits non-zero on the first failed assertion; test data is deleted at the end.
//
// Run:  BLD_OWNER_TOKEN=<token> node scripts/e2e-member.mjs
// Requires Node 18+ (global fetch). No npm deps.

const SUPABASE_URL = 'https://fiaadogbkvjcddehnymj.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpYWFkb2dia3ZqY2RkZWhueW1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjQ1OTUsImV4cCI6MjA5OTgwMDU5NX0.XR44tZS4Ntuvg7NZBdB5A_4_y6WjeTEgwweFeqwp8rE';
// Owner admin token is a secret — never hardcode it. Provide it at run time:
//   BLD_OWNER_TOKEN=<token> node scripts/e2e-member.mjs
// (read it from the DB: select value from app_config where key='owner_admin_token';)
const OWNER_ADMIN_TOKEN = process.env.BLD_OWNER_TOKEN || '';
if (!OWNER_ADMIN_TOKEN) {
  console.error('Set BLD_OWNER_TOKEN env var (owner admin token) before running.');
  process.exit(1);
}

const prefix = `bld-e2e-${Date.now()}`;
const emails = {
  gold1: `${prefix}-gold@bldtest.co`,
  nm: `${prefix}-nm@bldtest.co`,
  gold2: `${prefix}-gold2@bldtest.co`,
  refund: `${prefix}-refund@bldtest.co`,
};

let passCount = 0;
function pass(step) {
  passCount++;
  console.log(`PASS: ${step}`);
}
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

// ——— low-level HTTP helpers ———

async function jsonFetch(url, opts) {
  const res = await fetch(url, opts);
  let body;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

function jsonPost(url, payload) {
  return jsonFetch(url, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function setup(action, args) {
  const { status, body } = await jsonPost(`${SUPABASE_URL}/functions/v1/e2e-setup`, { token: OWNER_ADMIN_TOKEN, action, ...args });
  if (status !== 200 || !body.ok) throw new Error(`e2e-setup ${action} failed: ${status} ${JSON.stringify(body)}`);
  return body;
}

// Test balance for an @bldtest.co account; returns the code it logs in with.
async function walletCredit(email, amount) {
  return (await setup('wallet-credit', { email, amount })).code;
}

// Code-holders (members / balance accounts) book here, so nothing is ever due.
function bookBody({ preferredDay, timeSlot, code, anchor, email, expectedTotal = 120, window = 'morning' }) {
  const body = {
    items: [{ size: 'sedan', service: 'full', extras: [] }],
    address: '123 Test St, Testville',
    preferredDay,
    timeSlot,
    window,
    notes: 'e2e run',
    remainderMethod: 'cash',
    name: 'E2E Tester',
    expectedTotal,
    payMode: 'deposit',
    returnUrl: 'bld://e2e',
  };
  if (code) body.memberCode = code;
  if (email) body.email = email;
  if (anchor) body.anchor = true;
  return body;
}

function book(args) {
  return jsonPost(`${SUPABASE_URL}/functions/v1/book`, bookBody(args));
}

async function memberCall(payload) {
  return jsonFetch(`${SUPABASE_URL}/functions/v1/member`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function ownerMembersPost(params) {
  const url = `${SUPABASE_URL}/functions/v1/owner-members?token=${OWNER_ADMIN_TOKEN}`;
  const form = new URLSearchParams(params);
  const res = await fetch(url, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return { status: res.status, text: await res.text() };
}

async function ownerMembersGet() {
  const url = `${SUPABASE_URL}/functions/v1/owner-members?token=${OWNER_ADMIN_TOKEN}`;
  const res = await fetch(url, { headers: { apikey: ANON } });
  return { status: res.status, text: await res.text() };
}

async function ownerAddMember(name, email, tier) {
  const { status, text } = await ownerMembersPost({ action: 'add', name, email, tier });
  if (status !== 200) throw new Error(`ownerAddMember(${email}) http ${status}: ${text.slice(0, 300)}`);
  const m = text.match(/BLD-[A-Z2-9]{6}/);
  if (!m) throw new Error(`ownerAddMember(${email}) no code found in response: ${text.slice(0, 500)}`);
  return m[0];
}

function extractMembershipId(html, code) {
  const cards = html.split('<div class="card">');
  for (const card of cards) {
    if (card.includes(code)) {
      const m = card.match(/name="id" value="([^"]+)"/);
      if (m) return m[1];
    }
  }
  return null;
}

async function bookingToken(bookingId) {
  const body = await setup('booking-token', { bookingId });
  if (!body.confirmToken) throw new Error(`bookingToken(${bookingId}) returned no confirm_token: ${JSON.stringify(body)}`);
  return body.confirmToken;
}

async function confirmDecline(confirmToken) {
  const form = new URLSearchParams({ token: confirmToken, action: 'decline' });
  const res = await fetch(`${SUPABASE_URL}/functions/v1/confirm`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return { status: res.status, text: await res.text() };
}

async function slotStates(day) {
  const { status, body } = await jsonPost(`${SUPABASE_URL}/rest/v1/rpc/slot_states`, { day });
  if (status !== 200) throw new Error(`slot_states(${day}) failed: ${status} ${JSON.stringify(body)}`);
  return body;
}

// YYYY-MM-DD, `n` days from today (UTC, like book's booking window).
function dayPlus(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The first day in [from, to] with no booked slot at all, skipping days already taken
// for this run. Test bookings bump whoever holds a slot, so they only go on empty days.
async function emptyDay(from, to, used) {
  for (let n = from; n <= to; n++) {
    const day = dayPlus(n);
    if (used.includes(day)) continue;
    if ((await slotStates(day)).length === 0) { used.push(day); return day; }
  }
  throw new Error(`no empty day between +${from} and +${to} days: refusing to risk bumping a real customer`);
}

function cleanup() {
  return jsonPost(`${SUPABASE_URL}/functions/v1/e2e-setup`, { token: OWNER_ADMIN_TOKEN, action: 'cleanup', emailLike: prefix });
}

// ——— test sequence ———

async function profile(code) {
  const { status, body } = await memberCall({ code });
  assert(status === 200, `member(${code}) http ${status}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  // Step 1: owner adds 3 gold members; a non-member loads a test balance.
  const code1 = await ownerAddMember('E2E Gold One', emails.gold1, 'gold');
  const code3 = await ownerAddMember('E2E Gold Two', emails.gold2, 'gold');
  const codeR = await ownerAddMember('E2E Refund Gold', emails.refund, 'gold');
  for (const c of [code1, code3, codeR]) assert(/^BLD-[A-Z2-9]{6}$/.test(c), `code malformed: ${c}`);
  const nmCode = await walletCredit(emails.nm, 500);
  assert(/^BLD-[A-Z2-9]{6}$/.test(nmCode), `balance account code malformed: ${nmCode}`);
  pass(`1. owner added 3 gold members; non-member balance account ${nmCode} loaded $500`);

  // Step 2: profiles
  {
    const p = await profile(code1);
    assert(p.credits === 2 && p.stamps === 0 && p.wallet === 0, `expected credits 2, stamps 0, wallet 0, got ${JSON.stringify(p)}`);
    assert(p.isTest === false, 'a real member must not be a test account');
    const n = await profile(nmCode);
    assert(n.member.tier === null && n.wallet === 500, `expected non-member with $500, got ${JSON.stringify(n.member)} wallet ${n.wallet}`);
    pass('2. member(code1) credits 2 / stamps 0 / wallet 0; balance account has no tier and $500');
  }

  // Test days: D1/D2 inside the 7-day public window, DR inside the 30-day member window.
  const used = [];
  const D1 = await emptyDay(1, 6, used);
  const D2 = await emptyDay(1, 6, used);
  const D3 = await emptyDay(8, 29, used);
  const DR = await emptyDay(8, 29, used);
  pass(`3. empty test days: ${D1}, ${D2}, ${D3}, ${DR}`);

  // Step 4: non-member books D1 10:00, paid from the balance (nothing due).
  {
    const { status, body } = await book({ preferredDay: D1, timeSlot: '10:00', code: nmCode });
    assert(status === 200 && body.paid === true, `non-member book http ${status}: ${JSON.stringify(body)}`);
    assert(body.walletUsed === 120 && body.payable === 120, `expected $120 from the balance, got ${JSON.stringify(body)}`);
    assert(body.quote.tier === null && body.quote.savings === 0, `non-member must pay retail, got ${JSON.stringify(body.quote)}`);
    pass(`4. non-member booked ${D1} 10:00, $120 paid from balance`);
  }

  // Step 5: gold member (code1) books the SAME slot -> bump; a credit covers it.
  let goldBookingId;
  {
    const { status, body } = await book({ preferredDay: D1, timeSlot: '10:00', code: code1 });
    assert(status === 200 && body.paid === true, `gold member book http ${status}: ${JSON.stringify(body)}`);
    assert(body.creditsUsed === 1 && body.payable === 0, `expected creditsUsed 1 / payable 0, got ${JSON.stringify(body)}`);
    assert(body.quote.savings === 120, `expected savings 120 with a credit, got ${body.quote.savings}`);
    goldBookingId = body.bookingId;
    pass('5. gold member took 10:00 with a credit, payable 0, savings 120');
  }

  // Step 6: slot_states — gold holds 10:00, the non-member was bumped to 11:00.
  {
    const states = await slotStates(D1);
    const slot10 = states.find((s) => s.slot === '10:00');
    const slot11 = states.find((s) => s.slot === '11:00');
    assert(slot10 && slot10.rank === 3, `expected 10:00 rank 3, got ${JSON.stringify(slot10)}`);
    assert(slot11 && slot11.rank === 0, `expected 11:00 rank 0 (bumped non-member), got ${JSON.stringify(slot11)}`);
    pass('6. slot_states: 10:00 rank 3 (gold), 11:00 rank 0 (bumped non-member)');
  }

  // Step 7: member credits 1
  {
    const p = await profile(code1);
    assert(p.credits === 1, `expected credits 1, got ${p.credits}`);
    pass('7. member(code1) credits 1');
  }

  // Step 8: non-member anchors D2 09:00 (+$10); gold member is blocked from it.
  {
    const { status, body } = await book({ preferredDay: D2, timeSlot: '09:00', code: nmCode, anchor: true });
    assert(status === 200, `non-member anchor book http ${status}: ${JSON.stringify(body)}`);
    assert(body.payable === 130 && body.walletUsed === 130, `expected 130 (120 + 10 anchor) from balance, got ${JSON.stringify(body)}`);
    const n = await profile(nmCode);
    assert(n.wallet === 250, `expected balance 500 - 120 - 130 = 250, got ${n.wallet}`);
    pass('8a. non-member anchored 09:00, $130 from balance, balance now $250');

    const { status: s2, body: b2 } = await book({ preferredDay: D2, timeSlot: '09:00', code: code1 });
    assert(s2 === 409 && b2.error === 'slot_taken', `expected 409 slot_taken, got ${s2}: ${JSON.stringify(b2)}`);
    pass('8b. gold member blocked by anchored slot -> 409 slot_taken');
  }

  // Step 9: owner marks the gold booking done -> Gold earns 3 stamps per car.
  {
    const { status, text } = await ownerMembersPost({ action: 'done', id: goldBookingId });
    assert(status === 200, `owner done http ${status}: ${text.slice(0, 300)}`);
    const p = await profile(code1);
    assert(p.stamps === 3, `expected 3 stamps (Gold, 1 car), got ${p.stamps}`);
    const again = await ownerMembersPost({ action: 'done', id: goldBookingId });
    assert(again.status === 200 && (await profile(code1)).stamps === 3, 'a second done must not grant stamps again');
    pass('9. done granted 3 stamps (Gold x1 car); a repeat done granted none');
  }

  // Step 10: redeem tireShine
  {
    const p = await profile(code1);
    const cost = p.rewardMenu.find((r) => r.key === 'tireShine')?.cost;
    assert(cost && cost <= p.stamps, `tireShine cost ${cost} vs stamps ${p.stamps}`);
    const { status: rs, body: rb } = await memberCall({ code: code1, action: 'redeem', reward: 'tireShine' });
    assert(rs === 200 && rb.ok, `redeem tireShine failed: ${rs} ${JSON.stringify(rb)}`);
    const after = await profile(code1);
    assert(after.issuedRewards.length === 1 && after.stamps === p.stamps - cost, `expected 1 issued reward and ${p.stamps - cost} stamps, got ${after.issuedRewards.length} / ${after.stamps}`);
    pass(`10. redeemed tireShine (${cost} stamps), issuedRewards 1`);
  }

  // Step 11: gold books again; the last credit covers it, so the reward is kept.
  {
    const { status, body } = await book({ preferredDay: D3, timeSlot: '09:00', code: code1 });
    assert(status === 200 && body.payable === 0 && body.creditsUsed === 1, `gold 2nd book: ${status} ${JSON.stringify(body)}`);
    const p = await profile(code1);
    assert(p.credits === 0, `expected credits 0, got ${p.credits}`);
    assert(p.issuedRewards.length === 1, `reward only applies when something is payable; got ${p.issuedRewards.length} issued`);
    pass(`11. gold booked ${D3} with the last credit; reward kept (nothing payable)`);
  }

  // Step 12: equal-rank escalation — gold #2 books the slot gold #1 holds.
  {
    const { status, body } = await book({ preferredDay: D1, timeSlot: '10:00', code: code3 });
    assert(status === 200 && body.escalated === true, `expected escalated, got ${status} ${JSON.stringify(body)}`);
    const holders10 = (await slotStates(D1)).filter((s) => s.slot === '10:00');
    assert(holders10.length === 1 && holders10[0].rank === 3, `expected 1 holder at 10:00 (rank 3), got ${JSON.stringify(holders10)}`);
    pass('12. equal-rank escalation: escalated, no slot taken (10:00 still 1 holder)');
  }

  // Step 13: booking windows (checked before any payment)
  {
    const far = dayPlus(31);
    const { status, body } = await book({ preferredDay: far, timeSlot: '09:00', code: code1 });
    assert(status === 400 && body.error === 'too_far_out', `member +31 days: ${status} ${JSON.stringify(body)}`);
    pass('13a. member +31 days -> 400 too_far_out');

    const { status: s2, body: b2 } = await book({ preferredDay: dayPlus(8), timeSlot: '09:00', code: nmCode });
    assert(s2 === 400 && b2.error === 'too_far_out', `non-member +8 days: ${s2} ${JSON.stringify(b2)}`);
    pass('13b. non-member +8 days -> 400 too_far_out');
  }

  // Step 15: declining a member booking gives back credits, the reward, and the balance.
  {
    // 15a/b: credit wash, then the owner declines it -> credit back.
    const { status, body } = await book({ preferredDay: DR, timeSlot: '09:00', code: codeR });
    assert(status === 200 && body.creditsUsed === 1 && body.payable === 0, `credit wash: ${status} ${JSON.stringify(body)}`);
    assert((await profile(codeR)).credits === 1, 'expected credits 1 after the credit wash');
    const { status: ds } = await confirmDecline(await bookingToken(body.bookingId));
    assert(ds === 200, `decline http ${ds}`);
    assert((await profile(codeR)).credits === 2, 'expected the credit back after decline');
    pass('15a. credit wash declined -> credits back to 2');

    // 15b: use both credits, earn + redeem a reward, load a balance.
    for (const slot of ['10:00', '11:00']) {
      const w = await book({ preferredDay: DR, timeSlot: slot, code: codeR });
      assert(w.status === 200 && w.body.creditsUsed === 1, `exhaust wash ${slot}: ${w.status} ${JSON.stringify(w.body)}`);
    }
    const { text: html } = await ownerMembersGet();
    const membershipIdR = extractMembershipId(html, codeR);
    assert(membershipIdR, `could not scrape membershipId for ${codeR}`);
    const cost = (await profile(codeR)).rewardMenu.find((r) => r.key === 'tireShine').cost;
    for (let i = 0; i < cost; i++) await ownerMembersPost({ action: 'stamp', id: membershipIdR });
    const redeem = await memberCall({ code: codeR, action: 'redeem', reward: 'tireShine' });
    assert(redeem.status === 200 && redeem.body.ok, `redeem failed: ${redeem.status} ${JSON.stringify(redeem.body)}`);
    await walletCredit(emails.refund, 200);
    const before = await profile(codeR);
    assert(before.credits === 0 && before.issuedRewards.length === 1 && before.wallet === 200, `setup: ${JSON.stringify({ c: before.credits, r: before.issuedRewards.length, w: before.wallet })}`);
    pass('15b. credits used up, 1 reward issued, $200 balance');

    // 15c: a paid wash — Gold price 20% off $120 = $96, all from the balance; reward attaches.
    const paid = await book({ preferredDay: DR, timeSlot: '12:00', code: codeR });
    assert(paid.status === 200 && paid.body.paid === true, `paid wash: ${paid.status} ${JSON.stringify(paid.body)}`);
    assert(paid.body.payable === 96 && paid.body.walletUsed === 96, `expected Gold price $96 from balance, got ${JSON.stringify(paid.body)}`);
    assert(paid.body.quote.memberDiscount === 24 && paid.body.quote.savings === 24, `expected $24 member discount/savings, got ${JSON.stringify(paid.body.quote)}`);
    const mid = await profile(codeR);
    assert(mid.wallet === 104 && mid.issuedRewards.length === 0, `expected balance 104 and reward attached, got ${mid.wallet} / ${mid.issuedRewards.length}`);
    pass('15c. Gold price $96 (saved $24) paid from balance; reward attached');

    // 15d: decline -> reward re-issued and the $96 back on the balance.
    const { status: ds2 } = await confirmDecline(await bookingToken(paid.body.bookingId));
    assert(ds2 === 200, `decline http ${ds2}`);
    const after = await profile(codeR);
    assert(after.issuedRewards.length === 1, `expected the reward back, got ${after.issuedRewards.length}`);
    assert(after.wallet === 200, `expected the balance back to 200, got ${after.wallet}`);
    pass('15d. decline gave back the reward and the $96 balance');
  }

  // Step 16: guests and test-only actions.
  {
    // A guest must type a valid email.
    const { status, body } = await book({ preferredDay: D2, timeSlot: '12:00', email: 'not-an-email' });
    assert(status === 400 && body.error === 'bad_email', `guest bad email: ${status} ${JSON.stringify(body)}`);
    // A real member's code can't use the test-account tier switcher.
    const t = await memberCall({ code: code1, action: 'test_tier', tier: 'silver' });
    assert(t.status === 403, `test_tier on a real member must be 403, got ${t.status} ${JSON.stringify(t.body)}`);
    pass('16. guest bad email -> 400; test_tier on a real member -> 403');
  }

  console.log(`\nALL PASSED (${passCount} steps)`);
}

main()
  .catch((err) => {
    console.error(`\nFAIL: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    console.log('\n--- cleanup ---');
    try {
      const { status, body } = await cleanup();
      if (status !== 200 || !body.ok) {
        console.error(`cleanup failed: ${status} ${JSON.stringify(body)}`);
        process.exitCode = 1;
        return;
      }
      const total = (body.deleted.customers ?? 0) + (body.deleted.bookings ?? 0) + (body.deleted.members ?? 0);
      if (total <= 0) {
        console.error(`cleanup deleted nothing: ${JSON.stringify(body.deleted)}`);
        process.exitCode = 1;
        return;
      }
      console.log(`PASS: 14. cleanup deleted ${JSON.stringify(body.deleted)}`);
    } catch (e) {
      console.error(`cleanup threw: ${e.message}`);
      process.exitCode = 1;
    }
  });
