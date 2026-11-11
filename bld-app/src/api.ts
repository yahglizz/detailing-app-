import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false } },
);

// Calls the `detail` booking function (same API the website uses). On an HTTP error the
// server's {error} code comes back as `error` (with the full body); a network failure is 'network'.
export async function detail<T>(body: Record<string, unknown>): Promise<{ data: T | null; error: string | null; body: Record<string, any> }> {
  const { data, error } = await supabase.functions.invoke('detail', { body });
  if (!error) return { data: data as T, error: null, body: {} };
  const ctx = (error as { context?: unknown }).context;
  const parsed = ctx && typeof (ctx as Response).json === 'function' ? await (ctx as Response).json().catch(() => ({})) : {};
  return { data: null, error: parsed.error ?? 'network', body: parsed };
}
