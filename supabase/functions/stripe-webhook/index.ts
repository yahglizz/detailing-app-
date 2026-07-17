// Stripe webhook — self-serve membership fulfillment.
//
// A customer pays via a Stripe Payment Link (one per tier, tier stamped in the
// link's metadata → copied onto the checkout session). Stripe calls this endpoint:
//   checkout.session.completed   → provision the member (customer + code + credits + email)
//   customer.subscription.deleted → deactivate the membership (canceled / unpaid)
//
// Security: every request is signature-verified against the webhook signing secret.
// The secret lives in app_config (this project can't set edge-function env secrets).
// No signature match → 400, nothing happens. Deployed with verify_jwt=false because
// Stripe does not send a Supabase JWT; the signature IS the auth.
//
// Idempotency: Stripe retries deliveries. provisionMember() keys on the Stripe
// subscription id (partial-unique in the DB), so a replayed checkout event returns
// the existing membership without re-granting credits or re-emailing. subscription
// deletion is an idempotent UPDATE.
import Stripe from 'npm:stripe@17';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { provisionMember } from '../_shared/member_provision.ts';
import type { Tier } from '../_shared/membership.ts';

const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// The API key is unused — we only call webhooks.constructEventAsync, which verifies
// the HMAC signature locally and never touches the Stripe API.
const stripe = new Stripe('sk_unused_webhook_verify_only');
const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const db = admin();

  const { data: cfg } = await db.from('app_config').select('value').eq('key', 'stripe_webhook_secret').single();
  const secret = (cfg?.value ?? '').trim();
  if (!secret) return new Response('webhook not configured', { status: 500 });

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('missing signature', { status: 400 });

  const body = await req.text(); // raw body required for signature verification
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, secret, undefined, cryptoProvider);
  } catch (e) {
    return new Response(`signature verification failed: ${(e as Error).message}`, { status: 400 });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object as Stripe.Checkout.Session;
      // Only fulfill a completed AND paid session. (Subscriptions with no trial complete
      // only after the first payment; async payment methods can be complete-but-unpaid.)
      if (s.status !== 'complete') return Response.json({ received: true, skipped: `status=${s.status}` });
      if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') {
        return Response.json({ received: true, skipped: `payment_status=${s.payment_status}` });
      }

      const tier = String(s.metadata?.tier ?? '') as Tier;
      const email = s.customer_details?.email ?? s.customer_email ?? '';
      const name = s.customer_details?.name ?? '';
      const stripeCustomerId = typeof s.customer === 'string' ? s.customer : (s.customer?.id ?? null);
      const stripeSubscriptionId = typeof s.subscription === 'string' ? s.subscription : (s.subscription?.id ?? null);

      // Bad/missing data is not retryable — ack so Stripe stops resending, but log it.
      if (!tier || !email) {
        console.error('checkout.session.completed missing tier/email', { tier, email, id: s.id });
        return Response.json({ received: true, skipped: 'missing tier/email' });
      }
      // Our membership links are all subscriptions; the subscription id is the idempotency
      // key. Without it we can't dedupe retries, so refuse to provision (ack, don't retry).
      if (!stripeSubscriptionId) {
        console.error('checkout.session.completed without subscription id', { id: s.id, tier, email });
        return Response.json({ received: true, skipped: 'no subscription id' });
      }

      const res = await provisionMember(db, { email, name, tier, stripeCustomerId, stripeSubscriptionId });
      if (!res.ok) {
        console.error('provision failed', res.error, { email, tier, sub: stripeSubscriptionId, retryable: res.retryable });
        // Retry only transient faults; permanent bad data is acked so Stripe stops (and
        // never auto-disables the endpoint, which would halt ALL fulfillment).
        return res.retryable
          ? new Response('provision failed (retryable)', { status: 500 })
          : Response.json({ received: true, skipped: 'permanent: ' + res.error });
      }
      return Response.json({ received: true, code_issued: res.created });
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as Stripe.Subscription;
      await db.from('memberships').update({ active: false }).eq('stripe_subscription_id', sub.id);
      return Response.json({ received: true, deactivated: sub.id });
    }

    return Response.json({ received: true, ignored: event.type });
  } catch (e) {
    console.error('webhook handler error', e);
    return new Response('handler error', { status: 500 }); // retry
  }
});
