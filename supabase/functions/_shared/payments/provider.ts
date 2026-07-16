import type { CardDetails, ChargeResult, PaymentProvider } from './types.ts';

class FakeProvider implements PaymentProvider {
  async chargeDeposit({ bookingId, amountCents, card }: { bookingId: string; amountCents: number; card: CardDetails }): Promise<ChargeResult> {
    if (amountCents <= 0) return { ok: false, error: 'invalid_amount' };
    if (card.number.endsWith('0002')) return { ok: false, error: 'card_declined' };
    return { ok: true, ref: `fake_${bookingId}` };
  }
  async refund({ providerRef }: { bookingId: string; providerRef: string }): Promise<ChargeResult> {
    return { ok: true, ref: `refund_${providerRef}` };
  }
}

// Swap point: when a real processor is chosen, return its implementation here.
// Nothing outside this file may import a processor SDK.
export function getProvider(): PaymentProvider {
  return new FakeProvider();
}
