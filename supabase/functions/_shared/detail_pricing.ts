// Starting-price pricing for the five detail services. Pure and dependency-free so Jest
// (bld-app/__tests__/detail_pricing.test.ts) and the Deno edge functions share one copy.
// This is the ONLY place prices are computed. The numbers live in catalog.config.detailPricing
// (seeded by migration 0015, edited in the dashboard Pricing tab); the website and the
// dashboard render what the server returns and never do their own price maths.
// Whole dollars everywhere.

export const SERVICES = ['exterior', 'refresh', 'deep', 'full', 'premium'] as const;
export const VEHICLES = ['sedan', 'suv', 'large'] as const;
export type DetailService = typeof SERVICES[number];
export type VehicleType = typeof VEHICLES[number];

export interface DetailServiceConfig {
  name: string;
  blurb: string;
  includes: string[];
  duration: string;
  popular: boolean;
  prices: Record<VehicleType, number>;
}

export const TIERS = ['bronze', 'silver', 'gold'] as const;
export type MemberTier = typeof TIERS[number];

// A monthly plan: which services are included each month, the monthly price per vehicle type,
// and the perks. The worth and the saving are derived from the service prices (membershipView),
// never typed in, so they can't drift when a service price changes.
export interface MembershipTierConfig {
  name: string;
  tagline: string;
  visits: Partial<Record<DetailService, number>>;
  perks: string[];
  prices: Record<VehicleType, number>;
  rank: number;              // VIP bumping order: 1 bronze, 2 silver, 3 gold (unique)
  stampsPerCar: number;      // reward stamps earned per car when a job is paid
  topupBonusPercent: number; // bonus added to a prepaid top-up
  discountPercent: number;   // % off whatever a visit doesn't cover
}

export interface DetailPricing {
  vehicleTypes: Record<VehicleType, string>;
  deposits: Record<VehicleType, number>;
  bookingWindowDays: number;
  services: Record<DetailService, DetailServiceConfig>;
  membership: Record<MemberTier, MembershipTierConfig>;
}

// Prices and deposits are the owner's. Inclusions, blurbs and durations are DRAFT copy:
// the owner confirms or edits them in the dashboard (Pricing > Detail pricing).
export const DEFAULT_DETAIL_PRICING: DetailPricing = {
  vehicleTypes: { sedan: 'Sedan', suv: 'SUV / Truck', large: 'Large SUV / 3-Row' },
  deposits: { sedan: 25, suv: 35, large: 45 },
  bookingWindowDays: 14,
  services: {
    exterior: {
      name: 'Exterior Wash',
      blurb: 'A careful hand wash that leaves the outside clean and glossy.',
      includes: ['Hand wash and dry', 'Wheels and tires cleaned', 'Exterior windows', 'Tire dressing'],
      duration: '45 to 60 minutes',
      popular: false,
      prices: { sedan: 40, suv: 50, large: 60 },
    },
    refresh: {
      name: 'Interior Refresh',
      blurb: 'A light clean to reset the cabin between details.',
      includes: ['Full vacuum', 'Dash, console and door panels wiped', 'Interior windows', 'Floor mats cleaned', 'Trash removed'],
      duration: '1 to 1.5 hours',
      popular: false,
      prices: { sedan: 80, suv: 95, large: 110 },
    },
    deep: {
      name: 'Interior Deep Clean',
      blurb: 'Top-to-bottom interior cleaning for built-up dirt, stains and odor.',
      includes: ['Deep vacuum including seams and vents', 'Seat and carpet shampoo', 'Steam clean of trim and cupholders', 'Leather cleaned and conditioned', 'Interior windows'],
      duration: '2.5 to 3.5 hours',
      popular: false,
      prices: { sedan: 150, suv: 175, large: 200 },
    },
    full: {
      name: 'Full Detail',
      blurb: 'Inside and out, top to bottom. Our most booked service.',
      includes: ['Exterior hand wash and wheels', 'Full interior deep clean', 'Spray wax or sealant', 'Windows inside and out', 'Tire dressing'],
      duration: '3.5 to 4.5 hours',
      popular: true,
      prices: { sedan: 175, suv: 205, large: 235 },
    },
    premium: {
      name: 'Premium Full Detail',
      blurb: 'The most thorough service, with paint decontamination and longer-lasting protection.',
      includes: ['Everything in Full Detail', 'Clay bar paint decontamination', 'Hand-applied paint sealant', 'Engine bay cleaned', 'Headlight cleaning'],
      duration: '5 to 6.5 hours',
      popular: false,
      prices: { sedan: 260, suv: 295, large: 335 },
    },
  },
  // DRAFT membership: about 20% (Bronze), 22% (Silver) and 25% (Gold) under paying for the same
  // visits one at a time. Names, visits, perks and monthly prices are for the owner to confirm.
  membership: {
    bronze: {
      name: 'Bronze',
      tagline: 'Keep it clean between details.',
      visits: { exterior: 2 },
      perks: ['Priority booking over non-members', '10% off any other service', 'Cancel anytime'],
      prices: { sedan: 65, suv: 80, large: 95 },
      rank: 1, stampsPerCar: 1, topupBonusPercent: 5, discountPercent: 10,
    },
    silver: {
      name: 'Silver',
      tagline: 'Clean inside and out, every month.',
      visits: { exterior: 2, refresh: 1 },
      perks: ['Priority booking ahead of Bronze', '15% off any other service', 'Cancel anytime'],
      prices: { sedan: 125, suv: 150, large: 180 },
      rank: 2, stampsPerCar: 2, topupBonusPercent: 10, discountPercent: 15,
    },
    gold: {
      name: 'Gold',
      tagline: 'A full detail every month, with washes in between.',
      visits: { full: 1, exterior: 2 },
      perks: ['First priority booking', '20% off any other service', 'Cancel anytime'],
      prices: { sedan: 190, suv: 230, large: 265 },
      rank: 3, stampsPerCar: 3, topupBonusPercent: 15, discountPercent: 20,
    },
  },
};

// Membership test against a fixed list, so '__proto__', 'constructor' and 'toString' never pass.
export const isService = (x: unknown): x is DetailService =>
  typeof x === 'string' && (SERVICES as readonly string[]).includes(x);
export const isVehicle = (x: unknown): x is VehicleType =>
  typeof x === 'string' && (VEHICLES as readonly string[]).includes(x);

export function startingPrice(cfg: DetailPricing, s: DetailService, v: VehicleType): number {
  if (!isService(s) || !isVehicle(v)) throw new Error('bad_service_or_vehicle');
  return cfg.services[s].prices[v];
}

// The flat deposit for the vehicle type, never more than the service costs.
export function depositFor(cfg: DetailPricing, s: DetailService, v: VehicleType): number {
  return Math.min(cfg.deposits[v], startingPrice(cfg, s, v));
}

export function quoteDetail(cfg: DetailPricing, s: DetailService, v: VehicleType) {
  const price = startingPrice(cfg, s, v);
  const deposit = depositFor(cfg, s, v);
  return { startingPrice: price, deposit, balance: price - deposit };
}

export const isTier = (x: unknown): x is MemberTier =>
  typeof x === 'string' && (TIERS as readonly string[]).includes(x);

// sedan < suv < large. Saved-car 'truck' is mapped to 'suv' by the caller before it gets here.
export function vehicleRank(v: VehicleType): 0 | 1 | 2 {
  if (!isVehicle(v)) throw new Error('bad_service_or_vehicle');
  return VEHICLES.indexOf(v) as 0 | 1 | 2;
}

// ——— several cars in one visit ———
export const MAX_CARS = 6;
export type CarLine = { service: DetailService; vehicleType: VehicleType };

// Each car priced on its own; deposit = each car's deposit (capped at that car's price) summed.
export function quoteCars(cfg: DetailPricing, cars: CarLine[]) {
  if (!Array.isArray(cars) || cars.length < 1 || cars.length > MAX_CARS) throw new Error('bad_cars');
  const lines = cars.map((c) => ({
    service: c.service, vehicleType: c.vehicleType,
    startingPrice: startingPrice(cfg, c.service, c.vehicleType),
    deposit: depositFor(cfg, c.service, c.vehicleType),
  }));
  return {
    lines,
    subtotal: lines.reduce((n, l) => n + l.startingPrice, 0),
    deposit: lines.reduce((n, l) => n + l.deposit, 0),
  };
}

// ——— member price ———
export type RewardKey = 'tireShine' | 'miniSpray' | 'percent25' | 'freeWash';
export type MemberCtx = {
  tier: MemberTier;
  planVehicle: VehicleType;
  visitsLeft: Partial<Record<DetailService, number>>; // this billing month
  reward: RewardKey | null;                           // oldest issued, unused reward
};

// Order: included visits, then the reward, then the tier's % off what is still payable.
// 1. A visit covers a car of its service up to the plan's vehicle size; a bigger car pays only the
//    difference to the plan-size price. More cars than visits: the most expensive is covered first.
// 2. percent25 = 25% off; freeWash = the cheapest uncovered car free; tireShine/miniSpray are done
//    at the job (no price change). A reward is never spent on a booking that is already free.
// 3. Tier discountPercent off what is still payable.
// The two % offs are applied ONCE on the sum, rounded half up, exactly as invoiceTotalsLines (and
// detail_invoice_pay in SQL) does, so the quote and the job invoice can't drift by a dollar.
// Per-car `payable` is that total shared out (largest remainder), for display; it sums to `payable`.
// Line flags (stored in the booking quote, read by detail_invoice_pay in SQL):
//   covered: true  = the car is free whatever the owner later sets (a full visit, or the freeWash reward)
//   credit         = a bigger car partly covered by a visit: the plan-size price it doesn't pay
//                    (covered stays false, so if the owner raises the price the member pays price - credit)
export type MemberLine = {
  service: DetailService; vehicleType: VehicleType; startingPrice: number; deposit: number;
  covered: boolean; payable: number; credit?: number;
};
export function memberQuote(cfg: DetailPricing, cars: CarLine[], m: MemberCtx) {
  if (!m || !isTier(m.tier) || !isVehicle(m.planVehicle)) throw new Error('bad_member');
  const q = quoteCars(cfg, cars);
  const lines: MemberLine[] = q.lines.map((l) => ({ ...l, covered: false, payable: l.startingPrice }));

  const visitsUsed: Partial<Record<DetailService, number>> = {};
  for (const s of SERVICES) {
    const left = m.visitsLeft?.[s];
    if (!Number.isInteger(left) || (left as number) < 1) continue;
    const idx = lines.map((l, i) => i).filter((i) => lines[i].service === s)
      .sort((a, b) => lines[b].startingPrice - lines[a].startingPrice) // stable: ties keep car order
      .slice(0, left as number);
    for (const i of idx) {
      const l = lines[i];
      if (vehicleRank(l.vehicleType) <= vehicleRank(m.planVehicle)) {
        l.covered = true;
        l.payable = 0;
      } else {
        l.credit = startingPrice(cfg, s, m.planVehicle);
        l.payable = Math.max(0, l.startingPrice - l.credit);
      }
    }
    if (idx.length) visitsUsed[s] = idx.length;
  }

  const sum = () => lines.reduce((n, l) => n + l.payable, 0);
  let rewardUsed = false;
  if (m.reward && sum() > 0) {
    if (m.reward === 'percent25') {
      rewardUsed = true;
    } else if (m.reward === 'freeWash') {
      // never a car a visit already touched (covered or partly covered)
      const free = lines.filter((l) => !l.covered && l.credit === undefined && l.payable > 0)
        .sort((a, b) => a.payable - b.payable)[0];
      if (free) { free.payable = 0; free.covered = true; rewardUsed = true; }
    } else if (m.reward === 'tireShine' || m.reward === 'miniSpray') {
      rewardUsed = true;
    }
  }

  const rewardPercent = rewardUsed && m.reward === 'percent25' ? 25 : 0;
  const memberPercent = cfg.membership[m.tier].discountPercent;
  const base = sum();
  const payable = pctOff(base, rewardPercent, memberPercent);
  const memberDiscount = pctOff(base, rewardPercent, 0) - payable;
  // share `payable` over the cars: floor each car's exact share, then hand the leftover dollars
  // to the biggest fractions (ties: the earlier car). A $0 car has no fraction, so it stays $0.
  const k = (100 - rewardPercent) * (100 - memberPercent);
  const share = lines.map((l, i) => ({ i, n: l.payable * k }));
  for (const x of share) lines[x.i].payable = Math.floor(x.n / 10000);
  let left = payable - sum();
  for (const x of [...share].sort((a, b) => (b.n % 10000) - (a.n % 10000) || a.i - b.i)) {
    if (left-- <= 0) break;
    lines[x.i].payable++;
  }

  const deposit = Math.min(payable, lines.reduce((n, l) => n + (l.payable > 0 ? l.deposit : 0), 0));
  return {
    lines, subtotal: q.subtotal, payable, deposit, visitsUsed, rewardUsed, rewardPercent, memberPercent,
    memberDiscount, savings: q.subtotal - payable,
  };
}

// base x (100 - a)% x (100 - b)%, rounded once, half up, in whole-number maths (no float drift).
// detail_invoice_pay (migration 0017) does the same: round(base * (100-a) * (100-b) / 10000).
const pctOff = (base: number, a: number, b: number) => Math.floor((base * (100 - a) * (100 - b) + 5000) / 10000);

// The start (ISO day) of the member's current billing month: the monthly anniversary of
// period_start, clamped to the month's last day (Jan 31 -> Feb 28). Visits reset on this day.
// periodStart may be a timestamp; only its date part is used.
export function billingMonthStart(periodStart: string, today: string): string {
  const parse = (x: string) => {
    const r = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof x === 'string' ? x : '');
    const d = r && new Date(Date.UTC(+r[1], +r[2] - 1, +r[3]));
    if (!r || !d || d.getUTCMonth() !== +r[2] - 1 || d.getUTCDate() !== +r[3]) throw new Error('bad_date');
    return { y: +r[1], m: +r[2] - 1, d: +r[3] };
  };
  const p = parse(periodStart), t = parse(today);
  const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  if (iso(t.y, t.m, t.d) <= iso(p.y, p.m, p.d)) return iso(p.y, p.m, p.d);
  const anniv = (y: number, m: number) => Math.min(p.d, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
  if (anniv(t.y, t.m) <= t.d) return iso(t.y, t.m, anniv(t.y, t.m));
  const py = t.m === 0 ? t.y - 1 : t.y, pm = t.m === 0 ? 11 : t.m - 1;
  return iso(py, pm, anniv(py, pm));
}

// 00:00 America/New_York on an ISO day, as an ISO timestamp with its offset
// ('2026-01-15T00:00:00-05:00', '2026-07-15T00:00:00-04:00'). The billing month starts at the
// business's midnight, not UTC's. US DST switches at 02:00 local, so the offset at 05:00 UTC
// (00:00 EST / 01:00 EDT, before any switch that day) is the offset at local midnight.
export function easternMidnight(day: string): string {
  const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof day === 'string' ? day : '');
  const d = r && new Date(Date.UTC(+r[1], +r[2] - 1, +r[3], 5));
  if (!r || !d || d.getUTCMonth() !== +r[2] - 1 || d.getUTCDate() !== +r[3]) throw new Error('bad_date');
  const tz = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const off = /^GMT([+-]\d{2}:\d{2})$/.exec(tz);
  if (!off) throw new Error('bad_tz');
  return `${day}T00:00:00${off[1]}`;
}

// What the website shows for the plans: per vehicle type the monthly price, what the same visits
// cost one at a time (worth) and the saving (never negative). All derived here, none typed in.
export function membershipView(cfg: DetailPricing) {
  const out = {} as Record<MemberTier, {
    name: string; tagline: string; perks: string[]; includes: string[];
    prices: Record<VehicleType, { price: number; worth: number; save: number }>;
    rank: number; stampsPerCar: number; topupBonusPercent: number; discountPercent: number;
  }>;
  for (const t of TIERS) {
    const m = cfg.membership[t];
    const entries = SERVICES.filter((s) => (m.visits[s] ?? 0) > 0);
    const prices = {} as Record<VehicleType, { price: number; worth: number; save: number }>;
    for (const v of VEHICLES) {
      const worth = entries.reduce((sum, s) => sum + (m.visits[s] as number) * cfg.services[s].prices[v], 0);
      prices[v] = { price: m.prices[v], worth, save: Math.max(0, worth - m.prices[v]) };
    }
    out[t] = {
      name: m.name, tagline: m.tagline, perks: m.perks,
      includes: entries.map((s) => `${m.visits[s]} × ${cfg.services[s].name}`),
      prices,
      rank: m.rank, stampsPerCar: m.stampsPerCar, topupBonusPercent: m.topupBonusPercent, discountPercent: m.discountPercent,
    };
  }
  return out;
}

// ——— owner edits ———
const whole = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
const text = (s: unknown, max: number): s is string =>
  typeof s === 'string' && s.trim().length > 0 && s.length <= max;

const PLAN_NUMBERS = [
  ['rank', 1, 3], ['stampsPerCar', 1, 10], ['topupBonusPercent', 0, 50], ['discountPercent', 0, 50],
] as const;

export type PricingResult = { ok: true; value: DetailPricing } | { ok: false; error: string };

// Rebuilds the config from known keys only, so a bad or hostile save can't add fields.
export function validateDetailPricing(next: unknown): PricingResult {
  const bad = (path: string): PricingResult => ({ ok: false, error: `bad_value:${path}` });
  if (!next || typeof next !== 'object') return bad('detailPricing');
  const n = next as Record<string, any>;
  if (!whole(n.bookingWindowDays, 1, 60)) return bad('bookingWindowDays');

  const vehicleTypes = {} as Record<VehicleType, string>;
  const deposits = {} as Record<VehicleType, number>;
  for (const v of VEHICLES) {
    if (!text(n.vehicleTypes?.[v], 40)) return bad(`vehicleTypes.${v}`);
    if (!whole(n.deposits?.[v], 1, 10000)) return bad(`deposits.${v}`);
    vehicleTypes[v] = n.vehicleTypes[v].trim();
    deposits[v] = n.deposits[v];
  }

  const services = {} as Record<DetailService, DetailServiceConfig>;
  let popular = 0;
  for (const s of SERVICES) {
    const x = n.services?.[s];
    if (!x || typeof x !== 'object') return bad(`services.${s}`);
    if (!text(x.name, 60)) return bad(`services.${s}.name`);
    if (!text(x.blurb, 160)) return bad(`services.${s}.blurb`);
    if (!text(x.duration, 40)) return bad(`services.${s}.duration`);
    if (typeof x.popular !== 'boolean') return bad(`services.${s}.popular`);
    if (!Array.isArray(x.includes) || x.includes.length < 1 || x.includes.length > 8) return bad(`services.${s}.includes`);
    if (!x.includes.every((i: unknown) => text(i, 80))) return bad(`services.${s}.includes`);
    const prices = {} as Record<VehicleType, number>;
    for (const v of VEHICLES) {
      if (!whole(x.prices?.[v], 1, 10000)) return bad(`services.${s}.prices.${v}`);
      prices[v] = x.prices[v];
    }
    if (x.popular) popular++;
    services[s] = {
      name: x.name.trim(), blurb: x.blurb.trim(), duration: x.duration.trim(), popular: x.popular,
      includes: x.includes.map((i: string) => i.trim()), prices,
    };
  }
  if (popular !== 1) return bad('services.popular');

  const membership = {} as Record<MemberTier, MembershipTierConfig>;
  for (const t of TIERS) {
    const m = n.membership?.[t];
    if (!m || typeof m !== 'object') return bad(`membership.${t}`);
    if (!text(m.name, 30)) return bad(`membership.${t}.name`);
    if (!text(m.tagline, 80)) return bad(`membership.${t}.tagline`);
    if (!Array.isArray(m.perks) || m.perks.length < 1 || m.perks.length > 8 || !m.perks.every((p: unknown) => text(p, 80))) {
      return bad(`membership.${t}.perks`);
    }
    const visits: Partial<Record<DetailService, number>> = {};
    for (const s of SERVICES) {
      const c = m.visits?.[s];
      if (c === undefined) continue;
      if (!whole(c, 1, 8)) return bad(`membership.${t}.visits.${s}`);
      visits[s] = c;
    }
    if (Object.keys(visits).length < 1) return bad(`membership.${t}.visits`);
    const prices = {} as Record<VehicleType, number>;
    for (const v of VEHICLES) {
      if (!whole(m.prices?.[v], 1, 10000)) return bad(`membership.${t}.prices.${v}`);
      prices[v] = m.prices[v];
    }
    // Plan numbers. Missing (a config saved before they existed) = the default for this tier,
    // so the live config keeps validating until the migration writes them.
    const num = {} as Record<typeof PLAN_NUMBERS[number][0], number>;
    for (const [k, min, max] of PLAN_NUMBERS) {
      const x = m[k] === undefined ? DEFAULT_DETAIL_PRICING.membership[t][k] : m[k];
      if (!whole(x, min, max)) return bad(`membership.${t}.${k}`);
      num[k] = x;
    }
    membership[t] = {
      name: m.name.trim(), tagline: m.tagline.trim(), visits, perks: m.perks.map((p: string) => p.trim()), prices,
      rank: num.rank, stampsPerCar: num.stampsPerCar, topupBonusPercent: num.topupBonusPercent, discountPercent: num.discountPercent,
    };
  }
  if (new Set(TIERS.map((t) => membership[t].rank)).size !== TIERS.length) return bad('membership.rank');
  return { ok: true, value: { vehicleTypes, deposits, bookingWindowDays: n.bookingWindowDays, services, membership } };
}

// ——— the in-person invoice ———
export interface InvoiceExtra { name: string; price: number }

// Final price + approved extras, then the deposit is credited (never more than the total,
// so the balance can't go negative; any excess is reported as refundDue). Throws 'bad_invoice' on any number that isn't a
// whole, non-negative dollar amount within range.
export function invoiceTotals(i: { servicePrice: number; extras: InvoiceExtra[]; depositCredit: number }) {
  if (!whole(i.servicePrice, 0, 10000) || !whole(i.depositCredit, 0, 10000) || !Array.isArray(i.extras)) {
    throw new Error('bad_invoice');
  }
  let total = i.servicePrice;
  for (const e of i.extras) {
    if (!e || !whole(e.price, 0, 10000)) throw new Error('bad_invoice');
    total += e.price;
  }
  const credit = Math.min(i.depositCredit, total);
  // refundDue: deposit that was taken but isn't needed because the final total is below it
  return { total, credit, balance: total - credit, refundDue: i.depositCredit - credit };
}

// Per-car invoice. A covered car (full visit or freeWash) stays $0 whatever its price; a partly
// covered car pays max(0, price - credit); those plus the extras (extras on covered cars too) get
// the reward % (percent25, from the quote) and the member % off, rounded once on the total. Then the deposit is credited as in invoiceTotals.
// Throws 'bad_invoice' on any bad number. detail_invoice_pay (migration 0017) is the SQL twin.
export type InvoiceLine = { price: number; covered: boolean; credit?: number };
export const linePayable = (l: InvoiceLine) => (l.covered ? 0 : Math.max(0, l.price - (l.credit ?? 0)));
export function invoiceTotalsLines(i: {
  lines: InvoiceLine[]; extras: InvoiceExtra[]; memberPercent: number; depositCredit: number; rewardPercent?: number;
}) {
  const rewardPercent = i?.rewardPercent ?? 0;
  if (!i || !Array.isArray(i.lines) || i.lines.length < 1 || i.lines.length > MAX_CARS || !Array.isArray(i.extras)
    || !whole(i.memberPercent, 0, 100) || !whole(rewardPercent, 0, 100) || !whole(i.depositCredit, 0, 10000)) {
    throw new Error('bad_invoice');
  }
  let gross = 0;
  for (const l of i.lines) {
    if (!l || !whole(l.price, 0, 10000) || typeof l.covered !== 'boolean') throw new Error('bad_invoice');
    if (l.credit !== undefined && !whole(l.credit, 0, 10000)) throw new Error('bad_invoice');
    gross += linePayable(l);
  }
  for (const e of i.extras) {
    if (!e || !whole(e.price, 0, 10000)) throw new Error('bad_invoice');
    gross += e.price;
  }
  // the reward % (percent25) then the member %, rounded once, half up — same as memberQuote
  const total = pctOff(gross, rewardPercent, i.memberPercent);
  const credit = Math.min(i.depositCredit, total);
  return { total, credit, balance: total - credit, refundDue: i.depositCredit - credit };
}
