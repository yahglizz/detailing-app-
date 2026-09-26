// Stripe setup and upkeep the owner never has to do by hand:
//  - connect: paste a secret key once → the webhook endpoint is registered (its signing
//    secret saved), each tier gets a product + monthly price + Payment Link in THIS
//    account, and the Billing Portal is set up so members switch plans or update cards
//    themselves.
//  - plan price edits: a new monthly price + Payment Link per changed tier; the old link
//    is switched off. The app and the website read the links from the catalog, so they
//    follow at once. Existing subscribers keep the price they signed up at (Stripe's rule).
//  - member billing: a Billing Portal session for the app's "Manage plan" button.
import Stripe from 'npm:stripe@17';
import type { MemberCatalog, Tier } from './membership.ts';
import { functionsBaseUrl } from './notify.ts';

// deno-lint-ignore no-explicit-any
type Db = any;
type StripeCfg = {
  mode?: 'live' | 'test';
  links?: Partial<Record<Tier, string>>;
  linkIds?: Partial<Record<Tier, string>>;
  prices?: Partial<Record<Tier, string>>;
  products?: Partial<Record<Tier, string>>;
  portalConfig?: string;
};
type Cfg = MemberCatalog & { stripe?: StripeCfg };

const TIERS: Tier[] = ['bronze', 'silver', 'gold'];
const EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed', 'checkout.session.expired', 'charge.refunded',
  'customer.subscription.updated', 'customer.subscription.deleted',
];
const client = (key: string) => new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
const webhookUrl = () => `${functionsBaseUrl()}/stripe-webhook`;
const modeOf = (key: string): 'live' | 'test' => (key.includes('_live_') ? 'live' : 'test');
const msg = (e: unknown) => (e as Error)?.message ?? String(e);

export async function savedKey(db: Db): Promise<string> {
  const { data } = await db.from('app_config').select('value').eq('key', 'stripe_secret_key').maybeSingle();
  return String(data?.value ?? '').trim();
}

async function setConfig(db: Db, key: string, value: string) {
  const { error } = await db.from('app_config').upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(`app_config ${key}: ${error.message}`);
}

async function loadCatalog(db: Db): Promise<Cfg> {
  const { data } = await db.from('catalog').select('config').eq('id', 1).single();
  return data!.config as Cfg;
}

// ponytail: read-modify-write of the one catalog row; two owners saving in the same
// second would lose one edit. Fine for one business — a jsonb_set RPC if that changes.
async function saveStripe(db: Db, stripe: StripeCfg) {
  const cfg = await loadCatalog(db);
  const { error } = await db.from('catalog').update({ config: { ...cfg, stripe } }).eq('id', 1);
  if (error) throw new Error(`catalog: ${error.message}`);
}

const tierName = (t: Tier) => t[0].toUpperCase() + t.slice(1);

async function newLink(stripe: Stripe, tier: Tier, price: string) {
  return await stripe.paymentLinks.create({
    line_items: [{ price, quantity: 1 }],
    metadata: { tier }, // copied onto the checkout session → stripe-webhook provisions the member
    subscription_data: { metadata: { tier } },
    after_completion: {
      type: 'hosted_confirmation',
      hosted_confirmation: { custom_message: 'Welcome to the club! Your member code is on its way to your email.' },
    },
  });
}

async function newPrice(stripe: Stripe, tier: Tier, product: string, dollars: number) {
  return await stripe.prices.create({
    product, currency: 'usd', unit_amount: dollars * 100, recurring: { interval: 'month' }, metadata: { tier },
  });
}

function portalProducts(s: StripeCfg) {
  return TIERS.filter((t) => s.products?.[t] && s.prices?.[t])
    .map((t) => ({ product: s.products![t]!, prices: [s.prices![t]!] }));
}

// No key given = re-run the setup with the saved one (e.g. to turn on the Billing Portal
// or the newer webhook events for an account connected by hand earlier).
export async function stripeConnect(db: Db, rawKey: unknown) {
  const key = String(rawKey ?? '').trim() || await savedKey(db);
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(key)) return { ok: false as const, error: 'bad_key' };
  const stripe = client(key);
  let account: Stripe.Account;
  try { account = await stripe.accounts.retrieve(); } catch { return { ok: false as const, error: 'bad_key' }; }
  const mode = modeOf(key);
  const warnings: string[] = [];

  try {
    // The signing secret is only shown when an endpoint is created, so replace ours.
    const url = webhookUrl();
    const existing = await stripe.webhookEndpoints.list({ limit: 100 });
    for (const e of existing.data) if (e.url === url) await stripe.webhookEndpoints.del(e.id);
    const ep = await stripe.webhookEndpoints.create({ url, enabled_events: EVENTS, description: 'Brotherly Love Detailing (automatic)' });
    await setConfig(db, mode === 'live' ? 'stripe_webhook_secret' : 'stripe_webhook_secret_test', ep.secret ?? '');

    // Each tier's product, price and Payment Link, in THIS account and mode. Saved prices
    // from another account/mode don't resolve here, so they're remade at the catalog price.
    const cfg = await loadCatalog(db);
    const s: StripeCfg = { ...(cfg.stripe ?? {}), mode };
    s.links ??= {}; s.linkIds ??= {}; s.prices ??= {}; s.products ??= {};
    const active = (await stripe.paymentLinks.list({ active: true, limit: 100 })).data;
    for (const t of TIERS) {
      if (s.links[t] && !s.linkIds[t]) s.linkIds[t] = active.find((l) => l.url === s.links![t])?.id; // made by hand
      let product: string | null = null;
      try {
        const p = await stripe.prices.retrieve(s.prices[t] ?? 'missing');
        product = typeof p.product === 'string' ? p.product : p.product.id;
        // Wrong amount or archived: keep the product, make a fresh price at the catalog amount.
        if (p.unit_amount !== cfg.plans[t].price * 100 || !p.active) s.prices[t] = undefined;
      } catch { s.prices[t] = undefined; }
      if (!product) {
        product = (await stripe.products.create({ name: `${tierName(t)} Membership`, metadata: { tier: t } })).id;
      }
      s.products[t] = product;
      if (!s.prices[t]) {
        s.prices[t] = (await newPrice(stripe, t, product, cfg.plans[t].price)).id;
        // The old link sells the old price: switch it off (a no-op if it's another account's).
        if (s.linkIds[t]) await stripe.paymentLinks.update(s.linkIds[t]!, { active: false }).catch(() => {});
        s.links[t] = s.linkIds[t] = undefined;
      }
      if (!s.links[t] || !s.linkIds[t]) {
        const link = await newLink(stripe, t, s.prices[t]!);
        s.links[t] = link.url;
        s.linkIds[t] = link.id;
      }
    }

    try {
      const portal = await stripe.billingPortal.configurations.create({
        business_profile: { headline: 'Manage your Brotherly Love Detailing membership' },
        features: {
          payment_method_update: { enabled: true },
          invoice_history: { enabled: true },
          subscription_cancel: { enabled: true, mode: 'at_period_end' },
          subscription_update: {
            enabled: true, default_allowed_updates: ['price'], proration_behavior: 'create_prorations',
            products: portalProducts(s),
          },
        },
      });
      s.portalConfig = portal.id;
    } catch (e) {
      warnings.push(`Billing portal: ${msg(e)}`);
    }

    await saveStripe(db, s);
    await setConfig(db, 'stripe_secret_key', key);
    return {
      ok: true as const, mode, warnings,
      account: account.settings?.dashboard?.display_name || account.email || account.id,
    };
  } catch (e) {
    console.error('stripe connect failed', msg(e));
    return { ok: false as const, error: 'stripe_error', detail: msg(e) };
  }
}

export async function stripeStatus(db: Db) {
  const key = await savedKey(db);
  const cfg = await loadCatalog(db);
  if (!key) return { connected: false, links: cfg.stripe?.links ?? {} };
  const stripe = client(key);
  try {
    const account = await stripe.accounts.retrieve();
    const eps = await stripe.webhookEndpoints.list({ limit: 100 });
    const ep = eps.data.find((e) => e.url === webhookUrl());
    return {
      connected: true, mode: modeOf(key),
      account: account.settings?.dashboard?.display_name || account.email || account.id,
      webhook: ep?.status ?? 'missing',
      portal: !!cfg.stripe?.portalConfig,
      links: cfg.stripe?.links ?? {},
    };
  } catch (e) {
    return { connected: false, error: msg(e), links: cfg.stripe?.links ?? {} };
  }
}

// Before the catalog saves new plan prices: make Stripe charge them. Returns the updated
// stripe block to save with the catalog, or an error (then nothing is saved).
export async function syncPlanPrices(db: Db, next: Cfg, tiers: Tier[]):
  Promise<{ ok: true; stripe?: StripeCfg; warning?: string } | { ok: false; error: string }> {
  if (!tiers.length) return { ok: true };
  const key = await savedKey(db);
  if (!key) return { ok: true, warning: 'Stripe isn’t connected, so membership checkout still charges the old price. Connect Stripe in Settings.' };
  const stripe = client(key);
  const s: StripeCfg = JSON.parse(JSON.stringify(next.stripe ?? {}));
  s.links ??= {}; s.linkIds ??= {}; s.prices ??= {}; s.products ??= {};
  try {
    for (const t of tiers) {
      let product = s.products[t];
      if (!product && s.prices[t]) {
        const old = await stripe.prices.retrieve(s.prices[t]!);
        product = typeof old.product === 'string' ? old.product : old.product.id;
      }
      if (!product) return { ok: false, error: 'stripe_not_set_up' };
      const price = await newPrice(stripe, t, product, next.plans[t].price);
      const link = await newLink(stripe, t, price.id);
      if (s.linkIds[t]) await stripe.paymentLinks.update(s.linkIds[t]!, { active: false }).catch(() => {});
      s.products[t] = product;
      s.prices[t] = price.id;
      s.links[t] = link.url;
      s.linkIds[t] = link.id;
    }
    if (s.portalConfig) {
      await stripe.billingPortal.configurations.update(s.portalConfig, {
        features: { subscription_update: { products: portalProducts(s) } },
      }).catch((e) => console.error('portal update failed', msg(e)));
    }
    return { ok: true, stripe: s };
  } catch (e) {
    console.error('stripe price sync failed', msg(e));
    return { ok: false, error: `stripe_error: ${msg(e)}` };
  }
}

// Which tier a subscription is on, from its product (stable across price changes).
export function tierForProduct(cfg: Cfg, product: string | null | undefined): Tier | null {
  if (!product) return null;
  return TIERS.find((t) => cfg.stripe?.products?.[t] === product) ?? null;
}

export async function portalUrl(db: Db, customer: string, returnTo: string): Promise<string | null> {
  const key = await savedKey(db);
  if (!key) return null;
  const cfg = await loadCatalog(db);
  const s = await client(key).billingPortal.sessions.create({
    customer,
    return_url: `${functionsBaseUrl()}/checkout-return?to=${encodeURIComponent(returnTo)}`,
    ...(cfg.stripe?.portalConfig ? { configuration: cfg.stripe.portalConfig } : {}),
  });
  return s.url;
}
