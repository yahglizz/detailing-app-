export type Size = 'sedan' | 'suv' | 'truck';
export type Service = 'outside' | 'inside' | 'full';
export type Extra = 'ceramic' | 'headlight' | 'engine' | 'pet';

export interface CarItem {
  size: Size;
  service: Service;
  extras: Extra[];
}

export interface CatalogConfig {
  services: Record<Service, number>;
  extras: Record<Extra, number>;
  sizeMultipliers: Record<Size, number>;
  depositPercent: number;
}

export interface QuoteLine {
  car: number;
  size: Size;
  service: Service;
  servicePrice: number;
  extras: { name: Extra; price: number }[];
  lineTotal: number;
}

export interface Quote {
  lines: QuoteLine[];
  total: number;
  depositPercent: number;
  deposit: number;
  remainder: number;
}

export const DEFAULT_CATALOG: CatalogConfig = {
  services: { outside: 45, inside: 60, full: 120 },
  extras: { ceramic: 199, headlight: 40, engine: 35, pet: 35 },
  sizeMultipliers: { sedan: 1, suv: 1.25, truck: 1.5 },
  depositPercent: 25,
};

export function priceOrder(items: CarItem[], cfg: CatalogConfig): Quote {
  if (items.length === 0) throw new Error('empty order');
  const lines: QuoteLine[] = items.map((item, i) => {
    const servicePrice = Math.round(cfg.services[item.service] * cfg.sizeMultipliers[item.size]);
    const extras = item.extras.map((e) => ({ name: e, price: cfg.extras[e] }));
    const lineTotal = servicePrice + extras.reduce((s, e) => s + e.price, 0);
    return { car: i + 1, size: item.size, service: item.service, servicePrice, extras, lineTotal };
  });
  const total = lines.reduce((s, l) => s + l.lineTotal, 0);
  const deposit = Math.round((total * cfg.depositPercent) / 100);
  return { lines, total, depositPercent: cfg.depositPercent, deposit, remainder: total - deposit };
}
