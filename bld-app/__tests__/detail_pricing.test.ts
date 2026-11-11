// The app's tsconfig has no node types; this test reads the migration file with plain require.
declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require('fs');
const path = require('path');
import {
  DEFAULT_DETAIL_PRICING as CFG,
  DetailPricing,
  DetailService,
  VehicleType,
  depositFor,
  invoiceTotals,
  isService,
  isVehicle,
  quoteDetail,
  startingPrice,
  validateDetailPricing,
} from '../../supabase/functions/_shared/detail_pricing';

const MATRIX: Record<DetailService, Record<VehicleType, number>> = {
  exterior: { sedan: 40, suv: 50, large: 60 },
  refresh: { sedan: 80, suv: 95, large: 110 },
  deep: { sedan: 150, suv: 175, large: 200 },
  full: { sedan: 175, suv: 205, large: 235 },
  premium: { sedan: 260, suv: 295, large: 335 },
};
const clone = (): DetailPricing => JSON.parse(JSON.stringify(CFG));

describe('starting prices', () => {
  const cells = (Object.keys(MATRIX) as DetailService[]).flatMap((s) =>
    (Object.keys(MATRIX[s]) as VehicleType[]).map((v) => [s, v, MATRIX[s][v]] as const),
  );
  test.each(cells)('%s / %s = $%i', (s, v, price) => {
    expect(startingPrice(CFG, s, v)).toBe(price);
  });
  test('there are 15 cells', () => expect(cells).toHaveLength(15));
});

describe('deposits', () => {
  test('flat by vehicle type', () => {
    expect(depositFor(CFG, 'full', 'sedan')).toBe(25);
    expect(depositFor(CFG, 'full', 'suv')).toBe(35);
    expect(depositFor(CFG, 'full', 'large')).toBe(45);
  });
  test('capped at the starting price', () => {
    const c = clone();
    c.services.exterior.prices.sedan = 20;
    expect(depositFor(c, 'exterior', 'sedan')).toBe(20);
    expect(quoteDetail(c, 'exterior', 'sedan')).toEqual({ startingPrice: 20, deposit: 20, balance: 0 });
  });
  test('the two worked examples from the brief', () => {
    expect(quoteDetail(CFG, 'full', 'sedan')).toEqual({ startingPrice: 175, deposit: 25, balance: 150 });
    expect(quoteDetail(CFG, 'full', 'large')).toEqual({ startingPrice: 235, deposit: 45, balance: 190 });
  });
});

describe('ids', () => {
  test.each(['__proto__', 'constructor', 'toString', '', 'FULL', ' full', 'outside', 5, null, undefined])(
    'service %p is rejected',
    (x) => expect(isService(x)).toBe(false),
  );
  test.each(['__proto__', 'constructor', '', 'SUV', 'truck', 7, null])('vehicle %p is rejected', (x) =>
    expect(isVehicle(x)).toBe(false),
  );
  test('real ids pass', () => {
    expect(isService('premium')).toBe(true);
    expect(isVehicle('large')).toBe(true);
  });
  test('pricing an unknown id throws', () => {
    expect(() => startingPrice(CFG, '__proto__' as DetailService, 'sedan')).toThrow();
  });
});

describe('validateDetailPricing', () => {
  test('default config is valid and exactly one service is popular', () => {
    const r = validateDetailPricing(clone());
    expect(r.ok).toBe(true);
    expect(Object.values(CFG.services).filter((s) => s.popular)).toHaveLength(1);
    expect(CFG.services.full.popular).toBe(true);
  });
  test.each([
    ['zero price', (c: DetailPricing) => { c.services.full.prices.sedan = 0; }],
    ['fractional price', (c: DetailPricing) => { c.services.full.prices.sedan = 1.5; }],
    ['NaN price', (c: DetailPricing) => { c.services.full.prices.sedan = NaN; }],
    ['huge price', (c: DetailPricing) => { c.services.full.prices.sedan = 10001; }],
    ['missing cell', (c: DetailPricing) => { delete (c.services.full.prices as any).large; }],
    ['bad deposit', (c: DetailPricing) => { c.deposits.suv = -5; }],
    ['two popular', (c: DetailPricing) => { c.services.deep.popular = true; }],
    ['no popular', (c: DetailPricing) => { c.services.full.popular = false; }],
    ['empty name', (c: DetailPricing) => { c.services.full.name = ''; }],
    ['no includes', (c: DetailPricing) => { c.services.full.includes = []; }],
    ['window 0', (c: DetailPricing) => { c.bookingWindowDays = 0; }],
    ['window 61', (c: DetailPricing) => { c.bookingWindowDays = 61; }],
  ])('rejects %s', (_n, mutate) => {
    const c = clone();
    mutate(c);
    expect(validateDetailPricing(c).ok).toBe(false);
  });
  test('rejects non-objects', () => {
    expect(validateDetailPricing(null).ok).toBe(false);
    expect(validateDetailPricing('x').ok).toBe(false);
  });
});

describe('invoiceTotals', () => {
  test('service + extras, deposit credited', () => {
    expect(
      invoiceTotals({ servicePrice: 200, extras: [{ name: 'Pet hair', price: 30 }], depositCredit: 25 }),
    ).toEqual({ total: 230, credit: 25, balance: 205, refundDue: 0 });
  });
  test('no deposit taken (demo): nothing credited, full total due', () => {
    expect(invoiceTotals({ servicePrice: 175, extras: [], depositCredit: 0 })).toEqual({ total: 175, credit: 0, balance: 175, refundDue: 0 });
  });
  test('credit is capped at the total, balance never negative, the excess is refundDue', () => {
    expect(invoiceTotals({ servicePrice: 20, extras: [], depositCredit: 500 })).toEqual({ total: 20, credit: 20, balance: 0, refundDue: 480 });
  });
  test('zero service price is allowed (waived job)', () => {
    expect(invoiceTotals({ servicePrice: 0, extras: [], depositCredit: 25 })).toEqual({ total: 0, credit: 0, balance: 0, refundDue: 25 });
  });
  test.each([
    [{ servicePrice: 100, extras: [{ name: 'x', price: -5 }], depositCredit: 0 }],
    [{ servicePrice: NaN, extras: [], depositCredit: 0 }],
    [{ servicePrice: 100, extras: [{ name: 'x', price: 10001 }], depositCredit: 0 }],
    [{ servicePrice: 100.5, extras: [], depositCredit: 0 }],
    [{ servicePrice: 100, extras: [], depositCredit: -1 }],
    [{ servicePrice: 100, extras: [{ name: 'x', price: Infinity }], depositCredit: 0 }],
  ])('bad numbers throw bad_invoice (%#)', (i) => {
    expect(() => invoiceTotals(i as any)).toThrow('bad_invoice');
  });
});

describe('migration seed matches the code default', () => {
  test('JSON between the markers equals DEFAULT_DETAIL_PRICING', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '../../supabase/migrations/0015_detail_booking.sql'),
      'utf8',
    );
    const region = sql.match(/-- detailPricing:begin\n([\s\S]*?)\n-- detailPricing:end/);
    expect(region).not.toBeNull();
    const lit = region![1].match(/^\$json\$([\s\S]*)\$json\$::jsonb$/);
    expect(lit).not.toBeNull();
    expect(JSON.parse(lit![1])).toEqual(CFG);
  });
});
