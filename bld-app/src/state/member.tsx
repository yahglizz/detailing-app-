import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../api';

export const TIER_COLORS: Record<string, string> = {
  bronze: '#CD7F32',
  silver: '#C0C0C0',
  gold: '#F5B942',
};

export interface MemberProfile {
  member: { name: string; email: string; tier: 'bronze' | 'silver' | 'gold'; active: boolean; periodStart: string };
  credits: number;
  stamps: number;
  savings: number;
  rewardMenu: { key: string; label: string; cost: number }[];
  issuedRewards: { id: string; reward: string; label: string }[];
  history: { id: string; day: string; slot: string | null; status: string; total: number; paidWithCredit: boolean }[];
}

const KEY = 'bld_member_code';

interface MemberCtx {
  profile: MemberProfile | null;
  code: string | null;
  loading: boolean;
  enter(code: string): Promise<string | null>; // returns error message or null
  refresh(): Promise<void>;
  leave(): void;
  redeem(reward: string): Promise<string | null>;
  requestUpgrade(): Promise<void>;
}

const Ctx = createContext<MemberCtx | null>(null);

async function callMember(body: Record<string, unknown>): Promise<{ data: MemberProfile | { ok: boolean } | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke('member', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const parsed = ctx ? await ctx.json().catch(() => ({})) : {};
    return { data: null, error: parsed.error ?? 'network' };
  }
  return { data, error: null };
}

export function MemberProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async (c: string): Promise<string | null> => {
    const { data, error } = await callMember({ code: c });
    if (error || !data || !('member' in data)) {
      return error === 'invalid_code' || error === 'inactive' ? error : (error ?? 'network');
    }
    setProfile(data as MemberProfile);
    setCode(c);
    await AsyncStorage.setItem(KEY, c);
    return null;
  };

  useEffect(() => {
    AsyncStorage.getItem(KEY).then(async (saved) => {
      if (saved) {
        const err = await load(saved);
        if (err === 'invalid_code' || err === 'inactive') await AsyncStorage.removeItem(KEY);
      }
      setLoading(false);
    });
  }, []);

  const value: MemberCtx = {
    profile, code, loading,
    enter: (c) => load(c.trim().toUpperCase()),
    refresh: async () => { if (code) await load(code); },
    leave: () => { setProfile(null); setCode(null); AsyncStorage.removeItem(KEY); },
    redeem: async (reward) => {
      if (!code) return 'no_code';
      const { error } = await callMember({ code, action: 'redeem', reward });
      if (!error) await load(code);
      return error;
    },
    requestUpgrade: async () => { if (code) await callMember({ code, action: 'upgrade' }); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMember() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMember outside MemberProvider');
  return v;
}
