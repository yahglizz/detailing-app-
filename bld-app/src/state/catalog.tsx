import React, { createContext, useContext, useEffect, useState } from 'react';
import { DEFAULT_CATALOG, type CatalogConfig } from '../../../supabase/functions/_shared/pricing';
import { supabase } from '../api';

const Ctx = createContext<CatalogConfig>(DEFAULT_CATALOG);

export function CatalogProvider({ children }: { children: React.ReactNode }) {
  const [cfg, setCfg] = useState<CatalogConfig>(DEFAULT_CATALOG);
  useEffect(() => {
    supabase.from('catalog').select('config').eq('id', 1).single()
      .then(({ data }) => { if (data?.config) setCfg(data.config as CatalogConfig); });
  }, []);
  return <Ctx.Provider value={cfg}>{children}</Ctx.Provider>;
}

export const useCatalog = () => useContext(Ctx);
