// The app's account screen. A code opens it: a member code, or the account code of
// someone who loaded a balance without joining (and a lapsed member's old code still
// opens their balance). Actions: redeem / upgrade (members), save_settings (everyone),
// and test_tier / test_balance for owner test accounts only.
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  cleanSettings, computeSavings, monthsActive, REWARD_LABELS,
  type MemberCatalog, type RewardKey, type SavedCar, type Tier,
} from '../_shared/membership.ts';
import { esc, sendEmail, ownerEmail } from '../_shared/notify.ts';
import { clientIp, resolveCode } from '../_shared/codes.ts';
import { walletBalance } from '../_shared/wallet.ts';

const TIERS: Tier[] = ['bronze', 'silver', 'gold'];

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  let body: { code?: string; action?: string; reward?: RewardKey; settings?: unknown; tier?: string };
  try { body = await req.json(); } catch { return Response.json({ error: 'bad_json' }, { status: 400 }); }

  const acct = await resolveCode(db, body.code, clientIp(req));
  if (acct === 'rate_limited') return Response.json({ error: 'rate_limited' }, { status: 429 });
  if (acct === 'invalid_code') return Response.json({ error: 'invalid_code' }, { status: 404 });
  const m = acct.membership; // null = not a member (a balance account)

  const { data: cat } = await db.from('catalog').select('config').eq('id', 1).single();
  const cfg = cat!.config as MemberCatalog;

  if (body.action === 'redeem') {
    if (!m) return Response.json({ error: 'not_member' }, { status: 403 });
    const reward = body.reward as RewardKey;
    if (!Object.hasOwn(cfg.rewards, reward)) return Response.json({ error: 'unknown_reward' }, { status: 400 });
    const cost = cfg.rewards[reward];
    const { data: bal } = await db.from('reward_ledger').select('delta').eq('membership_id', m.id);
    const stamps = (bal ?? []).reduce((s, r) => s + r.delta, 0);
    if (stamps < cost) return Response.json({ error: 'not_enough_stamps' }, { status: 400 });
    const { data: spent, error: spendErr } = await db.from('reward_ledger').insert({
      membership_id: m.id, delta: -cost, reason: `redeem:${reward}`,
    }).select('id').single();
    if (spendErr || !spent) return Response.json({ error: 'not_enough_stamps' }, { status: 400 });
    const { error: issueErr } = await db.from('redemptions').insert({
      membership_id: m.id, reward, stamps_spent: cost,
      retail_value: cfg.rewardValues[reward] ?? 0,
    });
    if (issueErr) {
      // Stamps were debited but the voucher didn't record — give the stamps back
      // so the member is never left with "stamps gone, no reward".
      await db.from('reward_ledger').insert({ membership_id: m.id, delta: cost, reason: `redeem_rollback:${reward}` });
      return Response.json({ error: 'redeem_failed' }, { status: 500 });
    }
    return Response.json({ ok: true, stamps: stamps - cost });
  }

  if (body.action === 'upgrade') {
    if (!m) return Response.json({ error: 'not_member' }, { status: 403 });
    const { data: cust } = await db.from('customers').select('name, email').eq('id', acct.customerId).single();
    await sendEmail(ownerEmail(), `Upgrade request — ${esc(cust?.name || cust?.email)} (${m.tier})`,
      `<h2 style="color:#A855F7;margin:0 0 12px">Member wants to upgrade</h2>
       <p><b>${esc(cust?.name) || 'Member'}</b> (${esc(cust?.email)}, code ${acct.code}, current tier ${m.tier}) tapped Upgrade.
       Call them, take payment, then change their tier on your members page.</p>`);
    return Response.json({ ok: true });
  }

  if (body.action === 'save_settings') {
    const r = cleanSettings(body.settings);
    if (!r.ok) return Response.json({ error: r.error }, { status: 400 });
    const { error } = await db.from('customers').update(r.patch).eq('id', acct.customerId);
    if (error) return Response.json({ error: 'save_failed' }, { status: 500 });
    return Response.json({ ok: true, ...r.patch });
  }

  // ——— owner test accounts: flip between every membership view, add play money ———
  if (body.action === 'test_tier' || body.action === 'test_balance') {
    if (!acct.isTest) return Response.json({ error: 'not_test' }, { status: 403 });
    if (body.action === 'test_balance') {
      const { error } = await db.from('wallet_ledger').insert({ customer_id: acct.customerId, delta: 50, reason: 'test credit' });
      return error ? Response.json({ error: 'save_failed' }, { status: 500 }) : Response.json({ ok: true });
    }
    const tier = body.tier as Tier | 'none';
    if (tier !== 'none' && !TIERS.includes(tier)) return Response.json({ error: 'unknown_tier' }, { status: 400 });
    const patch = tier === 'none'
      ? { active: false }
      : { active: true, tier, plan: tier, credits_per_period: cfg.plans[tier].credits };
    const { error } = await db.from('memberships').update(patch).eq('code', acct.code).eq('is_test', true);
    return error ? Response.json({ error: 'save_failed' }, { status: 500 }) : Response.json({ ok: true });
  }

  // ——— default: the profile ———
  const [{ data: cust }, wallet, { data: history }] = await Promise.all([
    db.from('customers').select('name, email, address, cars').eq('id', acct.customerId).single(),
    walletBalance(db, acct.customerId),
    db.from('bookings').select('id, preferred_day, time_slot, status, quote, paid_with_credit, membership_id')
      .eq('customer_id', acct.customerId).order('created_at', { ascending: false }).limit(20),
  ]);

  let credits = 0, stamps = 0, savings = 0;
  let issued: { id: string; reward: string }[] = [];
  if (m) {
    const [{ data: creditRows }, { data: stampRows }, { data: iss }, { data: applied }] = await Promise.all([
      db.from('credit_ledger').select('delta').eq('membership_id', m.id),
      db.from('reward_ledger').select('delta').eq('membership_id', m.id),
      // Oldest-first so issuedRewards[0] is the one `book` will actually apply
      // (book picks .order('created_at').limit(1)) — keeps the app's shown
      // discount matching the server's charge.
      db.from('redemptions').select('id, reward').eq('membership_id', m.id).eq('status', 'issued').order('created_at'),
      db.from('redemptions').select('retail_value').eq('membership_id', m.id),
    ]);
    credits = (creditRows ?? []).reduce((s, r) => s + r.delta, 0);
    stamps = (stampRows ?? []).reduce((s, r) => s + r.delta, 0);
    issued = iss ?? [];
    // Dollars saved on every live booking made as this member: retail total minus what
    // was payable. Covers credits, rewards and the tier's member price alike.
    const bookingSavings = (history ?? [])
      .filter((b) => b.membership_id === m.id && !['declined', 'refunded', 'pending_payment'].includes(b.status))
      .reduce((s, b) => {
        const q = b.quote as { total: number; payable?: number };
        return s + (q.total - (q.payable ?? q.total));
      }, 0);
    const rewardsRetail = (applied ?? []).reduce((s, r) => s + r.retail_value, 0);
    const months = monthsActive(String(m.period_start), new Date().toISOString().slice(0, 10));
    savings = computeSavings({ creditWashRetail: bookingSavings, rewardsRetail, months, monthlyPrice: cfg.plans[m.tier].price });
  }

  const c = cust as { name: string; email: string; address: string; cars: SavedCar[] };
  return Response.json({
    member: {
      name: c.name, email: c.email, tier: m?.tier ?? null, active: !!m, periodStart: m?.period_start ?? null,
      address: c.address ?? '', cars: c.cars ?? [],
    },
    wallet, isTest: acct.isTest,
    credits, stamps, savings,
    rewardMenu: m ? (Object.keys(cfg.rewards) as RewardKey[]).map((key) => ({ key, label: REWARD_LABELS[key], cost: cfg.rewards[key] })) : [],
    issuedRewards: issued.map((r) => ({ id: r.id, reward: r.reward, label: REWARD_LABELS[r.reward as RewardKey] })),
    history: (history ?? []).map((b) => ({
      id: b.id, day: b.preferred_day, slot: b.time_slot, status: b.status,
      total: (b.quote as { total: number }).total, paidWithCredit: b.paid_with_credit,
    })),
  });
});
