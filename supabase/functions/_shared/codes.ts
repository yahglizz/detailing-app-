// Login codes (BLD-XXXXXX). A code is a member's (memberships.code) or, for someone who
// loaded a balance without joining, an account code (customers.code). Either one opens
// the customer's balance, so lookups are rate limited: each wrong code is recorded, and
// an IP with too many recent misses gets 429 before any lookup runs.
import { generateCode, type Tier } from './membership.ts';

// deno-lint-ignore no-explicit-any
type Db = any;

export const CODE_RE = /^BLD-[A-Z2-9]{6}$/;
const WINDOW_MS = 15 * 60e3;
const PER_IP = 10;
// ponytail: backstop in case the IP header can be spoofed (Supabase's docs don't say
// which header hosted functions trust). Caps guessing at ~29k/day for everyone; a flood
// of bad codes also pauses code logins for up to 15 minutes. Tune if that bites.
const ALL_IPS = 300;

export function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip')
    ?? req.headers.get('x-forwarded-for')?.split(',')[0].trim()
    ?? req.headers.get('x-real-ip')
    ?? 'unknown';
}

export interface Account {
  code: string;
  customerId: string;
  membership: { id: string; tier: Tier; period_start: string } | null; // an ACTIVE one, or null
  isTest: boolean; // an owner test account (tier switcher)
}

export async function resolveCode(db: Db, raw: unknown, ip: string): Promise<Account | 'invalid_code' | 'rate_limited'> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const [mine, all] = await Promise.all([
    db.from('code_attempts').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', since),
    db.from('code_attempts').select('id', { count: 'exact', head: true }).gte('created_at', since),
  ]);
  if ((mine.count ?? 0) >= PER_IP || (all.count ?? 0) >= ALL_IPS) return 'rate_limited';

  const code = String(raw ?? '').trim().toUpperCase();
  let customerId: string | null = null;
  let own: { id: string; tier: Tier; active: boolean; period_start: string; is_test: boolean } | null = null;
  if (CODE_RE.test(code)) {
    const { data: m } = await db.from('memberships')
      .select('id, tier, active, period_start, customer_id, is_test').eq('code', code).maybeSingle();
    if (m) {
      own = m;
      customerId = m.customer_id;
    } else {
      const { data: c } = await db.from('customers').select('id').eq('code', code).maybeSingle();
      customerId = c?.id ?? null;
    }
  }
  if (!customerId) {
    await db.from('code_attempts').insert({ ip });
    return 'invalid_code';
  }

  // The code's own membership if it's active, else any active one the customer holds (a
  // lapsed member who re-joined, or an account whose owner joined later). No active
  // membership = a plain balance account: the code still opens the balance.
  let active: { id: string; tier: Tier; period_start: string } | null = own?.active ? own : null;
  if (!active) {
    const { data: m } = await db.from('memberships').select('id, tier, period_start')
      .eq('customer_id', customerId).eq('active', true).order('created_at', { ascending: false }).limit(1);
    active = m?.[0] ?? null;
  }
  return {
    code, customerId, isTest: !!own?.is_test,
    membership: active && { id: active.id, tier: active.tier, period_start: active.period_start },
  };
}

// A code nobody holds in either table. A clash is ~1 in 900 million; the unique
// constraints catch whatever this misses.
export async function freshCode(db: Db): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    const [{ data: m }, { data: c }] = await Promise.all([
      db.from('memberships').select('id').eq('code', code).maybeSingle(),
      db.from('customers').select('id').eq('code', code).maybeSingle(),
    ]);
    if (!m && !c) return code;
  }
  return generateCode();
}

// The code a customer logs in with: their membership's (active first), else their
// account code, minted the first time it's needed. Only ever sent to their own email.
export async function loginCode(db: Db, customerId: string): Promise<string> {
  const { data: m } = await db.from('memberships').select('code').eq('customer_id', customerId)
    .order('active', { ascending: false }).order('created_at', { ascending: false }).limit(1);
  if (m?.[0]?.code) return m[0].code;
  for (let i = 0; i < 5; i++) {
    const { data: c } = await db.from('customers').select('code').eq('id', customerId).single();
    if (c?.code) return c.code;
    const code = await freshCode(db);
    // Only fills an empty slot: a concurrent caller's code wins and is re-read above.
    const { data: set } = await db.from('customers').update({ code }).eq('id', customerId).is('code', null).select('code');
    if (set?.length) return code;
  }
  throw new Error('could not allocate a login code');
}
