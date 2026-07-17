// Shared membership provisioning: create the customer + membership + code, grant the
// first period's credits, and email the code. Used by BOTH the owner admin page
// (owner-issued) and the Stripe webhook (self-serve). One code path = one set of
// invariants to keep correct.
//
// `admin` is a service-role Supabase client (typed loosely to avoid a hard SDK dep here).
//
// Design notes (these earn the complexity):
//  - Idempotency key is the Stripe subscription id (partial-unique in the DB). A replayed
//    or racing webhook delivery for the same subscription resolves to the same membership.
//  - Provisioning is NOT one transaction (membership, credit grant, email are separate
//    writes). So the initial credit grant is made idempotent by a partial-unique index
//    (migration 0009) and RE-ATTEMPTED on every call — a membership that committed but
//    whose grant failed transiently self-heals on the next retry.
//  - Failures are tagged retryable vs permanent so the webhook can 500 (Stripe retries)
//    only for transient faults, and 200-ack permanent bad data (unknown tier, constraint
//    violations) so Stripe stops retrying and never risks auto-disabling the endpoint.
import { generateCode, type MemberCatalog, type Tier } from './membership.ts';
import { sendEmail } from './notify.ts';

// deno-lint-ignore no-explicit-any
type Admin = any;

export interface ProvisionInput {
  email: string;
  name: string;
  tier: Tier;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
}

export type ProvisionResult =
  | { ok: true; code: string; membershipId: string; credits: number; service: string; created: boolean }
  | { ok: false; error: string; retryable: boolean };

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export async function provisionMember(admin: Admin, input: ProvisionInput): Promise<ProvisionResult> {
  const email = (input.email ?? '').trim().toLowerCase();
  const name = (input.name ?? '').trim();
  const tier = input.tier;
  const subId = input.stripeSubscriptionId ?? null;
  if (!email) return { ok: false, error: 'email required', retryable: false };

  const { data: cat, error: catErr } = await admin.from('catalog').select('config').eq('id', 1).single();
  if (catErr) return { ok: false, error: 'catalog fetch failed: ' + catErr.message, retryable: true };
  const cfg = cat?.config as MemberCatalog | undefined;
  const plan = cfg?.plans?.[tier];
  if (!plan) return { ok: false, error: `unknown tier: ${tier}`, retryable: false }; // permanent — don't retry

  // Resolve the membership: either it already exists for this subscription (idempotent
  // replay / race loser), or we create it fresh.
  let membershipId: string | null = null;
  let code = '';
  let created = false;

  if (subId) {
    const { data: existingSub } = await admin.from('memberships')
      .select('id, code').eq('stripe_subscription_id', subId).maybeSingle();
    if (existingSub) { membershipId = existingSub.id; code = existingSub.code; }
  }

  if (!membershipId) {
    // Customer row keyed by email; create an auth-less placeholder id if new.
    const { data: existing } = await admin.from('customers').select('id').eq('email', email).maybeSingle();
    let customerId = existing?.id ?? null;
    if (!customerId) {
      customerId = crypto.randomUUID();
      const { error: custErr } = await admin.from('customers').insert({ id: customerId, email, name });
      if (custErr) {
        // Concurrent insert of the same email is the likely cause — re-fetch the winner.
        const { data: raced } = await admin.from('customers').select('id').eq('email', email).maybeSingle();
        if (raced?.id) customerId = raced.id;
        else return { ok: false, error: 'customer insert failed: ' + custErr.message, retryable: true };
      }
    }

    code = generateCode();
    for (let i = 0; i < 6; i++) {
      const { data: inserted, error } = await admin.from('memberships').insert({
        customer_id: customerId, plan: tier, tier, code,
        credits_per_period: plan.credits, period_start: new Date().toISOString().slice(0, 10),
        stripe_customer_id: input.stripeCustomerId ?? null,
        stripe_subscription_id: subId,
      }).select('id').single();
      if (!error && inserted) { membershipId = inserted.id; created = true; break; }

      const msg = String(error?.message ?? '');
      const isUnique = error?.code === '23505';
      // Subscription-unique violation → another delivery already provisioned this sub.
      if (subId && isUnique && /stripe_sub_uniq|stripe_subscription_id/.test(msg)) {
        const { data: raced } = await admin.from('memberships')
          .select('id, code').eq('stripe_subscription_id', subId).maybeSingle();
        if (raced) { membershipId = raced.id; code = raced.code; break; }
      }
      // The only other unique on the insert is the member code → regenerate and retry.
      if (isUnique) { code = generateCode(); continue; }
      // Any non-unique error: transient (no pg code, e.g. network) → retry; permanent
      // (a pg error code like a check/FK violation) → don't loop Stripe forever.
      return { ok: false, error: 'membership insert failed: ' + msg, retryable: !error?.code };
    }
    if (!membershipId) return { ok: false, error: 'could not allocate a unique code', retryable: false };
  }

  // Initial credits — idempotent via the partial-unique index (migration 0009). We attempt
  // this on EVERY call (create OR replay) so a membership whose grant failed once heals.
  const { error: grantErr } = await admin.from('credit_ledger')
    .insert({ membership_id: membershipId, delta: plan.credits, reason: 'initial grant' });
  let grantedNow = false;
  if (!grantErr) grantedNow = true;
  else if (grantErr.code === '23505') grantedNow = false; // already granted before — fine
  else return { ok: false, error: 'credit grant failed: ' + grantErr.message, retryable: true };

  // Email the code exactly once — when THIS call is the one that completed the grant.
  // (If a prior call created the membership but died before granting, this is the retry
  // that grants + emails; a pure replay after full success does neither.)
  if (grantedNow) {
    await sendEmail(email, 'Welcome to the Brotherhood — your member code inside',
      `<h2 style="color:#A855F7;margin:0 0 12px">Welcome${name ? `, ${esc(name)}` : ''}!</h2>
       <p>Your <b>${tier.toUpperCase()}</b> membership is live: ${plan.credits} ${plan.service} details every month, priority booking, and rewards on every wash.</p>
       <p>Your member code:</p>
       <p style="font-family:monospace;font-size:28px;color:#F5B942;letter-spacing:3px">${code}</p>
       <p style="color:#A9A4AF">Open the BLD app → "I'm a member" → enter this code once.</p>`);
  }

  return { ok: true, code, membershipId, credits: plan.credits, service: plan.service, created };
}
