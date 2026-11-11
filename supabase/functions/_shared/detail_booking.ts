// Validates a customer's booking request for a detail. Pure, so Jest covers it
// (bld-app/__tests__/detail_booking.test.ts). Any price, deposit or total in the body is
// ignored: the server recomputes everything from the catalog (detail_pricing.ts).
import { ALL_SLOTS } from './bump.ts';
import { isService, isVehicle, type DetailPricing, type DetailService, type VehicleType } from './detail_pricing.ts';

export const PHOTO_EXTS = ['jpg', 'jpeg', 'png', 'heic', 'webp'] as const;
export const MAX_PHOTOS = 4;
export const CONDITIONS = ['light', 'moderate', 'heavy'] as const;

export const MAX_CARS = 6;

export interface ReserveCar {
  year: string;
  make: string;
  vehicleType: VehicleType;
  service: DetailService;
  condition: typeof CONDITIONS[number];
  petHair: boolean;
}

export interface ReserveInput {
  name: string;
  phone: string;
  email: string;
  cars: ReserveCar[];
  memberCode: string | null;
  useBalance: boolean;
  expectedTotal: number | null;
  day: string;
  slot: string;
  street: string;
  zip: string;
  notes: string;
  photoExts: string[];
}

export type ReserveResult = { ok: true; value: ReserveInput } | { ok: false; error: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validDay = (d: string) => {
  if (!ISO_DAY.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
const addDays = (iso: string, n: number) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const str = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');

// opts.minSlot: the earliest bookable start time today ("HH:00"), so a customer can't book a
// time that has already passed or starts within the lead time.
export function validateReserve(body: unknown, cfg: DetailPricing, today: string, opts: { minSlot?: string } = {}): ReserveResult {
  const fail = (error: string): ReserveResult => ({ ok: false, error });
  if (!body || typeof body !== 'object') return fail('missing_fields');
  const b = body as Record<string, any>;

  const name = str(b.name, 60);
  const phone = str(b.phone, 30);
  const email = str(b.email, 254).toLowerCase();
  const street = str(b.street, 120);
  const zip = str(b.zip, 10);
  const day = str(b.day, 10);
  const slot = str(b.slot, 5);
  if (!name || !phone || !email || !street || !zip || !day || !slot) return fail('missing_fields');

  // Legacy body (top-level vehicle/service/...) with no `cars` becomes a one-car list.
  const raw: unknown = b.cars === undefined
    ? [{ ...b.vehicle, vehicleType: b.vehicleType, service: b.service, condition: b.condition, petHair: b.petHair }]
    : b.cars;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CARS) return fail('bad_cars');
  const cars: ReserveCar[] = [];
  for (const c of raw) {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, any>;
    const year = str(o.year, 4);
    const make = str(o.make, 40);
    if (!year || !make) return fail('missing_fields');
    if (!isService(o.service)) return fail('bad_service');
    if (!isVehicle(o.vehicleType)) return fail('bad_vehicle_type');
    if (!(CONDITIONS as readonly string[]).includes(o.condition)) return fail('bad_condition');
    if (!/^(19|20)\d{2}$/.test(year)) return fail('bad_vehicle');
    if (typeof o.petHair !== 'boolean') return fail('bad_answer');
    cars.push({ year, make, vehicleType: o.vehicleType, service: o.service, condition: o.condition, petHair: o.petHair });
  }
  if (!EMAIL.test(email)) return fail('bad_email');
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return fail('bad_phone');
  if (!validDay(day) || day < today || day > addDays(today, cfg.bookingWindowDays)) return fail('bad_day');
  if (!ALL_SLOTS.includes(slot) || (opts.minSlot && day === today && slot < opts.minSlot)) return fail('bad_slot');
  if (!/^\d{5}$/.test(zip)) return fail('bad_zip');

  const exts: unknown[] = b.photoExts === undefined ? [] : b.photoExts;
  if (!Array.isArray(exts) || exts.length > MAX_PHOTOS) return fail('bad_photos');
  const photoExts = exts.map((e) => String(e).toLowerCase());
  if (!photoExts.every((e) => (PHOTO_EXTS as readonly string[]).includes(e))) return fail('bad_photos');

  return {
    ok: true,
    value: {
      name, phone, email, street, zip, day, slot,
      cars,
      memberCode: str(b.memberCode, 20).toUpperCase() || null,
      useBalance: b.useBalance === true,
      expectedTotal: Number.isInteger(b.expectedTotal) && b.expectedTotal >= 0 ? b.expectedTotal : null,
      notes: str(b.notes, 500), photoExts,
    },
  };
}
