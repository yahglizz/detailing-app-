import { DEFAULT_CATALOG } from '../../supabase/functions/_shared/pricing';
import { amountDue, checkoutLine, cleanItems, formatWhen, splitPayment } from '../../supabase/functions/_shared/payments/checkout';

test('amountDue: deposit mode charges the deposit, full mode everything', () => {
  expect(amountDue(120, 30, 'deposit')).toBe(30);
  expect(amountDue(120, 30, 'full')).toBe(120);
  expect(amountDue(0, 0, 'full')).toBe(0);
});

test('splitPayment: balance first, then the deposit or the rest on the card', () => {
  expect(splitPayment(100, 0, 25, 'deposit')).toEqual({ walletUsed: 0, rest: 100, deposit: 25, due: 25, atDetail: 75 });
  expect(splitPayment(100, 30, 25, 'deposit')).toEqual({ walletUsed: 30, rest: 70, deposit: 18, due: 18, atDetail: 52 });
  expect(splitPayment(100, 30, 25, 'full')).toEqual({ walletUsed: 30, rest: 70, deposit: 18, due: 70, atDetail: 0 });
  expect(splitPayment(100, 250, 25, 'deposit')).toEqual({ walletUsed: 100, rest: 0, deposit: 0, due: 0, atDetail: 0 });
  expect(splitPayment(0, 50, 25, 'full')).toEqual({ walletUsed: 0, rest: 0, deposit: 0, due: 0, atDetail: 0 });
});

test('cleanItems keeps valid cars, trims labels, drops duplicate extras', () => {
  expect(cleanItems([{ size: 'suv', service: 'full', extras: ['pet', 'pet'], label: '  Black Tahoe  ' }], DEFAULT_CATALOG))
    .toEqual([{ size: 'suv', service: 'full', extras: ['pet'], label: 'Black Tahoe' }]);
  expect(cleanItems([{ size: 'sedan', service: 'inside', extras: [], label: 'x'.repeat(60) }], DEFAULT_CATALOG)?.[0].label).toHaveLength(40);
  expect(cleanItems([{ size: 'sedan', service: 'inside', extras: [], label: '   ' }], DEFAULT_CATALOG)?.[0]).not.toHaveProperty('label');
});

test('cleanItems rejects anything outside the catalog', () => {
  const ok = { size: 'sedan', service: 'full', extras: [] };
  expect(cleanItems([], DEFAULT_CATALOG)).toBeNull();
  expect(cleanItems(Array(7).fill(ok), DEFAULT_CATALOG)).toBeNull();
  expect(cleanItems([{ ...ok, size: 'bus' }], DEFAULT_CATALOG)).toBeNull();
  expect(cleanItems([{ ...ok, service: 'toString' }], DEFAULT_CATALOG)).toBeNull();
  expect(cleanItems([{ ...ok, extras: ['gold'] }], DEFAULT_CATALOG)).toBeNull();
  expect(cleanItems('nope', DEFAULT_CATALOG)).toBeNull();
});

test('formatWhen reads like a person wrote it', () => {
  expect(formatWhen('2026-10-04', '13:00', 'afternoon')).toBe('Sun, Oct 4 · 1:00 PM');
  expect(formatWhen('2026-10-05', '09:00', 'morning')).toBe('Mon, Oct 5 · 9:00 AM');
  expect(formatWhen('2026-10-05', '12:00', 'afternoon')).toBe('Mon, Oct 5 · 12:00 PM');
  expect(formatWhen('2026-10-05', null, 'either')).toBe('Mon, Oct 5 · any time');
});

test('checkoutLine names what is being bought', () => {
  const base = { when: 'Sun, Oct 4 · 1:00 PM', address: '12 Main St', perks: [] };
  const one = checkoutLine({ ...base, items: [{ size: 'suv', service: 'full', extras: ['ceramic'], label: 'Black Tahoe' }], mode: 'full', balance: 0 });
  expect(one.name).toBe('Full detail · Black Tahoe (SUV) + Ceramic coating');
  expect(one.description).toBe('Sun, Oct 4 · 1:00 PM · 12 Main St · Paid in full');

  const two = checkoutLine({
    ...base, perks: ['1 member credit applied'], mode: 'deposit', balance: 90,
    items: [{ size: 'sedan', service: 'outside', extras: [] }, { size: 'truck', service: 'inside', extras: [] }],
  });
  expect(two.name).toBe('Deposit · 2 cars: Outside detail · Sedan; Inside detail · Truck/Van');
  expect(two.description).toBe('Sun, Oct 4 · 1:00 PM · 12 Main St · 1 member credit applied · $90 due at your detail');
});
