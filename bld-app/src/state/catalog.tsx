import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { DetailPricing, membershipView } from '../../../supabase/functions/_shared/detail_pricing';
import { detail } from '../api';

export type MembershipView = ReturnType<typeof membershipView>;

// Prices, plans and time slots, straight from the `detail` function's config (the same answer the
// website renders). Nothing is priced on the device: until it loads, screens show a loader.
export interface Catalog {
  pricing: DetailPricing | null;
  membership: MembershipView | null;
  slots: string[];
  today: string;
  loaded: boolean;
  failed: boolean;
  reload(): void;
}

const Ctx = createContext<Catalog>({ pricing: null, membership: null, slots: [], today: '', loaded: false, failed: false, reload: () => {} });

export function CatalogProvider({ children }: { children: React.ReactNode }) {
  const [cfg, setCfg] = useState<Omit<Catalog, 'reload'>>({ pricing: null, membership: null, slots: [], today: '', loaded: false, failed: false });
  const reload = useCallback(() => {
    setCfg((c) => ({ ...c, failed: false }));
    detail<{ pricing: DetailPricing; membership?: MembershipView; slots?: string[]; today?: string }>({ action: 'config' }).then(
      ({ data }) => setCfg((c) => (!data?.pricing
        ? { ...c, failed: true }
        : { pricing: data.pricing, membership: data.membership ?? null, slots: data.slots ?? [], today: data.today ?? '', loaded: true, failed: false })),
      () => setCfg((c) => ({ ...c, failed: true })),
    );
  }, []);
  useEffect(reload, [reload]);
  return <Ctx.Provider value={{ ...cfg, reload }}>{children}</Ctx.Provider>;
}

export const useCatalog = () => useContext(Ctx);
