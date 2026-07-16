import { DEFAULT_CATALOG, priceOrder, CarItem } from '../../supabase/functions/_shared/pricing';
import {
  generateCode, rankOf, applyCredits, applyReward, monthsActive, computeSavings,
  MemberCatalog, REWARD_LABELS,
} from '../../supabase/functions/_shared/membership';

const cfg: MemberCatalog = {
  ...DEFAULT_CATALOG,
  plans: {
    bronze: { price: 79, credits: 2, service: 'outside', rank: 1 },
    silver: { price: 99, credits: 2, service: 'inside', rank: 2 },
    gold: { price: 199, credits: 2, service: 'full', rank: 3 },
  },
  rewards: { tireShine: 3, miniSpray: 5, percent25: 8, freeWash: 10 },
  rewardValues: { tireShine: 15, miniSpray: 15, percent25: 0, freeWash: 0 },
  anchorPrice: 10,
};
const car = (over: Partial<CarItem> = {}): CarItem => ({ size: 'sedan', service: 'full', extras: [], ...over });

test('generateCode format BLD- + 6 unambiguous chars', () => {
  const code = generateCode();
  expect(code).toMatch(/^BLD-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  expect(generateCode(() => 0)).toBe('BLD-AAAAAA');
});

test('rankOf maps tiers, non-member is 0', () => {
  expect(rankOf('gold', cfg)).toBe(3);
  expect(rankOf('silver', cfg)).toBe(2);
  expect(rankOf('bronze', cfg)).toBe(1);
  expect(rankOf(null, cfg)).toBe(0);
  expect(rankOf(undefined, cfg)).toBe(0);
});

test('applyCredits: matching service goes free, extras still payable', () => {
  const q = priceOrder([car({ service: 'full', extras: ['headlight'] })], cfg); // 120 + 40
  const r = applyCredits(q, cfg.plans.gold, 2);
  expect(r.creditsUsed).toBe(1);
  expect(r.discount).toBe(120);
  expect(r.payable).toBe(40);
  expect(r.deposit).toBe(10); // 25% of 40
});

test('applyCredits: two matching cars, only balance-many covered', () => {
  const q = priceOrder([car(), car()], cfg); // 120 + 120
  const r = applyCredits(q, cfg.plans.gold, 1);
  expect(r.creditsUsed).toBe(1);
  expect(r.payable).toBe(120);
});

test('applyCredits: non-matching service costs full price', () => {
  const q = priceOrder([car({ service: 'outside' })], cfg); // 45
  const r = applyCredits(q, cfg.plans.gold, 2); // gold covers "full" only
  expect(r.creditsUsed).toBe(0);
  expect(r.payable).toBe(45);
});

test('applyCredits: zero payable means zero deposit', () => {
  const q = priceOrder([car()], cfg); // 120
  const r = applyCredits(q, cfg.plans.gold, 2);
  expect(r.payable).toBe(0);
  expect(r.deposit).toBe(0);
});

test('applyReward percent25 and freeWash reduce payable; physical rewards do not', () => {
  const q = priceOrder([car()], cfg); // full 120
  expect(applyReward(100, 'percent25', q)).toBe(75);
  expect(applyReward(160, 'freeWash', q)).toBe(40); // minus one service price (120)
  expect(applyReward(100, 'tireShine', q)).toBe(100);
  expect(applyReward(100, 'miniSpray', q)).toBe(100);
});

test('monthsActive counts whole months elapsed', () => {
  expect(monthsActive('2026-01-16', '2026-07-16')).toBe(6);
  expect(monthsActive('2026-07-01', '2026-07-16')).toBe(0);
});

test('computeSavings = retail used + rewards - fees', () => {
  expect(computeSavings({ creditWashRetail: 480, rewardsRetail: 30, months: 2, monthlyPrice: 199 })).toBe(112);
});

test('reward labels exist for every key', () => {
  expect(Object.keys(REWARD_LABELS).sort()).toEqual(['freeWash', 'miniSpray', 'percent25', 'tireShine']);
});
