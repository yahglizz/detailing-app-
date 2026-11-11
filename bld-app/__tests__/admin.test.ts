import { DEFAULT_CATALOG } from '../../supabase/functions/_shared/pricing';
import { MemberCatalog } from '../../supabase/functions/_shared/membership';
import { ACTIONS, can, cleanLines, validateCatalog } from '../../supabase/functions/_shared/admin_rules';

const saved = {
  ...DEFAULT_CATALOG,
  plans: {
    bronze: { price: 79, credits: 2, service: 'outside', rank: 1, discountPercent: 10, topupBonusPercent: 5, stampsPerCar: 1 },
    silver: { price: 99, credits: 2, service: 'inside', rank: 2, discountPercent: 15, topupBonusPercent: 10, stampsPerCar: 2 },
    gold: { price: 199, credits: 2, service: 'full', rank: 3, discountPercent: 20, topupBonusPercent: 15, stampsPerCar: 3 },
  },
  rewards: { tireShine: 3, miniSpray: 5, percent25: 8, freeWash: 10 },
  rewardValues: { tireShine: 15, miniSpray: 15, percent25: 0, freeWash: 0 },
  anchorPrice: 10,
  topup: { min: 10, max: 500 },
  firstWashDiscountPercent: 10,
  packages: { ministry: 220 },
  stripe: { links: { gold: 'https://buy.stripe.com/x' }, prices: { gold: 'price_1' } },
  schedule: { dailyCapacity: 9, closedWeekdays: [0] },
} as MemberCatalog & Record<string, unknown>;

describe('can()', () => {
  const ownerOnly = ['decline', 'members', 'member_add', 'member_tier', 'member_active', 'member_stamp', 'member_vehicle',
    'pricing_get', 'pricing_save', 'detail_pricing_get', 'detail_pricing_save', 'staff_list', 'staff_add', 'staff_remove', 'staff_reset',
    'stripe_status', 'stripe_connect'];

  it('owner may do every action', () => {
    for (const a of ACTIONS) expect(can('owner', a)).toBe(true);
  });
  it('manager may do everything except the owner-only actions', () => {
    for (const a of ACTIONS) expect(can('manager', a)).toBe(!ownerOnly.includes(a));
  });
  it('managers can run the day-to-day jobs', () => {
    for (const a of ['overview', 'confirm', 'done', 'set_day', 'report_add', 'leads']) expect(can('manager', a)).toBe(true);
  });
  it('managers can run the inspection invoice but not edit detail prices', () => {
    for (const a of ['detail_get', 'invoice_save', 'invoice_pay']) expect(can('manager', a)).toBe(true);
    for (const a of ['detail_pricing_get', 'detail_pricing_save']) expect(can('manager', a)).toBe(false);
  });
  it('a price-list edit carries the detail pricing over untouched', () => {
    const prev = { ...saved, detailPricing: { marker: 1 } } as any;
    const r = validateCatalog({ services: { outside: 50 } }, prev);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.config as any).detailPricing).toEqual({ marker: 1 });
  });
  it('member_vehicle is owner only', () => {
    expect(can('owner', 'member_vehicle')).toBe(true);
    expect(can('manager', 'member_vehicle')).toBe(false);
  });
  it('unknown actions are refused for everyone', () => {
    expect(can('owner', 'drop_tables')).toBe(false);
    expect(can('manager', '')).toBe(false);
  });
});

describe('validateCatalog()', () => {
  it('applies valid edits and keeps everything else', () => {
    const r = validateCatalog({ services: { outside: 50 }, extras: { pet: '40' }, depositPercent: 30 }, saved);
    if (!r.ok) throw new Error(r.error);
    expect(r.config.services).toEqual({ outside: 50, inside: 60, full: 120 });
    expect(r.config.extras.pet).toBe(40);
    expect(r.config.depositPercent).toBe(30);
    expect(r.config.stripe).toEqual(saved.stripe);
    expect(r.config.schedule).toEqual(saved.schedule);
    expect(r.config.rewards).toEqual(saved.rewards);
    expect(r.changedPlanPrices).toEqual([]);
  });

  it('does not mutate the saved config', () => {
    validateCatalog({ services: { outside: 1 } }, saved);
    expect(saved.services.outside).toBe(45);
  });

  it('rejects bad numbers', () => {
    const bad: [unknown, string][] = [
      [{ services: { outside: 0 } }, 'services.outside'],
      [{ services: { outside: 45.5 } }, 'services.outside'],
      [{ services: { outside: 'abc' } }, 'services.outside'],
      [{ depositPercent: 101 }, 'depositPercent'],
      [{ sizeMultipliers: { suv: 9 } }, 'sizeMultipliers.suv'],
      [{ plans: { gold: { credits: 0 } } }, 'plans.gold.credits'],
      [{ plans: { gold: { discountPercent: -1 } } }, 'plans.gold.discountPercent'],
      [{ topup: { min: 600 } }, 'topup.min'],
    ];
    for (const [input, path] of bad) expect(validateCatalog(input, saved)).toEqual({ ok: false, error: `bad_value:${path}` });
  });

  it('ignores keys the catalog does not have', () => {
    const r = validateCatalog({ services: { wax: 10 }, stripe: { links: {} } }, saved);
    if (!r.ok) throw new Error(r.error);
    expect(r.config.services).toEqual(saved.services);
    expect(r.config.stripe).toEqual(saved.stripe);
  });

  it('reports which plan prices changed', () => {
    const r = validateCatalog({ plans: { gold: { price: 219 }, bronze: { price: 79, discountPercent: 12 } } }, saved);
    if (!r.ok) throw new Error(r.error);
    expect(r.changedPlanPrices).toEqual(['gold']);
    expect(r.config.plans.bronze.discountPercent).toBe(12);
    expect(r.config.plans.gold.service).toBe('full');
  });

  it('rejects a non-object', () => {
    expect(validateCatalog(null, saved)).toEqual({ ok: false, error: 'bad_config' });
  });
});

describe('cleanLines()', () => {
  // as the detail function stores them in bookings.quote.lines
  const quote = [
    { service: 'full', vehicleType: 'sedan', startingPrice: 175, deposit: 25, covered: true, payable: 0 },
    { service: 'full', vehicleType: 'large', startingPrice: 235, deposit: 45, covered: false, payable: 48, credit: 175 },
    { service: 'exterior', vehicleType: 'suv', startingPrice: 50, deposit: 35, covered: false, payable: 40 },
  ];

  it('cleanLines forces covered lines to 0', () => {
    const r = cleanLines([{ price: 500 }, { price: 235 }, { price: 50 }], quote);
    expect(r?.[0]).toEqual({ price: 0, covered: true });
  });

  it('cleanLines keeps credit from the quote', () => {
    // the client can only send prices: a covered flag or credit it sends is ignored
    const r = cleanLines([{ price: 0, covered: false }, { price: 260, credit: 999 }, { price: 55, covered: true, credit: 50 }], quote);
    expect(r).toEqual([
      { price: 0, covered: true },
      { price: 260, covered: false, credit: 175 },
      { price: 55, covered: false },
    ]);
  });

  it('cleanLines rejects wrong count / non-integer', () => {
    expect(cleanLines([{ price: 175 }, { price: 235 }], quote)).toBeNull();
    expect(cleanLines([{ price: 175 }, { price: 235 }, { price: 50 }, { price: 1 }], quote)).toBeNull();
    expect(cleanLines([{ price: 175 }, { price: 235.5 }, { price: 50 }], quote)).toBeNull();
    expect(cleanLines([{ price: 175 }, { price: '235' }, { price: 50 }], quote)).toBeNull();
    expect(cleanLines([{ price: 175 }, { price: -1 }, { price: 50 }], quote)).toBeNull();
    expect(cleanLines([{ price: 175 }, { price: 10001 }, { price: 50 }], quote)).toBeNull();
    expect(cleanLines([{ price: 175 }, null, { price: 50 }], quote)).toBeNull();
    expect(cleanLines('nope', quote)).toBeNull();
  });

  it('an old single-car quote (no lines) takes one uncovered line', () => {
    expect(cleanLines([{ price: 190 }], undefined)).toEqual([{ price: 190, covered: false }]);
    expect(cleanLines([{ price: 190 }], [])).toEqual([{ price: 190, covered: false }]);
    expect(cleanLines([{ price: 190 }, { price: 1 }], undefined)).toBeNull();
  });
});
