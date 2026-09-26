import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Mode } from '../theme';

const KEY = 'bld_member_theme';

const Ctx = createContext<{ mode: Mode; toggle(): void }>({ mode: 'dark', toggle: () => {} });

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode>('dark');

  useEffect(() => {
    AsyncStorage.getItem(KEY).then((v) => { if (v === 'light' || v === 'dark') setMode(v); });
  }, []);

  const toggle = () => {
    const next: Mode = mode === 'light' ? 'dark' : 'light';
    setMode(next);
    AsyncStorage.setItem(KEY, next);
  };

  return <Ctx.Provider value={{ mode, toggle }}>{children}</Ctx.Provider>;
}

export const useAppearance = () => useContext(Ctx);
