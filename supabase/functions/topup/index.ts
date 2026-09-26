// Loads prepaid balance through Stripe Checkout, any whole-dollar amount in the catalog's
// range. With a code (logged in) the money goes to that account, plus the member's tier
// bonus. Without one it goes to the account for the email typed, and the login code is
// only ever emailed there — typing someone else's email just gifts them money. When the
// customer comes back from checkout the app calls this again with action 'settle'.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { getProvider } from '../_shared/payments/provider.ts';
import { APP_LINK } from '../_shared/payments/checkout.ts';
import { functionsBaseUrl } from '../_shared/notify.ts';
import { topupBonus, type MemberCatalog } from '../_shared/membership.ts';
import { clientIp, resolveCode } from '../_shared/codes.ts';
import { cancelTopup, settleTopup } from '../_shared/wallet.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  let raw: Record<string, unknown>;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object') return Response.json({ error: 'bad_json' }, { status: 400 });
  if (raw.action === 'settle') return settle(db, raw);

  const { data: cat, error: catErr } = await db.from('catalog').select('config').eq('id', 1).single();
  if (catErr) return Response.json({ error: 'catalog_unavailable' }, { status: 500 });
  const cfg = cat.config as MemberCatalog;
  const min = cfg.topup?.min ?? 10, max = cfg.topup?.max ?? 500;
  const amount = Number(raw.amount);
  if (!Number.isInteger(amount) || amount < min || amount > max) {
    return Response.json({ error: 'bad_amount', min, max }, { status: 400 });
  }
  const returnUrl = String(raw.returnUrl ?? '');
  if (returnUrl.length > 300 || !APP_LINK.test(returnUrl)) return Response.json({ error: 'bad_return_url' }, { status: 400 });
  const pay = await getProvider(db);
  if (!pay) return Response.json({ error: 'payments_not_configured' }, { status: 503 });

  // ——— whose balance ———
  let customerId: string;
  let email: string;
  let bonus = 0;
  if (raw.code) {
    const acct = await resolveCode(db, raw.code, clientIp(req));
    if (acct === 'rate_limited') return Response.json({ error: 'rate_limited' }, { status: 429 });
    if (acct === 'invalid_code') return Response.json({ error: 'invalid_code' }, { status: 403 });
    customerId = acct.customerId;
    const { data: c } = await db.from('customers').select('email').eq('id', customerId).single();
    email = c?.email ?? '';
    bonus = topupBonus(amount, acct.membership ? cfg.plans[acct.membership.tier] : null);
  } else {
    // Guests never overwrite the name on an existing row.
    const name = String(raw.name ?? '').trim().slice(0, 60);
    email = String(raw.email ?? '').trim().toLowerCase();
    if (!name) return Response.json({ error: 'missing_fields' }, { status: 400 });
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: 'bad_email' }, { status: 400 });
    await db.from('customers').upsert({ id: crypto.randomUUID(), email, name }, { onConflict: 'email', ignoreDuplicates: true });
    const { data: c } = await db.from('customers').select('id').eq('email', email).single();
    if (!c) return Response.json({ error: 'topup_failed' }, { status: 500 });
    customerId = c.id;
  }

  const { data: t, error: insErr } = await db.from('topups')
    .insert({ customer_id: customerId, amount, bonus }).select('id').single();
  if (insErr) return Response.json({ error: 'topup_failed' }, { status: 500 });

  const session = await pay.createCheckout({
    kind: 'topup', ref: t.id, amountCents: amount * 100, email,
    name: `BLD balance top-up — $${amount}`,
    description: bonus ? `$${amount} + $${bonus} member bonus = $${amount + bonus} on your balance` : `$${amount} on your balance`,
    returnUrl: `${functionsBaseUrl()}/checkout-return?to=${encodeURIComponent(returnUrl)}`,
  });
  if (!session.ok) {
    await cancelTopup(db, t.id);
    return Response.json({ error: 'payments_unavailable' }, { status: 502 });
  }
  const { error: linkErr } = await db.from('topups').update({ stripe_session_id: session.id }).eq('id', t.id);
  if (linkErr) {
    await pay.expireCheckout(session.id);
    await cancelTopup(db, t.id);
    return Response.json({ error: 'topup_failed' }, { status: 500 });
  }
  return Response.json({ topupId: t.id, checkoutUrl: session.url, sessionId: session.id, amount, bonus });
});

// The customer is back from Stripe Checkout. The session id is the proof: only the
// app that opened this checkout has it.
// deno-lint-ignore no-explicit-any
async function settle(db: any, raw: Record<string, unknown>): Promise<Response> {
  const sessionId = String(raw.sessionId ?? '');
  const { data: t } = await db.from('topups').select('id, status, stripe_session_id')
    .eq('id', String(raw.topupId ?? '')).maybeSingle();
  if (!t || !sessionId || t.stripe_session_id !== sessionId) return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    return Response.json({ status: await settleTopup(db, await getProvider(db), t) });
  } catch (e) {
    console.error('top-up settle failed', t.id, (e as Error).message);
    return Response.json({ error: 'payments_unavailable' }, { status: 502 });
  }
}
