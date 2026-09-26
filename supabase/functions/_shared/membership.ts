// Pure membership logic — no Deno APIs so jest can run it (same pattern as pricing.ts).
import type { CatalogConfig, Quote, Service, Size } from './pricing.ts';

export type Tier = 'bronze' | 'silver' | 'gold';
export type RewardKey = 'tireShine' | 'miniSpray' | 'percent25' | 'freeWash';

export interface PlanDef {
  price: number; credits: number; service: Service; rank: number;
  // Tier perks (migration 0012). Optional so a catalog without them still prices.
  discountPercent?: number;   // off whatever the credits don't cover
  topupBonusPercent?: number; // extra balance on every top-up
  stampsPerCar?: number;      // reward stamps per car detailed (default 1)
}

export interface MemberCatalog extends CatalogConfig {
  plans: Record<Tier, PlanDef>;
  rewards: Record<RewardKey, number>;      // stamp cost to redeem
  rewardValues: Record<RewardKey, number>; // retail $ value for savings math (0 = computed at apply time)
  anchorPrice: number;
  topup?: { min: number; max: number }; // prepaid balance top-up limits, whole dollars
}

export const REWARD_LABELS: Record<RewardKey, string> = {
  tireShine: 'Free tire shine',
  miniSpray: 'Free interior mini-spray',
  percent25: '25% off next detail',
  freeWash: 'Free wash',
};

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

const cryptoRand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

// Codes unlock prepaid balance, so they come from the CSPRNG, not Math.random.
export function generateCode(rand: () => number = cryptoRand): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return `BLD-${s}`;
}

export function rankOf(tier: Tier | null | undefined, cfg: MemberCatalog): number {
  return tier ? cfg.plans[tier]?.rank ?? 0 : 0;
}

// A credit covers the SERVICE portion of one car whose service matches the plan.
// Extras and non-matching cars stay payable. Deposit percent applies to what's payable.
export function applyCredits(quote: Quote, plan: PlanDef, creditBalance: number) {
  let creditsUsed = 0;
  let discount = 0;
  for (const line of quote.lines) {
    if (creditsUsed >= creditBalance) break;
    if (line.service === plan.service) {
      creditsUsed++;
      discount += line.servicePrice;
    }
  }
  const payable = quote.total - discount;
  const deposit = payable === 0 ? 0 : Math.round((payable * quote.depositPercent) / 100);
  return { payable, deposit, creditsUsed, discount };
}

// percent25: 25% off the payable amount. freeWash: one service price free.
// Physical rewards (tireShine, miniSpray) are fulfilled at the job — no price change.
export function applyReward(payable: number, reward: RewardKey, quote: Quote): number {
  if (reward === 'percent25') return Math.round(payable * 0.75);
  if (reward === 'freeWash') return Math.max(0, payable - quote.lines[0].servicePrice);
  return payable;
}

// A member's price for an order: credits cover matching services, then an issued
// reward, then the tier's % off what's left. `book` charges through this and the
// checkout screen shows it, so the shown price is the charged price.
export function memberPrice(quote: Quote, plan: PlanDef, credits: number, reward: RewardKey | null) {
  const c = applyCredits(quote, plan, credits);
  let payable = c.payable;
  // Never burn a reward on a wash the credits already made free.
  const rewardUsed = !!reward && payable > 0;
  if (rewardUsed) payable = applyReward(payable, reward!, quote);
  const memberDiscount = Math.round((payable * (plan.discountPercent ?? 0)) / 100);
  payable -= memberDiscount;
  return { payable, creditsUsed: c.creditsUsed, rewardUsed, memberDiscount, savings: quote.total - payable };
}

// What a brand-new member of each tier would pay for this order (a month of credits,
// no reward yet) — the checkout upsell for non-members. Ties go to the cheaper plan.
export function bestPlanFor(quote: Quote, plans: Partial<Record<Tier, PlanDef>>) {
  let best: { tier: Tier; payable: number; price: number } | null = null;
  for (const tier of Object.keys(plans) as Tier[]) {
    const plan = plans[tier]!;
    const { payable } = memberPrice(quote, plan, plan.credits, null);
    if (!best || payable < best.payable || (payable === best.payable && plan.price < best.price)) {
      best = { tier, payable, price: plan.price };
    }
  }
  return best;
}

// Extra balance an active member gets on a top-up (whole dollars).
export function topupBonus(amount: number, plan: PlanDef | null | undefined): number {
  return plan ? Math.round((amount * (plan.topupBonusPercent ?? 0)) / 100) : 0;
}

export function monthsActive(periodStartISO: string, todayISO: string): number {
  const a = new Date(periodStartISO + 'T00:00:00Z');
  const b = new Date(todayISO + 'T00:00:00Z');
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) m--;
  return Math.max(0, m);
}

export function computeSavings(i: { creditWashRetail: number; rewardsRetail: number; months: number; monthlyPrice: number }): number {
  return i.creditWashRetail + i.rewardsRetail - i.months * i.monthlyPrice;
}

// ——— member settings (Settings screen: MY INFO + MY CARS) ———
export interface SavedCar { name: string; size: Size }
export interface MemberSettings { name?: string; address?: string; cars?: SavedCar[] }
const CAR_SIZES: Size[] = ['sedan', 'suv', 'truck'];

// Validates a partial settings update from the app; only the fields sent are changed.
export function cleanSettings(raw: unknown): { ok: true; patch: MemberSettings } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const patch: MemberSettings = {};
  if (r.name !== undefined) {
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name || name.length > 60) return { ok: false, error: 'bad_name' };
    patch.name = name;
  }
  if (r.address !== undefined) {
    const address = typeof r.address === 'string' ? r.address.trim() : null;
    if (address === null || address.length > 200) return { ok: false, error: 'bad_address' };
    patch.address = address;
  }
  if (r.cars !== undefined) {
    if (!Array.isArray(r.cars) || r.cars.length > 6) return { ok: false, error: 'bad_cars' };
    const cars: SavedCar[] = [];
    for (const c of r.cars as Record<string, unknown>[]) {
      const name = typeof c?.name === 'string' ? c.name.trim() : '';
      if (!name || name.length > 40 || !CAR_SIZES.includes(c.size as Size)) return { ok: false, error: 'bad_cars' };
      cars.push({ name, size: c.size as Size });
    }
    patch.cars = cars;
  }
  return Object.keys(patch).length ? { ok: true, patch } : { ok: false, error: 'nothing_to_save' };
}
