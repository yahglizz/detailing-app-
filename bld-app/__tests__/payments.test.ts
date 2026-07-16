import { getProvider } from '../../supabase/functions/_shared/payments/provider';

const card = (number: string) => ({ number, expMonth: 12, expYear: 2030, cvc: '123' });

test('charge succeeds and returns a ref tied to the booking', async () => {
  const r = await getProvider().chargeDeposit({ bookingId: 'b1', amountCents: 6000, card: card('4242424242424242') });
  expect(r).toEqual({ ok: true, ref: 'fake_b1' });
});

test('card ending 0002 declines', async () => {
  const r = await getProvider().chargeDeposit({ bookingId: 'b1', amountCents: 6000, card: card('4000000000000002') });
  expect(r).toEqual({ ok: false, error: 'card_declined' });
});

test('non-positive amount rejected', async () => {
  const r = await getProvider().chargeDeposit({ bookingId: 'b1', amountCents: 0, card: card('4242424242424242') });
  expect(r).toEqual({ ok: false, error: 'invalid_amount' });
});

test('refund succeeds against a prior ref', async () => {
  const r = await getProvider().refund({ bookingId: 'b1', providerRef: 'fake_b1' });
  expect(r).toEqual({ ok: true, ref: 'refund_fake_b1' });
});
