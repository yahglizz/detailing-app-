// Stripe webhook — booking payments, balance top-ups, and self-serve memberships.
//
// Booking checkouts (created by `book`, booking id in the session metadata):
//   checkout.session.completed → fulfill the booking (record payment, slot, emails)
//   checkout.session.expired   → the customer never paid: free the slot
// Balance top-ups (created by `topup`, topup id in the metadata): completed → credit
// the balance, expired → cancel. charge.refunded on a top-up's payment takes the
// refunded share back off the balance.
// The app's own return from checkout does the same (action 'settle'); whichever lands
// first wins, the other is a no-op.
//
// Memberships: a customer pays via a Stripe Payment Link (one per tier, tier stamped
// in the link's metadata → copied onto the checkout session). Stripe calls:
//   checkout.session.completed   → provision the member (customer + code + credits + email)
//   customer.subscription.updated → plan switched (Billing Portal) or payment lapsed/recovered
//   customer.subscription.deleted → deactivate the membership (canceled / unpaid)
//
// Security: every request is signature-verified against a webhook signing secret —
// the live endpoint's (stripe_webhook_secret) or the test-mode endpoint's
// (stripe_webhook_secret_test). They live in app_config (this project can't set
// edge-function env secrets). No signature match → 400, nothing happens. Deployed with
// verify_jwt=false because Stripe does not send a Supabase JWT; the signature IS the auth.
//
// Idempotency: Stripe retries deliveries. provisionMember() keys on the Stripe
// subscription id (partial-unique in the DB), so a replayed checkout event returns
// the existing membership without re-granting credits or re-emailing. subscription
// deletion is an idempotent UPDATE.
import Stripe from 'npm:stripe@17';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { provisionMember } from '../_shared/member_provision.ts';
import type { MemberCatalog, Tier } from '../_shared/membership.ts';
import { tierForProduct } from '../_shared/stripe_admin.ts';
import { declinePending, fulfillBooking } from '../_shared/booking_payment.ts';
import { cancelTopup, fulfillTopup, takeBackRefund } from '../_shared/wallet.ts';

const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// The API key is unused — we only call webhooks.constructEventAsync, which verifies
// the HMAC signature locally and never touches the Stripe API.
const stripe = new Stripe('sk_unused_webhook_verify_only');
const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const db = admin();

  const { data: rows } = await db.from('app_config').select('value')
    .in('key', ['stripe_webhook_secret', 'stripe_webhook_secret_test']);
  const secrets = ((rows ?? []) as { value: string }[]).map((r) => r.value.trim()).filter(Boolean);
  if (!secrets.length) return new Response('webhook not configured', { status: 500 });

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('missing signature', { status: 400 });

  const body = await req.text(); // raw body required for signature verification
  let event: Stripe.Event | null = null;
  for (const secret of secrets) {
    try {
      event = await stripe.webhooks.constructEventAsync(body, sig, secret, undefined, cryptoProvider);
      break;
    } catch { /* not this endpoint's secret — try the next */ }
  }
  if (!event) return new Response('signature verification failed', { status: 400 });

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired') {
      const s = event.data.object as Stripe.Checkout.Session;
      const bookingId = s.metadata?.booking_id;
      if (bookingId) return await bookingEvent(db, event.type, s, bookingId);
      const topupId = s.metadata?.topup_id;
      if (topupId) return await topupEvent(db, event.type, s, topupId);
    }

    if (event.type === 'charge.refunded') {
      const ch = event.data.object as Stripe.Charge;
      const paymentRef = typeof ch.payment_intent === 'string' ? ch.payment_intent : ch.payment_intent?.id ?? null;
      await takeBackRefund(db, { paymentRef, amountCents: ch.amount, refundedCents: ch.amount_refunded });
      return Response.json({ received: true });
    }

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

    // Plan switched in the Billing Portal, or a renewal failed / recovered. The tier comes
    // from the price's product (stable across price edits); a lapsed payment pauses the
    // membership (no credit grants) until Stripe collects again.
    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object as Stripe.Subscription;
      const product = sub.items.data[0]?.price?.product;
      const { data: cat } = await db.from('catalog').select('config').eq('id', 1).single();
      const tier = tierForProduct(cat!.config, typeof product === 'string' ? product : product?.id);
      const patch: Record<string, unknown> = { active: sub.status === 'active' || sub.status === 'trialing' };
      if (tier) Object.assign(patch, { tier, plan: tier, credits_per_period: (cat!.config as MemberCatalog).plans[tier].credits });
      await db.from('memberships').update(patch).eq('stripe_subscription_id', sub.id);
      return Response.json({ received: true, updated: sub.id, tier });
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

// deno-lint-ignore no-explicit-any
async function bookingEvent(db: any, type: string, s: Stripe.Checkout.Session, bookingId: string): Promise<Response> {
  const { data: b } = await db.from('bookings').select('id, stripe_session_id, pay_mode').eq('id', bookingId).maybeSingle();
  // Not ours (another environment's booking) or a stale session — ack so Stripe stops.
  if (!b || (b.stripe_session_id && b.stripe_session_id !== s.id)) {
    return Response.json({ received: true, skipped: 'unknown booking' });
  }
  if (type === 'checkout.session.expired') {
    await declinePending(db, b.id);
    return Response.json({ received: true, released: b.id });
  }
  const ref = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id;
  if (s.payment_status !== 'paid' || !ref) {
    return Response.json({ received: true, skipped: `payment_status=${s.payment_status}` });
  }
  const ok = await fulfillBooking(db, b.id, {
    kind: b.pay_mode === 'full' ? 'full' : 'deposit', amountCents: s.amount_total ?? 0, ref,
  });
  return ok ? Response.json({ received: true, fulfilled: b.id }) : new Response('fulfill failed (retryable)', { status: 500 });
}

// deno-lint-ignore no-explicit-any
async function topupEvent(db: any, type: string, s: Stripe.Checkout.Session, topupId: string): Promise<Response> {
  const { data: t } = await db.from('topups').select('id, stripe_session_id').eq('id', topupId).maybeSingle();
  if (!t || (t.stripe_session_id && t.stripe_session_id !== s.id)) {
    return Response.json({ received: true, skipped: 'unknown top-up' });
  }
  if (type === 'checkout.session.expired') {
    await cancelTopup(db, t.id);
    return Response.json({ received: true, cancelled: t.id });
  }
  const ref = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id;
  if (s.payment_status !== 'paid' || !ref) {
    return Response.json({ received: true, skipped: `payment_status=${s.payment_status}` });
  }
  return (await fulfillTopup(db, t.id, ref))
    ? Response.json({ received: true, credited: t.id })
    : new Response('top-up credit failed (retryable)', { status: 500 });
}
