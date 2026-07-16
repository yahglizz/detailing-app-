export interface CardDetails {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
}

export type ChargeResult = { ok: true; ref: string } | { ok: false; error: string };

export interface PaymentProvider {
  chargeDeposit(input: { bookingId: string; amountCents: number; card: CardDetails }): Promise<ChargeResult>;
  refund(input: { bookingId: string; providerRef: string }): Promise<ChargeResult>;
}
