// Dashboard rules, kept pure so Jest covers them: who may do what, and what a price
// edit is allowed to change.
import type { MemberCatalog, Tier } from './membership.ts';
import type { InvoiceLine } from './detail_pricing.ts';

export type Role = 'owner' | 'manager';

const EVERYONE = [
  'me', 'overview', 'booking', 'confirm', 'done',
  'calendar', 'set_day', 'set_schedule',
  'customers', 'customer', 'report_add', 'photo_upload_url', 'report_delete',
  'leads', 'lead_status',
  'detail_get', 'invoice_save', 'invoice_pay',
] as const;

const OWNER_ONLY = [
  'decline',
  'members', 'member_add', 'member_tier', 'member_active', 'member_stamp', 'member_vehicle',
  'pricing_get', 'pricing_save', 'detail_pricing_get', 'detail_pricing_save',
  'staff_list', 'staff_add', 'staff_remove', 'staff_reset',
  'stripe_status', 'stripe_connect',
] as const;

export type Action = typeof EVERYONE[number] | typeof OWNER_ONLY[number];
export const ACTIONS: readonly Action[] = [...EVERYONE, ...OWNER_ONLY];

const owner = new Set<string>(OWNER_ONLY);
const known = new Set<string>(ACTIONS);

export function can(role: Role, action: string): boolean {
  if (!known.has(action)) return false;
  return role === 'owner' || !owner.has(action);
}

// ——— per-car invoice edits ———
// The dashboard sends one {price} per car, in the booking's car order. Only the price comes
// from the client: whether a car is covered by an included visit, and a partly covered car's
// credit, come from the quote the server stored at booking. A covered car is stored at $0.
// An old single-car quote (no lines) takes exactly one uncovered line. null = refuse.
export function cleanLines(input: unknown, quoteLines: unknown): InvoiceLine[] | null {
  const q: Obj[] = Array.isArray(quoteLines) && quoteLines.length ? quoteLines : [{}];
  if (!Array.isArray(input) || input.length !== q.length) return null;
  const out: InvoiceLine[] = [];
  for (let i = 0; i < q.length; i++) {
    const price = (input[i] as Obj | null)?.price;
    if (typeof price !== 'number' || !Number.isInteger(price) || price < 0 || price > 10000) return null;
    const covered = q[i]?.covered === true;
    const credit = q[i]?.credit;
    const line: InvoiceLine = { price: covered ? 0 : price, covered };
    if (!covered && Number.isInteger(credit) && credit >= 0 && credit <= 10000) line.credit = credit;
    out.push(line);
  }
  return out;
}

// ——— price edits ———
// The editor may only change these numbers; everything else in the catalog (Stripe
// links, rewards, schedule…) is carried over from the saved config untouched. Keys come
// from the saved config, so an edit can't invent a service the app doesn't know.
type Rule = { min: number; max: number; int: boolean };
const MONEY: Rule = { min: 1, max: 10000, int: true };       // whole dollars
const MONEY0: Rule = { min: 0, max: 10000, int: true };
const PERCENT: Rule = { min: 0, max: 100, int: true };
const MULT: Rule = { min: 0.5, max: 5, int: false };

export type CatalogResult =
  | { ok: true; config: MemberCatalog & Record<string, unknown>; changedPlanPrices: Tier[] }
  | { ok: false; error: string };

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

export function validateCatalog(next: unknown, prev: MemberCatalog & Obj): CatalogResult {
  if (!next || typeof next !== 'object') return { ok: false, error: 'bad_config' };
  const n = next as Obj;
  const out: Obj = JSON.parse(JSON.stringify(prev)); // plain JSON row
  let error = '';

  const take = (path: string[], rule: Rule) => {
    if (error) return;
    let src: unknown = n;
    for (const k of path) src = (src as Obj | undefined)?.[k];
    if (src === undefined) return; // not sent → keep the saved value
    const v = typeof src === 'string' && src.trim() !== '' ? Number(src) : src;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < rule.min || v > rule.max || (rule.int && !Number.isInteger(v))) {
      error = `bad_value:${path.join('.')}`;
      return;
    }
    let dst = out;
    for (const k of path.slice(0, -1)) dst = (dst[k] ??= {});
    dst[path[path.length - 1]] = v;
  };

  for (const k of Object.keys(prev.services ?? {})) take(['services', k], MONEY);
  for (const k of Object.keys(prev.extras ?? {})) take(['extras', k], MONEY);
  for (const k of Object.keys(prev.sizeMultipliers ?? {})) take(['sizeMultipliers', k], MULT);
  take(['depositPercent'], { min: 1, max: 100, int: true });
  take(['anchorPrice'], MONEY0);
  take(['firstWashDiscountPercent'], PERCENT);
  take(['packages', 'ministry'], MONEY);
  take(['topup', 'min'], MONEY);
  take(['topup', 'max'], MONEY);
  for (const t of Object.keys(prev.plans ?? {})) {
    take(['plans', t, 'price'], MONEY);
    take(['plans', t, 'credits'], { min: 1, max: 31, int: true });
    take(['plans', t, 'discountPercent'], PERCENT);
    take(['plans', t, 'topupBonusPercent'], PERCENT);
    take(['plans', t, 'stampsPerCar'], { min: 0, max: 10, int: true });
  }
  if (error) return { ok: false, error };
  if (out.topup && out.topup.min > out.topup.max) return { ok: false, error: 'bad_value:topup.min' };

  const changedPlanPrices = (Object.keys(prev.plans ?? {}) as Tier[])
    .filter((t) => out.plans[t].price !== prev.plans[t].price);
  return { ok: true, config: out as MemberCatalog & Obj, changedPlanPrices };
}
