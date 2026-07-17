import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  computeSavings, monthsActive, REWARD_LABELS,
  type MemberCatalog, type RewardKey,
} from '../_shared/membership.ts';
import { sendEmail, ownerEmail } from '../_shared/notify.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  let body: { code?: string; action?: string; reward?: RewardKey };
  try { body = await req.json(); } catch { return Response.json({ error: 'bad_json' }, { status: 400 }); }
  const code = (body.code ?? '').trim().toUpperCase();
  if (!/^BLD-[A-Z2-9]{6}$/.test(code)) return Response.json({ error: 'invalid_code' }, { status: 404 });

  const { data: m } = await db
    .from('memberships')
    .select('id, tier, active, period_start, customer_id, customers(name, email)')
    .eq('code', code)
    .single();
  if (!m) return Response.json({ error: 'invalid_code' }, { status: 404 });
  if (!m.active) return Response.json({ error: 'inactive' }, { status: 403 });

  const { data: cat } = await db.from('catalog').select('config').eq('id', 1).single();
  const cfg = cat!.config as MemberCatalog;
  const plan = cfg.plans[m.tier as keyof typeof cfg.plans];

  if (body.action === 'redeem') {
    const reward = body.reward as RewardKey;
    if (!cfg.rewards[reward]) return Response.json({ error: 'unknown_reward' }, { status: 400 });
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
    const cust = m.customers as unknown as { name: string; email: string };
    await sendEmail(ownerEmail(), `Upgrade request — ${cust.name || cust.email} (${m.tier})`,
      `<h2 style="color:#A855F7;margin:0 0 12px">Member wants to upgrade</h2>
       <p><b>${cust.name || 'Member'}</b> (${cust.email}, code ${code}, current tier ${m.tier}) tapped Upgrade.
       Call them, take payment, then change their tier on your members page.</p>`);
    return Response.json({ ok: true });
  }

  // Default action: full profile.
  const [{ data: creditRows }, { data: stampRows }, { data: issued }, { data: history }] = await Promise.all([
    db.from('credit_ledger').select('delta').eq('membership_id', m.id),
    db.from('reward_ledger').select('delta').eq('membership_id', m.id),
    db.from('redemptions').select('id, reward').eq('membership_id', m.id).eq('status', 'issued'),
    db.from('bookings').select('id, preferred_day, time_slot, status, quote, paid_with_credit')
      .eq('membership_id', m.id).order('created_at', { ascending: false }).limit(20),
  ]);
  const credits = (creditRows ?? []).reduce((s, r) => s + r.delta, 0);
  const stamps = (stampRows ?? []).reduce((s, r) => s + r.delta, 0);

  // Dollar value saved on every live member booking: retail total minus what was
  // actually payable. Captures credit-covered washes AND reward discounts
  // (percent25 / freeWash), which reduce payable without setting paid_with_credit.
  const bookingSavings = (history ?? [])
    .filter((b) => !['declined', 'refunded', 'pending_payment'].includes(b.status))
    .reduce((s, b) => {
      const q = b.quote as { total: number; payable?: number };
      return s + (q.total - (q.payable ?? q.total));
    }, 0);
  const { data: applied } = await db.from('redemptions').select('retail_value').eq('membership_id', m.id);
  const rewardsRetail = (applied ?? []).reduce((s, r) => s + r.retail_value, 0);
  const today = new Date().toISOString().slice(0, 10);
  const months = monthsActive(String(m.period_start), today);
  const savings = computeSavings({ creditWashRetail: bookingSavings, rewardsRetail, months, monthlyPrice: plan.price });

  const cust = m.customers as unknown as { name: string; email: string };
  return Response.json({
    member: { name: cust.name, email: cust.email, tier: m.tier, active: m.active, periodStart: m.period_start },
    credits, stamps, savings,
    rewardMenu: (Object.keys(cfg.rewards) as RewardKey[]).map((key) => ({ key, label: REWARD_LABELS[key], cost: cfg.rewards[key] })),
    issuedRewards: (issued ?? []).map((r) => ({ id: r.id, reward: r.reward, label: REWARD_LABELS[r.reward as RewardKey] })),
    history: (history ?? []).map((b) => ({
      id: b.id, day: b.preferred_day, slot: b.time_slot, status: b.status,
      total: (b.quote as { total: number }).total, paidWithCredit: b.paid_with_credit,
    })),
  });
});
