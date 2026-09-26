// The only file that calls the payment processor (Stripe). The secret key lives in
// app_config — this project can't set edge-function env secrets — and an empty key
// means online payments are off (getProvider returns null).
import Stripe from 'npm:stripe@17';

export interface CheckoutState {
  status: 'open' | 'complete' | 'expired';
  paid: boolean;
  paymentRef: string | null; // the payment intent, which refunds point at
  amountCents: number;
}

// deno-lint-ignore no-explicit-any
export async function getProvider(db: any) {
  const { data } = await db.from('app_config').select('value').eq('key', 'stripe_secret_key').maybeSingle();
  const key = String(data?.value ?? '').trim();
  if (!key) return null;
  const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });

  return {
    // A hosted checkout page for exactly this booking or balance top-up (its id rides in
    // the metadata as booking_id / topup_id). Card only (Apple Pay / Google Pay ride
    // along): async methods would leave a paid-later booking in limbo.
    async createCheckout(i: {
      kind: 'booking' | 'topup'; ref: string;
      amountCents: number; email: string; name: string; description: string; returnUrl: string;
    }): Promise<{ ok: true; id: string; url: string } | { ok: false }> {
      const metadata = { [`${i.kind}_id`]: i.ref };
      try {
        const s = await stripe.checkout.sessions.create({
          mode: 'payment',
          payment_method_types: ['card'],
          customer_email: i.email || undefined,
          client_reference_id: i.ref,
          metadata,
          payment_intent_data: { metadata, description: i.name },
          line_items: [{
            quantity: 1,
            price_data: { currency: 'usd', unit_amount: i.amountCents, product_data: { name: i.name, description: i.description } },
          }],
          // Stripe's minimum is 30 minutes; the slot is held until then.
          expires_at: Math.floor(Date.now() / 1000) + 35 * 60,
          success_url: i.returnUrl,
          cancel_url: i.returnUrl,
        });
        return s.url ? { ok: true, id: s.id, url: s.url } : { ok: false };
      } catch (e) {
        console.error('stripe checkout create failed', i.kind, i.ref, (e as Error).message);
        return { ok: false };
      }
    },

    async getCheckout(id: string): Promise<CheckoutState> {
      const s = await stripe.checkout.sessions.retrieve(id);
      const pi = s.payment_intent;
      return {
        status: s.status ?? 'open',
        paid: s.payment_status === 'paid',
        paymentRef: typeof pi === 'string' ? pi : pi?.id ?? null,
        amountCents: s.amount_total ?? 0,
      };
    },

    // Closes an unpaid session so it can't be paid later. Throws nothing: if it was
    // completed or already expired, the caller re-reads the session.
    async expireCheckout(id: string): Promise<void> {
      await stripe.checkout.sessions.expire(id).catch(() => {});
    },

    // Full refund of a payment intent. The idempotency key makes a repeat call (owner
    // decline racing the auto-refund) return the same refund instead of a second one.
    async refund(paymentRef: string): Promise<{ ok: true; ref: string } | { ok: false }> {
      try {
        const r = await stripe.refunds.create({ payment_intent: paymentRef }, { idempotencyKey: `refund_${paymentRef}` });
        return { ok: true, ref: r.id };
      } catch (e) {
        console.error('stripe refund failed', paymentRef, (e as Error).message);
        return { ok: false };
      }
    },
  };
}

export type Payments = NonNullable<Awaited<ReturnType<typeof getProvider>>>;
