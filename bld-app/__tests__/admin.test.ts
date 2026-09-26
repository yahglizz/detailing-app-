import { DEFAULT_CATALOG } from '../../supabase/functions/_shared/pricing';
import { MemberCatalog } from '../../supabase/functions/_shared/membership';
import { ACTIONS, can, validateCatalog } from '../../supabase/functions/_shared/admin_rules';

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
  const ownerOnly = ['decline', 'members', 'member_add', 'member_tier', 'member_active', 'member_stamp',
    'pricing_get', 'pricing_save', 'staff_list', 'staff_add', 'staff_remove', 'staff_reset',
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
