import { priceOrder, DEFAULT_CATALOG, CarItem } from '../../supabase/functions/_shared/pricing';

const car = (over: Partial<CarItem> = {}): CarItem => ({ size: 'sedan', service: 'full', extras: [], ...over });

test('sedan outside is $45', () => {
  const q = priceOrder([car({ service: 'outside' })], DEFAULT_CATALOG);
  expect(q.total).toBe(45);
});

test('size multiplier applies to service only', () => {
  expect(priceOrder([car({ size: 'suv' })], DEFAULT_CATALOG).total).toBe(150); // 120 * 1.25
  expect(priceOrder([car({ size: 'truck' })], DEFAULT_CATALOG).total).toBe(180); // 120 * 1.5
  const q = priceOrder([car({ size: 'suv', extras: ['headlight'] })], DEFAULT_CATALOG);
  expect(q.total).toBe(190); // 150 + flat 40
});

test('multi-car totals and deposit math', () => {
  const q = priceOrder([car(), car({ size: 'suv' })], DEFAULT_CATALOG); // 120 + 150
  expect(q.total).toBe(270);
  expect(q.depositPercent).toBe(25);
  expect(q.deposit).toBe(68); // round(67.5)
  expect(q.remainder).toBe(202);
  expect(q.lines).toHaveLength(2);
  expect(q.lines[1].car).toBe(2);
});

test('extras are itemized on the line', () => {
  const q = priceOrder([car({ extras: ['ceramic', 'engine'] })], DEFAULT_CATALOG);
  expect(q.lines[0].extras).toEqual([
    { name: 'ceramic', price: 199 },
    { name: 'engine', price: 35 },
  ]);
  expect(q.lines[0].lineTotal).toBe(354);
});

test('empty order throws', () => {
  expect(() => priceOrder([], DEFAULT_CATALOG)).toThrow('empty order');
});
