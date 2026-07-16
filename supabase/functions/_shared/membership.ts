// Pure membership logic — no Deno APIs so jest can run it (same pattern as pricing.ts).
import type { CatalogConfig, Quote, Service } from './pricing.ts';

export type Tier = 'bronze' | 'silver' | 'gold';
export type RewardKey = 'tireShine' | 'miniSpray' | 'percent25' | 'freeWash';

export interface PlanDef { price: number; credits: number; service: Service; rank: number }

export interface MemberCatalog extends CatalogConfig {
  plans: Record<Tier, PlanDef>;
  rewards: Record<RewardKey, number>;      // stamp cost to redeem
  rewardValues: Record<RewardKey, number>; // retail $ value for savings math (0 = computed at apply time)
  anchorPrice: number;
}

export const REWARD_LABELS: Record<RewardKey, string> = {
  tireShine: 'Free tire shine',
  miniSpray: 'Free interior mini-spray',
  percent25: '25% off next detail',
  freeWash: 'Free wash',
};

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export function generateCode(rand: () => number = Math.random): string {
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
