import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../api';
import type { MemberSettings, SavedCar, Tier } from '../../../supabase/functions/_shared/membership';

export const TIER_COLORS: Record<string, string> = {
  bronze: '#CD7F32',
  silver: '#C0C0C0',
  gold: '#F5B942',
};

// Anyone with a code: a member (tier set, active) or a balance account (tier null).
export interface MemberProfile {
  member: {
    name: string; email: string; tier: Tier | null; active: boolean; periodStart: string | null;
    address: string; cars: SavedCar[]; // Settings → MY INFO / MY CARS, autofilled at checkout
  };
  wallet: number; // prepaid balance, whole dollars
  isTest: boolean; // owner test account: shows the tier switcher
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
  saveSettings(patch: MemberSettings): Promise<string | null>; // returns error or null
  testTier(tier: Tier | 'none'): Promise<string | null>; // test accounts only
  testBalance(): Promise<string | null>; // test accounts only: +$50
}

const Ctx = createContext<MemberCtx | null>(null);

async function callMember(body: Record<string, unknown>): Promise<{ data: MemberProfile | { ok: boolean } | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke('member', { body });
  if (error) {
    // On an HTTP error, `context` is the Response and carries our {error} body.
    // On a real network failure it's the raw fetch error (no .json) — treat as
    // 'network' rather than letting ctx.json() throw and hang the caller.
    const ctx = (error as { context?: unknown }).context;
    let parsed: { error?: string } = {};
    if (ctx && typeof (ctx as Response).json === 'function') {
      parsed = await (ctx as Response).json().catch(() => ({}));
    }
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
    if (error || !data || !('member' in data)) return error ?? 'network';
    const p = data as MemberProfile;
    setProfile({
      ...p, wallet: p.wallet ?? 0, isTest: !!p.isTest,
      member: { ...p.member, tier: p.member.tier ?? null, address: p.member.address ?? '', cars: p.member.cars ?? [] },
    });
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
    saveSettings: async (patch) => {
      if (!code) return 'no_code';
      const { data, error } = await callMember({ code, action: 'save_settings', settings: patch });
      if (error) return error;
      // Only the server's {ok} means saved: a member function from before this action
      // answers with the plain profile and drops the change.
      if (!data || !('ok' in data)) return 'save_failed';
      setProfile((p) => p && { ...p, member: { ...p.member, ...patch } });
      return null;
    },
    testTier: async (tier) => {
      if (!code) return 'no_code';
      const { error } = await callMember({ code, action: 'test_tier', tier });
      if (!error) await load(code);
      return error;
    },
    testBalance: async () => {
      if (!code) return 'no_code';
      const { error } = await callMember({ code, action: 'test_balance' });
      if (!error) await load(code);
      return error;
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMember() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMember outside MemberProvider');
  return v;
}
