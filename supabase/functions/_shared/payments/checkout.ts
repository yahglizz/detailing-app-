// Pure checkout helpers — no Deno APIs so jest (and the app) can use them, same
// pattern as pricing.ts.
import type { CarItem, CatalogConfig, Extra, Service, Size } from '../pricing.ts';

export type PayMode = 'deposit' | 'full';

// Where Stripe may send the customer back to: the app's own deep links only (checkout-
// return redirects there), so neither function can be used as an open redirect.
export const APP_LINK = /^(exp|exps|bld):\/\/\S+$/;

// What the customer pays online now: the deposit (rest at the detail) or everything.
export function amountDue(payable: number, deposit: number, mode: PayMode): number {
  return mode === 'full' ? payable : deposit;
}

// Who pays what: prepaid balance first, then the card (the deposit or all of the
// rest), and whatever's left at the detail.
export function splitPayment(payable: number, wallet: number, depositPercent: number, mode: PayMode) {
  const walletUsed = Math.max(0, Math.min(wallet, payable));
  const rest = payable - walletUsed;
  const deposit = rest === 0 ? 0 : Math.round((rest * depositPercent) / 100);
  const due = amountDue(rest, deposit, mode);
  return { walletUsed, rest, deposit, due, atDetail: rest - due };
}

// Cars from an untrusted request, checked against the live catalog. `label` is the
// customer's own name for a saved car ("Mom's Tahoe"): trimmed, capped, optional.
export function cleanItems(raw: unknown, cfg: CatalogConfig): CarItem[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 6) return null;
  const sizes = Object.keys(cfg.sizeMultipliers), services = Object.keys(cfg.services), extras = Object.keys(cfg.extras);
  const out: CarItem[] = [];
  for (const r of raw) {
    const i = (r ?? {}) as Record<string, unknown>;
    if (!sizes.includes(i.size as string) || !services.includes(i.service as string)) return null;
    if (!Array.isArray(i.extras) || !i.extras.every((e) => extras.includes(e))) return null;
    const car: CarItem = { size: i.size as Size, service: i.service as Service, extras: [...new Set(i.extras as Extra[])] };
    const label = typeof i.label === 'string' ? i.label.trim().slice(0, 40) : '';
    if (label) car.label = label;
    out.push(car);
  }
  return out;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WINDOWS: Record<string, string> = { morning: 'morning', afternoon: 'afternoon', either: 'any time' };

// "2026-10-04", "13:00" → "Sun, Oct 4 · 1:00 PM". No slot → the window instead.
export function formatWhen(day: string, slot: string | null | undefined, window: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const date = `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (!slot) return `${date} · ${WINDOWS[window] ?? window}`;
  const h = Number(slot.slice(0, 2));
  return `${date} · ${h % 12 || 12}:${slot.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`;
}

const SERVICE_NAMES: Record<Service, string> = { outside: 'Outside detail', inside: 'Inside detail', full: 'Full detail' };
export const SIZE_NAMES: Record<Size, string> = { sedan: 'Sedan', suv: 'SUV', truck: 'Truck/Van' };
const EXTRA_NAMES: Record<Extra, string> = { ceramic: 'Ceramic coating', headlight: 'Headlight restore', engine: 'Engine bay', pet: 'Pet hair/odor' };

// The one line item on the Stripe Checkout page: what's being bought, when and where.
export function checkoutLine(i: {
  items: CarItem[]; mode: PayMode; balance: number; when: string; address: string; perks: string[];
}): { name: string; description: string } {
  const cars = i.items.map((c) => {
    const car = c.label ? `${c.label} (${SIZE_NAMES[c.size]})` : SIZE_NAMES[c.size];
    const extras = c.extras.length ? ` + ${c.extras.map((e) => EXTRA_NAMES[e]).join(', ')}` : '';
    return `${SERVICE_NAMES[c.service]} · ${car}${extras}`;
  });
  const what = cars.length === 1 ? cars[0] : `${cars.length} cars: ${cars.join('; ')}`;
  const name = (i.mode === 'full' ? what : `Deposit · ${what}`).slice(0, 250);
  const paid = i.mode === 'deposit' && i.balance > 0 ? `$${i.balance} due at your detail` : 'Paid in full';
  const description = [i.when, i.address, ...i.perks, paid].join(' · ').slice(0, 500);
  return { name, description };
}
