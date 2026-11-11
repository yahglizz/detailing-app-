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
  billingMonthStart,
  depositFor,
  invoiceTotals,
  invoiceTotalsLines,
  isService,
  isVehicle,
  memberQuote,
  membershipView,
  quoteCars,
  quoteDetail,
  startingPrice,
  validateDetailPricing,
  vehicleRank,
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

describe('membership', () => {
  const view = membershipView(CFG);
  // [tier, vehicle, monthly price, worth booked one at a time, saving]
  const EXPECT: [string, VehicleType, number, number, number][] = [
    ['bronze', 'sedan', 65, 80, 15], ['bronze', 'suv', 80, 100, 20], ['bronze', 'large', 95, 120, 25],
    ['silver', 'sedan', 125, 160, 35], ['silver', 'suv', 150, 195, 45], ['silver', 'large', 180, 230, 50],
    ['gold', 'sedan', 190, 255, 65], ['gold', 'suv', 230, 305, 75], ['gold', 'large', 265, 355, 90],
  ];
  test.each(EXPECT)('%s / %s: $%i a month, worth $%i, save $%i', (t, v, price, worth, save) => {
    expect((view as any)[t].prices[v]).toEqual({ price, worth, save });
  });
  test('every plan saves money at every vehicle size, and higher tiers cost more', () => {
    for (const v of ['sedan', 'suv', 'large'] as VehicleType[]) {
      for (const t of ['bronze', 'silver', 'gold'] as const) expect(view[t].prices[v].save).toBeGreaterThan(0);
      expect(view.bronze.prices[v].price).toBeLessThan(view.silver.prices[v].price);
      expect(view.silver.prices[v].price).toBeLessThan(view.gold.prices[v].price);
    }
  });
  test('what is included is spelled out from the visits', () => {
    expect(view.bronze.includes).toEqual(['2 × Exterior Wash']);
    expect(view.silver.includes).toEqual(['2 × Exterior Wash', '1 × Interior Refresh']);
    expect(view.gold.includes).toEqual(['2 × Exterior Wash', '1 × Full Detail']);
  });
  test('worth follows the service prices: raise a service and the plan worth moves, the saving is never negative', () => {
    const c = clone();
    c.services.exterior.prices.sedan = 100;
    expect(membershipView(c).bronze.prices.sedan.worth).toBe(200);
    c.membership.bronze.prices.sedan = 999;
    expect(membershipView(c).bronze.prices.sedan.save).toBe(0);
  });
  test('validation: needs a visit, whole prices, a known service, and drops unknown keys', () => {
    const bad = (mut: (c: any) => void) => { const c: any = clone(); mut(c); return validateDetailPricing(c); };
    expect(validateDetailPricing(CFG).ok).toBe(true);
    expect(bad((c) => { delete c.membership; }).ok).toBe(false);
    expect(bad((c) => { c.membership.gold.visits = {}; }).ok).toBe(false);
    expect(bad((c) => { c.membership.gold.visits = { full: 0 }; }).ok).toBe(false);
    expect(bad((c) => { c.membership.gold.visits.full = 1.5; }).ok).toBe(false);
    expect(bad((c) => { c.membership.gold.prices.suv = 0; }).ok).toBe(false);
    expect(bad((c) => { c.membership.gold.prices.suv = 12.5; }).ok).toBe(false);
    expect(bad((c) => { c.membership.gold.perks = []; }).ok).toBe(false);
    const ok: any = bad((c) => { c.membership.gold.visits.ceramic = 3; c.membership.gold.extra = 'x'; c.membership.platinum = {}; });
    expect(ok.ok).toBe(true);
    expect(Object.keys(ok.value.membership)).toEqual(['bronze', 'silver', 'gold']);
    expect('ceramic' in ok.value.membership.gold.visits).toBe(false);
    expect('extra' in ok.value.membership.gold).toBe(false);
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
  test('JSON between the markers of the newest migration that has them equals DEFAULT_DETAIL_PRICING', () => {
    const dir = path.join(__dirname, '../../supabase/migrations');
    const newest = (fs.readdirSync(dir) as string[]).filter((f) => f.endsWith('.sql')).sort().reverse()
      .map((f) => ({ f, sql: fs.readFileSync(path.join(dir, f), 'utf8') as string }))
      .find((m) => m.sql.includes('-- detailPricing:begin'));
    expect(newest?.f).toBe('0017_app_sync.sql');
    const region = newest!.sql.match(/-- detailPricing:begin\n([\s\S]*?)\n-- detailPricing:end/);
    expect(region).not.toBeNull();
    const lit = region![1].match(/^\$json\$([\s\S]*)\$json\$::jsonb$/);
    expect(lit).not.toBeNull();
    expect(JSON.parse(lit![1])).toEqual(CFG);
  });
});

describe('plan fields (rank, stamps, top-up bonus, % off)', () => {
  test('defaults', () => {
    const pick = (t: 'bronze' | 'silver' | 'gold') => {
      const m = CFG.membership[t];
      return [m.rank, m.stampsPerCar, m.topupBonusPercent, m.discountPercent];
    };
    expect(pick('bronze')).toEqual([1, 1, 5, 10]);
    expect(pick('silver')).toEqual([2, 2, 10, 15]);
    expect(pick('gold')).toEqual([3, 3, 15, 20]);
  });
  test('membershipView carries them per tier', () => {
    const v = membershipView(CFG);
    expect(v.gold).toMatchObject({ rank: 3, stampsPerCar: 3, topupBonusPercent: 15, discountPercent: 20 });
    expect(v.bronze).toMatchObject({ rank: 1, stampsPerCar: 1, topupBonusPercent: 5, discountPercent: 10 });
  });
  test('validateDetailPricing rejects duplicate rank', () => {
    const c = clone();
    c.membership.silver.rank = 3;
    expect(validateDetailPricing(c)).toEqual({ ok: false, error: 'bad_value:membership.rank' });
  });
  test.each([
    ['rank 0', (c: DetailPricing) => { c.membership.gold.rank = 0; }],
    ['rank 4', (c: DetailPricing) => { c.membership.gold.rank = 4; }],
    ['stamps 0', (c: DetailPricing) => { c.membership.gold.stampsPerCar = 0; }],
    ['stamps 11', (c: DetailPricing) => { c.membership.gold.stampsPerCar = 11; }],
    ['bonus 51', (c: DetailPricing) => { c.membership.gold.topupBonusPercent = 51; }],
    ['bonus -1', (c: DetailPricing) => { c.membership.gold.topupBonusPercent = -1; }],
    ['discount 51', (c: DetailPricing) => { c.membership.gold.discountPercent = 51; }],
    ['discount 12.5', (c: DetailPricing) => { c.membership.gold.discountPercent = 12.5; }],
    ['discount as text', (c: DetailPricing) => { (c.membership.gold as any).discountPercent = '20'; }],
  ])('rejects %s', (_n, mutate) => {
    const c = clone();
    mutate(c);
    expect(validateDetailPricing(c).ok).toBe(false);
  });
  test('0 bonus and 0 % off are allowed', () => {
    const c = clone();
    c.membership.bronze.topupBonusPercent = 0;
    c.membership.bronze.discountPercent = 0;
    expect(validateDetailPricing(c).ok).toBe(true);
  });
  test('a saved config from before these fields existed still validates, filled from the defaults', () => {
    const c: any = clone();
    for (const t of ['bronze', 'silver', 'gold']) {
      for (const k of ['rank', 'stampsPerCar', 'topupBonusPercent', 'discountPercent']) delete c.membership[t][k];
    }
    const r: any = validateDetailPricing(c);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual(CFG);
  });
});

describe('quoteCars', () => {
  test('quoteCars sums prices and deposits', () => {
    const q = quoteCars(CFG, [{ service: 'full', vehicleType: 'sedan' }, { service: 'premium', vehicleType: 'large' }]);
    expect(q).toEqual({
      lines: [
        { service: 'full', vehicleType: 'sedan', startingPrice: 175, deposit: 25 },
        { service: 'premium', vehicleType: 'large', startingPrice: 335, deposit: 45 },
      ],
      subtotal: 510,
      deposit: 70,
    });
  });
  test('quoteCars rejects 0 and 7 cars', () => {
    const car = { service: 'full' as const, vehicleType: 'sedan' as const };
    expect(() => quoteCars(CFG, [])).toThrow('bad_cars');
    expect(() => quoteCars(CFG, Array(7).fill(car))).toThrow('bad_cars');
    expect(() => quoteCars(CFG, null as any)).toThrow('bad_cars');
    expect(quoteCars(CFG, Array(6).fill(car)).subtotal).toBe(6 * 175);
  });
  test('each car deposit is capped at that car price', () => {
    const c = clone();
    c.services.exterior.prices.sedan = 20;
    expect(quoteCars(c, [{ service: 'exterior', vehicleType: 'sedan' }, { service: 'full', vehicleType: 'suv' }]).deposit).toBe(20 + 35);
  });
  test('unknown ids throw', () => {
    expect(() => quoteCars(CFG, [{ service: 'ceramic' as any, vehicleType: 'sedan' }])).toThrow();
    expect(() => quoteCars(CFG, [{ service: 'full', vehicleType: 'truck' as any }])).toThrow();
  });
  test('vehicleRank orders sedan < suv < large', () => {
    expect([vehicleRank('sedan'), vehicleRank('suv'), vehicleRank('large')]).toEqual([0, 1, 2]);
    expect(() => vehicleRank('truck' as any)).toThrow();
  });
});

describe('memberQuote', () => {
  const sedanFull = { service: 'full' as const, vehicleType: 'sedan' as const };
  const gold = (visitsLeft: Partial<Record<DetailService, number>>, reward: any = null) =>
    ({ tier: 'gold' as const, planVehicle: 'sedan' as const, visitsLeft, reward });

  test('memberQuote covers most expensive first', () => {
    const q = memberQuote(CFG, [sedanFull, { service: 'full', vehicleType: 'suv' }], gold({ full: 1 }));
    // the suv (205) is the more expensive car: the visit covers it up to the sedan plan price, it pays the 30 difference
    expect(q.lines[1]).toMatchObject({ covered: false, credit: 175, payable: 30 - Math.round(30 * 0.2) });
    expect(q.lines[0]).toMatchObject({ covered: false, payable: 140 });
    expect(q.visitsUsed).toEqual({ full: 1 });
  });
  test('memberQuote covers one of two equal cars, the other gets the tier % off', () => {
    const q = memberQuote(CFG, [sedanFull, sedanFull], gold({ full: 1 }));
    expect(q.lines.filter((l) => l.covered)).toHaveLength(1);
    expect(q.lines.map((l) => l.payable).sort((a, b) => a - b)).toEqual([0, 175 - Math.round(175 * 0.2)]);
    expect(q).toMatchObject({ subtotal: 350, payable: 140, visitsUsed: { full: 1 }, memberDiscount: 35, savings: 210, deposit: 25 });
  });
  test('memberQuote bigger car pays difference', () => {
    const q = memberQuote(CFG, [{ service: 'full', vehicleType: 'large' }], gold({ full: 1 }));
    // partly covered: not `covered`, carries the plan-size price as credit
    expect(q.lines[0]).toMatchObject({ covered: false, credit: 175, payable: 48 });
    expect(q).toMatchObject({ payable: 48, memberDiscount: 12, savings: 235 - 48, deposit: 45 });
  });
  test('a smaller car than the plan is fully covered', () => {
    const q = memberQuote(CFG, [sedanFull], { ...gold({ full: 1 }), planVehicle: 'large' });
    expect(q).toMatchObject({ payable: 0, deposit: 0, visitsUsed: { full: 1 } });
  });
  test('visits only cover their own service; other services get the % off', () => {
    const q = memberQuote(CFG, [{ service: 'deep', vehicleType: 'sedan' }], gold({ full: 1, exterior: 2 }));
    expect(q).toMatchObject({ payable: 150 - 30, visitsUsed: {}, memberDiscount: 30 });
  });
  test('more visits than cars: only what is booked is used', () => {
    const q = memberQuote(CFG, [{ service: 'exterior', vehicleType: 'sedan' }], gold({ exterior: 2 }));
    expect(q.visitsUsed).toEqual({ exterior: 1 });
  });
  test('memberQuote reward percent25 then tier %', () => {
    const q = memberQuote(CFG, [sedanFull], gold({}, 'percent25'));
    // 175 -> 25% off -> 131, then 20% off -> 131 - 26 = 105
    expect(q).toMatchObject({ payable: 105, rewardUsed: true, memberDiscount: 26, savings: 70 });
  });
  test('memberQuote freeWash frees cheapest uncovered car', () => {
    const q = memberQuote(CFG, [{ service: 'premium', vehicleType: 'sedan' }, { service: 'exterior', vehicleType: 'suv' }], gold({}, 'freeWash'));
    expect(q.lines[1]).toMatchObject({ covered: true, payable: 0 });
    expect(q.lines[1].credit).toBeUndefined();
    expect(q.lines[0]).toMatchObject({ covered: false, payable: 260 - 52 });
    expect(q).toMatchObject({ payable: 208, rewardUsed: true, deposit: 25 });
  });
  test('freeWash skips covered cars', () => {
    const q = memberQuote(CFG, [{ service: 'exterior', vehicleType: 'sedan' }, sedanFull], gold({ exterior: 1 }, 'freeWash'));
    expect(q.lines[0]).toMatchObject({ covered: true, payable: 0 });
    expect(q.lines[1]).toMatchObject({ covered: true, payable: 0 });
    expect(q).toMatchObject({ payable: 0, rewardUsed: true, deposit: 0 });
  });
  test('freeWash skips a partly covered bigger car', () => {
    const q = memberQuote(CFG, [{ service: 'full', vehicleType: 'large' }, { service: 'deep', vehicleType: 'sedan' }], gold({ full: 1 }, 'freeWash'));
    expect(q.lines[0]).toMatchObject({ covered: false, credit: 175, payable: 48 });
    expect(q.lines[1]).toMatchObject({ covered: true, payable: 0 });
  });
  test('tire shine / mini-spray change no price but are used by the booking', () => {
    const q = memberQuote(CFG, [sedanFull], gold({}, 'tireShine'));
    expect(q).toMatchObject({ payable: 140, rewardUsed: true });
  });
  test('memberQuote all covered → payable 0, deposit 0, reward kept', () => {
    const q = memberQuote(CFG, [sedanFull, { service: 'exterior', vehicleType: 'sedan' }], gold({ full: 1, exterior: 2 }, 'percent25'));
    expect(q).toMatchObject({ payable: 0, deposit: 0, rewardUsed: false, memberDiscount: 0, savings: 215, visitsUsed: { full: 1, exterior: 1 } });
    expect(q.lines.every((l) => l.covered)).toBe(true);
  });
  test('member deposit is capped at what is payable', () => {
    const q = memberQuote(CFG, [{ service: 'exterior', vehicleType: 'sedan' }], { tier: 'gold', planVehicle: 'sedan', visitsLeft: {}, reward: 'percent25' });
    // 40 -> 30 -> 24, deposit 25 capped at 24
    expect(q).toMatchObject({ payable: 24, deposit: 24 });
  });
  test('discount follows the tier config', () => {
    const q = memberQuote(CFG, [sedanFull], { tier: 'bronze', planVehicle: 'sedan', visitsLeft: {}, reward: null });
    // 175 x 90% = 157.5, rounded once half up = 158 (same as the invoice)
    expect(q).toMatchObject({ payable: 158, memberDiscount: 17, memberPercent: 10, rewardPercent: 0 });
  });
  test('percent25 is reported as rewardPercent for the invoice', () => {
    expect(memberQuote(CFG, [sedanFull], gold({}, 'percent25'))).toMatchObject({ rewardPercent: 25, memberPercent: 20 });
    expect(memberQuote(CFG, [sedanFull], gold({}, 'freeWash'))).toMatchObject({ rewardPercent: 0 });
    // all covered: the reward is kept, so no reward %
    expect(memberQuote(CFG, [sedanFull], gold({ full: 1 }, 'percent25'))).toMatchObject({ rewardPercent: 0, rewardUsed: false });
  });
  test('2 cars x $42 at 20%: one rounding, quote = invoice = 67, car lines add up', () => {
    const c = clone();
    c.services.exterior.prices.sedan = 42;
    const car = { service: 'exterior' as const, vehicleType: 'sedan' as const };
    const q = memberQuote(c, [car, car], gold({}));
    expect(q).toMatchObject({ payable: 67, memberDiscount: 17, savings: 17 });
    expect(q.lines.map((l) => l.payable)).toEqual([34, 33]);
    expect(invoiceTotalsLines({ lines: q.lines.map((l) => ({ price: l.startingPrice, covered: l.covered })), extras: [], memberPercent: q.memberPercent, rewardPercent: q.rewardPercent, depositCredit: 0 }).total).toBe(67);
  });
  test('car lines always add up to payable, covered cars stay 0', () => {
    const q = memberQuote(CFG, [{ service: 'exterior', vehicleType: 'suv' }, sedanFull, { service: 'refresh', vehicleType: 'large' }, { service: 'full', vehicleType: 'large' }],
      { tier: 'silver', planVehicle: 'sedan', visitsLeft: { full: 1 }, reward: 'percent25' });
    expect(q.lines.reduce((n, l) => n + l.payable, 0)).toBe(q.payable);
    expect(q.lines.filter((l) => l.covered).every((l) => l.payable === 0)).toBe(true);
  });
  test('bad member context throws', () => {
    expect(() => memberQuote(CFG, [sedanFull], { ...gold({}), tier: 'platinum' as any })).toThrow('bad_member');
    expect(() => memberQuote(CFG, [sedanFull], { ...gold({}), planVehicle: 'truck' as any })).toThrow('bad_member');
    expect(() => memberQuote(CFG, [], gold({}))).toThrow('bad_cars');
  });
  test('junk visit counts are ignored', () => {
    const q = memberQuote(CFG, [sedanFull], gold({ full: -1, __proto__: 3 } as any));
    expect(q.visitsUsed).toEqual({});
  });
});

describe('billingMonthStart', () => {
  test.each([
    ['2026-01-31', '2026-03-01', '2026-02-28'],
    ['2026-01-31', '2026-02-28', '2026-02-28'],
    ['2026-01-31', '2026-03-31', '2026-03-31'],
    ['2026-01-31', '2026-03-30', '2026-02-28'],
    ['2024-01-31', '2024-03-01', '2024-02-29'],
    ['2026-01-15', '2026-01-15', '2026-01-15'],
    ['2026-01-15', '2026-01-14', '2026-01-15'],
    ['2026-11-20', '2027-01-05', '2026-12-20'],
    ['2026-03-10T14:00:00+00:00', '2026-11-11', '2026-11-10'],
  ])('period %s, today %s -> %s', (ps, today, want) => {
    expect(billingMonthStart(ps, today)).toBe(want);
  });
  test('bad dates throw', () => {
    expect(() => billingMonthStart('nope', '2026-01-01')).toThrow('bad_date');
    expect(() => billingMonthStart('2026-01-01', '2026-13-01')).toThrow('bad_date');
  });
});

describe('invoiceTotalsLines', () => {
  test('invoice lines covered stays zero', () => {
    expect(invoiceTotalsLines({
      lines: [{ price: 300, covered: true }, { price: 200, covered: false }],
      extras: [{ name: 'Heavy', price: 50 }], memberPercent: 20, depositCredit: 0,
    })).toEqual({ total: 200, credit: 0, balance: 200, refundDue: 0 });
  });
  test('non-member one line matches invoiceTotals', () => {
    const a = invoiceTotalsLines({ lines: [{ price: 200, covered: false }], extras: [{ name: 'Pet hair', price: 30 }], memberPercent: 0, depositCredit: 25 });
    expect(a).toEqual(invoiceTotals({ servicePrice: 200, extras: [{ name: 'Pet hair', price: 30 }], depositCredit: 25 }));
  });
  test('rounds the total once, half up', () => {
    expect(invoiceTotalsLines({ lines: [{ price: 10, covered: false }], extras: [], memberPercent: 15, depositCredit: 0 }).total).toBe(9);
  });
  test('partly covered car pays price - credit, then the % off', () => {
    expect(invoiceTotalsLines({ lines: [{ price: 235, covered: false, credit: 175 }], extras: [], memberPercent: 20, depositCredit: 0 }).total).toBe(48);
  });
  test('owner raises a partly covered car: member pays the new price - credit', () => {
    expect(invoiceTotalsLines({ lines: [{ price: 260, covered: false, credit: 175 }], extras: [], memberPercent: 20, depositCredit: 0 }).total).toBe(68);
  });
  test('owner lowers a partly covered car below its credit: that car is $0, never negative', () => {
    expect(invoiceTotalsLines({ lines: [{ price: 150, covered: false, credit: 175 }, { price: 100, covered: false }], extras: [], memberPercent: 0, depositCredit: 0 }).total).toBe(100);
  });
  test('covered ignores any credit and any price', () => {
    expect(invoiceTotalsLines({ lines: [{ price: 999, covered: true, credit: 5 }], extras: [{ name: 'x', price: 10 }], memberPercent: 20, depositCredit: 0 }).total).toBe(8);
  });
  test('memberQuote lines feed the invoice and give the same total (no reward)', () => {
    const q = memberQuote(CFG, [{ service: 'full', vehicleType: 'sedan' }, { service: 'full', vehicleType: 'suv' }, { service: 'exterior', vehicleType: 'large' }],
      { tier: 'gold', planVehicle: 'sedan', visitsLeft: { full: 1, exterior: 1 }, reward: 'freeWash' });
    const lines = q.lines.map((l) => ({ price: l.startingPrice, covered: l.covered, ...(l.credit === undefined ? {} : { credit: l.credit }) }));
    expect(invoiceTotalsLines({ lines, extras: [], memberPercent: 20, depositCredit: 0 }).total).toBe(q.payable);
  });
  test('percent25 survives at the invoice: 175 -> 25% -> 20% = 105', () => {
    expect(invoiceTotalsLines({ lines: [{ price: 175, covered: false }], extras: [], memberPercent: 20, rewardPercent: 25, depositCredit: 0 }).total).toBe(105);
  });
  test('quote with percent25 = invoice, odd amounts', () => {
    const c = clone();
    c.services.exterior.prices.sedan = 42;
    const cars = [{ service: 'exterior' as const, vehicleType: 'sedan' as const }, { service: 'exterior' as const, vehicleType: 'sedan' as const }, { service: 'full' as const, vehicleType: 'large' as const }];
    const q = memberQuote(c, cars, { tier: 'bronze', planVehicle: 'sedan', visitsLeft: { exterior: 1 }, reward: 'percent25' });
    const lines = q.lines.map((l) => ({ price: l.startingPrice, covered: l.covered, ...(l.credit === undefined ? {} : { credit: l.credit }) }));
    expect(q.rewardPercent).toBe(25);
    expect(invoiceTotalsLines({ lines, extras: [], memberPercent: q.memberPercent, rewardPercent: q.rewardPercent, depositCredit: 0 }).total).toBe(q.payable);
    expect(q.lines.reduce((n, l) => n + l.payable, 0)).toBe(q.payable);
  });
  test('deposit credit capped, excess is refundDue', () => {
    expect(invoiceTotalsLines({ lines: [{ price: 300, covered: true }], extras: [], memberPercent: 20, depositCredit: 45 }))
      .toEqual({ total: 0, credit: 0, balance: 0, refundDue: 45 });
  });
  test.each([
    [{ lines: [], extras: [], memberPercent: 0, depositCredit: 0 }],
    [{ lines: [{ price: -1, covered: false }], extras: [], memberPercent: 0, depositCredit: 0 }],
    [{ lines: [{ price: 1.5, covered: false }], extras: [], memberPercent: 0, depositCredit: 0 }],
    [{ lines: [{ price: 10, covered: 'yes' }], extras: [], memberPercent: 0, depositCredit: 0 }],
    [{ lines: [{ price: 10, covered: false }], extras: [{ name: 'x', price: NaN }], memberPercent: 0, depositCredit: 0 }],
    [{ lines: [{ price: 10, covered: false }], extras: [], memberPercent: 101, depositCredit: 0 }],
    [{ lines: [{ price: 10, covered: false }], extras: [], memberPercent: 0, depositCredit: -1 }],
    [{ lines: null, extras: [], memberPercent: 0, depositCredit: 0 }],
    [{ lines: [{ price: 10, covered: false, credit: -1 }], extras: [], memberPercent: 0, depositCredit: 0 }],
    [{ lines: [{ price: 10, covered: false, credit: 2.5 }], extras: [], memberPercent: 0, depositCredit: 0 }],
    [{ lines: [{ price: 10, covered: false, credit: '5' }], extras: [], memberPercent: 0, depositCredit: 0 }],
    [{ lines: [{ price: 10, covered: false }], extras: [], memberPercent: 0, rewardPercent: 101, depositCredit: 0 }],
    [{ lines: [{ price: 10, covered: false }], extras: [], memberPercent: 0, rewardPercent: 2.5, depositCredit: 0 }],
  ])('bad numbers throw bad_invoice (%#)', (i) => {
    expect(() => invoiceTotalsLines(i as any)).toThrow('bad_invoice');
  });
});
