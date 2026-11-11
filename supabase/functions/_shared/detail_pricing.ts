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

export interface DetailPricing {
  vehicleTypes: Record<VehicleType, string>;
  deposits: Record<VehicleType, number>;
  bookingWindowDays: number;
  services: Record<DetailService, DetailServiceConfig>;
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

// ——— owner edits ———
const whole = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
const text = (s: unknown, max: number): s is string =>
  typeof s === 'string' && s.trim().length > 0 && s.length <= max;

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
  return { ok: true, value: { vehicleTypes, deposits, bookingWindowDays: n.bookingWindowDays, services } };
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
