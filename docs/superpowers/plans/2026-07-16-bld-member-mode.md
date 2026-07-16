# BLD Member Mode (Round 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membership codes unlock a member dashboard (washes left, savings, stamps/rewards, upgrade) with credit-paid bookings and rank-based priority bumping; non-members can buy a $10 slot anchor; all prices flow from the Supabase `catalog` table into both the app and the website.

**Architecture:** Pure decision logic (credits, savings, bump matrix, code generation) lives in `supabase/functions/_shared/` and is jest-tested from the app workspace. Edge functions (`member`, `book`, `owner-members`, `sweep`) stay thin wrappers around that logic. The Expo app adds a member context + two screens and threads member state through the existing booking flow. The website gets a small fetch script reading the same catalog row.

**Tech Stack:** Expo SDK 57 / React Native 0.86 / TypeScript, Supabase (Postgres + Deno edge functions, project `fiaadogbkvjcddehnymj`), jest-expo, Resend email (dry-run without key).

**Spec:** `docs/superpowers/specs/2026-07-16-bld-member-mode-design.md` — the source of truth. Re-read it before starting any task.

## Global Constraints

- Supabase project is `fiaadogbkvjcddehnymj` (brotherly-love-detailing). The `blessings-daycare` project must never be referenced, shared, or modified.
- Expo has changed: consult https://docs.expo.dev/versions/v57.0.0/ before writing Expo API code (per `bld-app/AGENTS.md`).
- All prices (services, extras, plans, rewards, anchor) live in `catalog.config` — never hardcode a price in app code or edge functions; `DEFAULT_CATALOG` in `pricing.ts` is the only static fallback.
- Payment provider stays the FakeProvider behind `getProvider()`; nothing outside `_shared/payments/` may import processor code.
- Notifications are email-only via `_shared/notify.ts` (`sendEmail` dry-runs without `RESEND_API_KEY`).
- Design language: colors/fonts from `bld-app/src/theme.ts` (bg `#0E0D11`, surface `#141217`, border `#34303A`, purple `#7028C9→#A855F7`, League Spartan headings). Tier accents: bronze `#CD7F32`, silver `#C0C0C0`, gold `#F5B942`.
- Ledgers (`credit_ledger`, `reward_ledger`) are append-only; balances are `sum(delta)`; DB triggers forbid negative balances.
- Booking windows: members ≤ 30 days ahead, non-members ≤ 7 — enforced server-side in `book`.
- Bump matrix (server-only, in `_shared/bump.ts`): higher rank bumps lower (bumped booking → very next open slot same day + email); anchored bookings never bumped; equal member ranks escalate to owner; non-member vs non-member = plain `slot_taken`.
- Time slots are hourly `09:00`–`17:00` (9 slots), format `HH:MM`, mirrored in `Schedule.tsx` `SLOTS` and server `ALL_SLOTS`.
- Git: commit after every task; conventional messages (`feat:`, `test:`, `fix:`).
- Jest runs from `bld-app/`: `cd bld-app && npx jest` (roots already include `../supabase/functions/_shared`).
- Deploy edge functions and apply migrations via the Supabase MCP tools (`apply_migration`, `deploy_edge_function`) against project `fiaadogbkvjcddehnymj`; also save every migration as a numbered file in `supabase/migrations/`.

---

### Task 1: Migration 0005 — member schema + catalog plans + slot_states RPC

**Files:**
- Create: `supabase/migrations/0005_member_mode.sql`

**Interfaces:**
- Produces: `memberships.code/tier`, `reward_ledger`, `redemptions`, `bookings.membership_id/anchored/bumped_from/rank/paid_with_credit`, `slot_states(day)` RPC, `catalog.config.plans/rewards/rewardValues/anchorPrice` — used by every later task.

- [ ] **Step 1: Write the migration file** `supabase/migrations/0005_member_mode.sql`:

```sql
-- Member mode (Round 2). Applied to project fiaadogbkvjcddehnymj via MCP
-- apply_migration "member_mode".

-- Plans, reward stamp costs, reward retail values (for savings math), anchor price.
update catalog set config = config || '{
  "plans": {
    "bronze": {"price": 79,  "credits": 2, "service": "outside", "rank": 1},
    "silver": {"price": 99,  "credits": 2, "service": "inside",  "rank": 2},
    "gold":   {"price": 199, "credits": 2, "service": "full",    "rank": 3}
  },
  "rewards": {"tireShine": 3, "miniSpray": 5, "percent25": 8, "freeWash": 10},
  "rewardValues": {"tireShine": 15, "miniSpray": 15, "percent25": 0, "freeWash": 0},
  "anchorPrice": 10
}'::jsonb where id = 1;

alter table memberships add column if not exists code text unique;
alter table memberships add column if not exists tier text
  check (tier in ('bronze','silver','gold'));

create table if not exists reward_ledger (
  id bigint generated always as identity primary key,
  membership_id uuid not null references memberships(id),
  delta int not null check (delta <> 0),
  reason text not null,
  booking_id uuid references bookings(id),
  created_at timestamptz not null default now()
);

create or replace function enforce_nonnegative_stamps() returns trigger language plpgsql as $$
declare bal int;
begin
  select coalesce(sum(delta), 0) into bal from reward_ledger where membership_id = new.membership_id;
  if bal < 0 then
    raise exception 'stamp balance cannot go negative';
  end if;
  return new;
end $$;
drop trigger if exists reward_ledger_nonnegative on reward_ledger;
create trigger reward_ledger_nonnegative after insert on reward_ledger
  for each row execute function enforce_nonnegative_stamps();

create table if not exists redemptions (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references memberships(id),
  reward text not null check (reward in ('tireShine','miniSpray','percent25','freeWash')),
  stamps_spent int not null check (stamps_spent > 0),
  retail_value int not null default 0,
  status text not null default 'issued' check (status in ('issued','applied')),
  booking_id uuid references bookings(id),
  created_at timestamptz not null default now()
);

alter table bookings add column if not exists membership_id uuid references memberships(id);
alter table bookings add column if not exists anchored boolean not null default false;
alter table bookings add column if not exists bumped_from text;
alter table bookings add column if not exists rank int not null default 0;
alter table bookings add column if not exists paid_with_credit boolean not null default false;

alter table reward_ledger enable row level security;
alter table redemptions enable row level security;
-- No public policies: all reads/writes go through edge functions with service role.

-- Availability with priority info: slot + holder rank + anchored, no PII.
create or replace function slot_states(day date)
returns table(slot text, rank int, anchored boolean)
language sql
security definer
set search_path = public
stable
as $$
  select time_slot, bookings.rank, bookings.anchored from bookings
  where preferred_day = day
    and time_slot is not null
    and status not in ('declined', 'refunded')
$$;

revoke all on function slot_states(date) from public;
grant execute on function slot_states(date) to anon, authenticated;
```

- [ ] **Step 2: Apply via Supabase MCP** — `apply_migration` on project `fiaadogbkvjcddehnymj`, name `member_mode`, query = the file content.

- [ ] **Step 3: Verify** — `execute_sql`: `select config->'plans'->'gold'->>'price' as gold, (select count(*) from information_schema.columns where table_name='bookings' and column_name in ('membership_id','anchored','bumped_from','rank','paid_with_credit')) as cols from catalog;`
Expected: `gold = 199`, `cols = 5`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0005_member_mode.sql
git commit -m "feat: member mode schema — plans in catalog, codes, stamps, redemptions, slot_states"
```

---

### Task 2: Shared membership logic (`_shared/membership.ts`)

**Files:**
- Create: `supabase/functions/_shared/membership.ts`
- Test: `bld-app/__tests__/membership.test.ts`

**Interfaces:**
- Consumes: `CatalogConfig`, `Quote`, `Service` from `./pricing.ts` (Task 0 / existing).
- Produces (used by Tasks 4, 5, 8, 9):
  - `type Tier = 'bronze' | 'silver' | 'gold'`
  - `type RewardKey = 'tireShine' | 'miniSpray' | 'percent25' | 'freeWash'`
  - `interface PlanDef { price: number; credits: number; service: Service; rank: number }`
  - `interface MemberCatalog extends CatalogConfig { plans: Record<Tier, PlanDef>; rewards: Record<RewardKey, number>; rewardValues: Record<RewardKey, number>; anchorPrice: number }`
  - `const REWARD_LABELS: Record<RewardKey, string>`
  - `generateCode(rand?: () => number): string` — `BLD-` + 6 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
  - `rankOf(tier: Tier | null | undefined, cfg: MemberCatalog): number`
  - `applyCredits(quote: Quote, plan: PlanDef, creditBalance: number): { payable: number; deposit: number; creditsUsed: number; discount: number }`
  - `applyReward(payable: number, reward: RewardKey, quote: Quote): number`
  - `monthsActive(periodStartISO: string, todayISO: string): number`
  - `computeSavings(i: { creditWashRetail: number; rewardsRetail: number; months: number; monthlyPrice: number }): number`

- [ ] **Step 1: Write the failing tests** `bld-app/__tests__/membership.test.ts`:

```ts
import { DEFAULT_CATALOG, priceOrder, CarItem } from '../../supabase/functions/_shared/pricing';
import {
  generateCode, rankOf, applyCredits, applyReward, monthsActive, computeSavings,
  MemberCatalog, REWARD_LABELS,
} from '../../supabase/functions/_shared/membership';

const cfg: MemberCatalog = {
  ...DEFAULT_CATALOG,
  plans: {
    bronze: { price: 79, credits: 2, service: 'outside', rank: 1 },
    silver: { price: 99, credits: 2, service: 'inside', rank: 2 },
    gold: { price: 199, credits: 2, service: 'full', rank: 3 },
  },
  rewards: { tireShine: 3, miniSpray: 5, percent25: 8, freeWash: 10 },
  rewardValues: { tireShine: 15, miniSpray: 15, percent25: 0, freeWash: 0 },
  anchorPrice: 10,
};
const car = (over: Partial<CarItem> = {}): CarItem => ({ size: 'sedan', service: 'full', extras: [], ...over });

test('generateCode format BLD- + 6 unambiguous chars', () => {
  const code = generateCode();
  expect(code).toMatch(/^BLD-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  expect(generateCode(() => 0)).toBe('BLD-AAAAAA');
});

test('rankOf maps tiers, non-member is 0', () => {
  expect(rankOf('gold', cfg)).toBe(3);
  expect(rankOf('silver', cfg)).toBe(2);
  expect(rankOf('bronze', cfg)).toBe(1);
  expect(rankOf(null, cfg)).toBe(0);
  expect(rankOf(undefined, cfg)).toBe(0);
});

test('applyCredits: matching service goes free, extras still payable', () => {
  const q = priceOrder([car({ service: 'full', extras: ['headlight'] })], cfg); // 120 + 40
  const r = applyCredits(q, cfg.plans.gold, 2);
  expect(r.creditsUsed).toBe(1);
  expect(r.discount).toBe(120);
  expect(r.payable).toBe(40);
  expect(r.deposit).toBe(10); // 25% of 40
});

test('applyCredits: two matching cars, only balance-many covered', () => {
  const q = priceOrder([car(), car()], cfg); // 120 + 120
  const r = applyCredits(q, cfg.plans.gold, 1);
  expect(r.creditsUsed).toBe(1);
  expect(r.payable).toBe(120);
});

test('applyCredits: non-matching service costs full price', () => {
  const q = priceOrder([car({ service: 'outside' })], cfg); // 45
  const r = applyCredits(q, cfg.plans.gold, 2); // gold covers "full" only
  expect(r.creditsUsed).toBe(0);
  expect(r.payable).toBe(45);
});

test('applyCredits: zero payable means zero deposit', () => {
  const q = priceOrder([car()], cfg); // 120
  const r = applyCredits(q, cfg.plans.gold, 2);
  expect(r.payable).toBe(0);
  expect(r.deposit).toBe(0);
});

test('applyReward percent25 and freeWash reduce payable; physical rewards do not', () => {
  const q = priceOrder([car()], cfg); // full 120
  expect(applyReward(100, 'percent25', q)).toBe(75);
  expect(applyReward(160, 'freeWash', q)).toBe(40); // minus one service price (120)
  expect(applyReward(100, 'tireShine', q)).toBe(100);
  expect(applyReward(100, 'miniSpray', q)).toBe(100);
});

test('monthsActive counts whole months elapsed', () => {
  expect(monthsActive('2026-01-16', '2026-07-16')).toBe(6);
  expect(monthsActive('2026-07-01', '2026-07-16')).toBe(0);
});

test('computeSavings = retail used + rewards - fees', () => {
  expect(computeSavings({ creditWashRetail: 480, rewardsRetail: 30, months: 2, monthlyPrice: 199 })).toBe(112);
});

test('reward labels exist for every key', () => {
  expect(Object.keys(REWARD_LABELS).sort()).toEqual(['freeWash', 'miniSpray', 'percent25', 'tireShine']);
});
```

- [ ] **Step 2: Run to verify failure** — `cd bld-app && npx jest membership` — FAIL (module not found).

- [ ] **Step 3: Implement** `supabase/functions/_shared/membership.ts`:

```ts
// Pure membership logic — no Deno APIs so jest can run it (same pattern as pricing.ts).
import type { CatalogConfig, Quote, Service } from './pricing.ts';

export type Tier = 'bronze' | 'silver' | 'gold';
export type RewardKey = 'tireShine' | 'miniSpray' | 'percent25' | 'freeWash';

export interface PlanDef { price: number; credits: number; service: Service; rank: number }

export interface MemberCatalog extends CatalogConfig {
  plans: Record<Tier, PlanDef>;
  rewards: Record<RewardKey, number>;      // stamp cost to redeem
  rewardValues: Record<RewardKey, number>; // retail $ value for savings math (0 = computed at apply time)
  anchorPrice: number;
}

export const REWARD_LABELS: Record<RewardKey, string> = {
  tireShine: 'Free tire shine',
  miniSpray: 'Free interior mini-spray',
  percent25: '25% off next detail',
  freeWash: 'Free wash',
};

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export function generateCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return `BLD-${s}`;
}

export function rankOf(tier: Tier | null | undefined, cfg: MemberCatalog): number {
  return tier ? cfg.plans[tier]?.rank ?? 0 : 0;
}

// A credit covers the SERVICE portion of one car whose service matches the plan.
// Extras and non-matching cars stay payable. Deposit percent applies to what's payable.
export function applyCredits(quote: Quote, plan: PlanDef, creditBalance: number) {
  let creditsUsed = 0;
  let discount = 0;
  for (const line of quote.lines) {
    if (creditsUsed >= creditBalance) break;
    if (line.service === plan.service) {
      creditsUsed++;
      discount += line.servicePrice;
    }
  }
  const payable = quote.total - discount;
  const deposit = payable === 0 ? 0 : Math.round((payable * quote.depositPercent) / 100);
  return { payable, deposit, creditsUsed, discount };
}

// percent25: 25% off the payable amount. freeWash: one service price free.
// Physical rewards (tireShine, miniSpray) are fulfilled at the job — no price change.
export function applyReward(payable: number, reward: RewardKey, quote: Quote): number {
  if (reward === 'percent25') return Math.round(payable * 0.75);
  if (reward === 'freeWash') return Math.max(0, payable - quote.lines[0].servicePrice);
  return payable;
}

export function monthsActive(periodStartISO: string, todayISO: string): number {
  const a = new Date(periodStartISO + 'T00:00:00Z');
  const b = new Date(todayISO + 'T00:00:00Z');
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) m--;
  return Math.max(0, m);
}

export function computeSavings(i: { creditWashRetail: number; rewardsRetail: number; months: number; monthlyPrice: number }): number {
  return i.creditWashRetail + i.rewardsRetail - i.months * i.monthlyPrice;
}
```

Note: jest resolves the `./pricing.ts` extension import the same way the existing `_shared` imports work; if the `.ts` extension trips jest, import from `'./pricing'` in a `pricing` re-export — check `pricing.ts` first: existing files import `'../_shared/pricing.ts'` only from Deno code; app code imports `'../../../supabase/functions/_shared/pricing'`. Use `import type { ... } from './pricing.ts'` — type-only imports are erased and safe for both runtimes.

- [ ] **Step 4: Run tests** — `cd bld-app && npx jest membership` — PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/membership.ts bld-app/__tests__/membership.test.ts
git commit -m "feat: membership pure logic — codes, ranks, credits, rewards, savings"
```

---

### Task 3: Bump engine (`_shared/bump.ts`)

**Files:**
- Create: `supabase/functions/_shared/bump.ts`
- Test: `bld-app/__tests__/bump.test.ts`

**Interfaces:**
- Produces (used by Task 5):
  - `const ALL_SLOTS: string[]` — `['09:00',...,'17:00']` (9 hourly, must equal `Schedule.tsx` SLOTS keys)
  - `interface SlotHolder { rank: number; anchored: boolean }`
  - `type BumpDecision = 'open' | 'bump' | 'blocked' | 'escalate'`
  - `decideBump(bookerRank: number, holder: SlotHolder | null): BumpDecision`
  - `nextOpenSlot(taken: string[], fromSlot: string): string | null` — first slot strictly after `fromSlot` not in `taken`

- [ ] **Step 1: Write the failing tests** `bld-app/__tests__/bump.test.ts`:

```ts
import { ALL_SLOTS, decideBump, nextOpenSlot } from '../../supabase/functions/_shared/bump';

test('ALL_SLOTS is 09:00..17:00 hourly', () => {
  expect(ALL_SLOTS).toHaveLength(9);
  expect(ALL_SLOTS[0]).toBe('09:00');
  expect(ALL_SLOTS[8]).toBe('17:00');
});

test('empty slot is open for anyone', () => {
  expect(decideBump(0, null)).toBe('open');
  expect(decideBump(3, null)).toBe('open');
});

test('anchored is blocked for every rank', () => {
  expect(decideBump(3, { rank: 0, anchored: true })).toBe('blocked');
  expect(decideBump(1, { rank: 0, anchored: true })).toBe('blocked');
});

test('higher rank bumps lower', () => {
  expect(decideBump(3, { rank: 0, anchored: false })).toBe('bump');
  expect(decideBump(3, { rank: 2, anchored: false })).toBe('bump');
  expect(decideBump(1, { rank: 0, anchored: false })).toBe('bump');
});

test('equal member ranks escalate to owner', () => {
  expect(decideBump(3, { rank: 3, anchored: false })).toBe('escalate');
  expect(decideBump(1, { rank: 1, anchored: false })).toBe('escalate');
});

test('equal non-member rank is plain blocked (slot_taken)', () => {
  expect(decideBump(0, { rank: 0, anchored: false })).toBe('blocked');
});

test('lower rank cannot bump higher', () => {
  expect(decideBump(1, { rank: 3, anchored: false })).toBe('blocked');
  expect(decideBump(0, { rank: 1, anchored: false })).toBe('blocked');
});

test('nextOpenSlot finds first free slot after, or null', () => {
  expect(nextOpenSlot(['10:00'], '10:00')).toBe('11:00');
  expect(nextOpenSlot(['10:00', '11:00'], '10:00')).toBe('12:00');
  expect(nextOpenSlot(ALL_SLOTS, '10:00')).toBeNull();
  expect(nextOpenSlot([], '17:00')).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure** — `cd bld-app && npx jest bump` — FAIL.

- [ ] **Step 3: Implement** `supabase/functions/_shared/bump.ts`:

```ts
// Priority bump decision matrix. Pure — jest-tested. Server is the only caller
// that ACTS on these decisions; the app may use them for display hints only.

export const ALL_SLOTS: string[] = Array.from({ length: 9 }, (_, i) => `${String(9 + i).padStart(2, '0')}:00`);

export interface SlotHolder { rank: number; anchored: boolean }

export type BumpDecision = 'open' | 'bump' | 'blocked' | 'escalate';

export function decideBump(bookerRank: number, holder: SlotHolder | null): BumpDecision {
  if (!holder) return 'open';
  if (holder.anchored) return 'blocked';
  if (bookerRank > holder.rank) return 'bump';
  if (bookerRank === holder.rank && bookerRank > 0) return 'escalate';
  return 'blocked';
}

export function nextOpenSlot(taken: string[], fromSlot: string): string | null {
  const t = new Set(taken);
  for (const s of ALL_SLOTS) {
    if (s > fromSlot && !t.has(s)) return s;
  }
  return null;
}
```

- [ ] **Step 4: Run tests** — `cd bld-app && npx jest bump` — PASS. Also run full suite: `npx jest` — all green.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/bump.ts bld-app/__tests__/bump.test.ts
git commit -m "feat: bump decision matrix + next-open-slot"
```

---

### Task 4: `member` edge function — profile, redeem, upgrade request

**Files:**
- Create: `supabase/functions/member/index.ts`

**Interfaces:**
- Consumes: `membership.ts` (Task 2), `notify.ts`, tables from Task 1.
- Produces (used by Tasks 8, 9, 11): HTTP POST JSON API:
  - `{ code }` → `200 { member: { name, email, tier, active, periodStart }, credits, stamps, savings, rewardMenu: [{key,label,cost}], issuedRewards: [{id,reward,label}], history: [{id, day, slot, status, total, paidWithCredit}] }`
  - `{ code, action: 'redeem', reward }` → `200 { ok: true, stamps }` or `400 { error: 'not_enough_stamps' }`
  - `{ code, action: 'upgrade' }` → `200 { ok: true }` (emails owner)
  - bad code → `404 { error: 'invalid_code' }`; deactivated → `403 { error: 'inactive' }`

- [ ] **Step 1: Implement** `supabase/functions/member/index.ts`:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  applyReward, computeSavings, monthsActive, REWARD_LABELS,
  type MemberCatalog, type RewardKey,
} from '../_shared/membership.ts';
import { sendEmail, ownerEmail } from '../_shared/notify.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  let body: { code?: string; action?: string; reward?: RewardKey };
  try { body = await req.json(); } catch { return Response.json({ error: 'bad_json' }, { status: 400 }); }
  const code = (body.code ?? '').trim().toUpperCase();
  if (!/^BLD-[A-Z2-9]{6}$/.test(code)) return Response.json({ error: 'invalid_code' }, { status: 404 });

  const { data: m } = await db
    .from('memberships')
    .select('id, tier, active, period_start, customer_id, customers(name, email)')
    .eq('code', code)
    .single();
  if (!m) return Response.json({ error: 'invalid_code' }, { status: 404 });
  if (!m.active) return Response.json({ error: 'inactive' }, { status: 403 });

  const { data: cat } = await db.from('catalog').select('config').eq('id', 1).single();
  const cfg = cat!.config as MemberCatalog;
  const plan = cfg.plans[m.tier as keyof typeof cfg.plans];

  if (body.action === 'redeem') {
    const reward = body.reward as RewardKey;
    if (!cfg.rewards[reward]) return Response.json({ error: 'unknown_reward' }, { status: 400 });
    const cost = cfg.rewards[reward];
    const { data: bal } = await db.from('reward_ledger').select('delta').eq('membership_id', m.id);
    const stamps = (bal ?? []).reduce((s, r) => s + r.delta, 0);
    if (stamps < cost) return Response.json({ error: 'not_enough_stamps' }, { status: 400 });
    const { error: spendErr } = await db.from('reward_ledger').insert({
      membership_id: m.id, delta: -cost, reason: `redeem:${reward}`,
    });
    if (spendErr) return Response.json({ error: 'not_enough_stamps' }, { status: 400 });
    await db.from('redemptions').insert({
      membership_id: m.id, reward, stamps_spent: cost,
      retail_value: cfg.rewardValues[reward] ?? 0,
    });
    return Response.json({ ok: true, stamps: stamps - cost });
  }

  if (body.action === 'upgrade') {
    const cust = m.customers as unknown as { name: string; email: string };
    await sendEmail(ownerEmail(), `Upgrade request — ${cust.name || cust.email} (${m.tier})`,
      `<h2 style="color:#A855F7;margin:0 0 12px">Member wants to upgrade</h2>
       <p><b>${cust.name || 'Member'}</b> (${cust.email}, code ${code}, current tier ${m.tier}) tapped Upgrade.
       Call them, take payment, then change their tier on your members page.</p>`);
    return Response.json({ ok: true });
  }

  // Default action: full profile.
  const [{ data: creditRows }, { data: stampRows }, { data: issued }, { data: history }] = await Promise.all([
    db.from('credit_ledger').select('delta').eq('membership_id', m.id),
    db.from('reward_ledger').select('delta').eq('membership_id', m.id),
    db.from('redemptions').select('id, reward').eq('membership_id', m.id).eq('status', 'issued'),
    db.from('bookings').select('id, preferred_day, time_slot, status, quote, paid_with_credit')
      .eq('membership_id', m.id).order('created_at', { ascending: false }).limit(20),
  ]);
  const credits = (creditRows ?? []).reduce((s, r) => s + r.delta, 0);
  const stamps = (stampRows ?? []).reduce((s, r) => s + r.delta, 0);

  const creditWashRetail = (history ?? [])
    .filter((b) => b.paid_with_credit && !['declined', 'refunded'].includes(b.status))
    .reduce((s, b) => s + ((b.quote as { total: number }).total - ((b.quote as { payable?: number }).payable ?? 0)), 0);
  const { data: applied } = await db.from('redemptions').select('retail_value').eq('membership_id', m.id);
  const rewardsRetail = (applied ?? []).reduce((s, r) => s + r.retail_value, 0);
  const today = new Date().toISOString().slice(0, 10);
  const months = monthsActive(String(m.period_start), today);
  const savings = computeSavings({ creditWashRetail, rewardsRetail, months, monthlyPrice: plan.price });

  const cust = m.customers as unknown as { name: string; email: string };
  return Response.json({
    member: { name: cust.name, email: cust.email, tier: m.tier, active: m.active, periodStart: m.period_start },
    credits, stamps, savings,
    rewardMenu: (Object.keys(cfg.rewards) as RewardKey[]).map((key) => ({ key, label: REWARD_LABELS[key], cost: cfg.rewards[key] })),
    issuedRewards: (issued ?? []).map((r) => ({ id: r.id, reward: r.reward, label: REWARD_LABELS[r.reward as RewardKey] })),
    history: (history ?? []).map((b) => ({
      id: b.id, day: b.preferred_day, slot: b.time_slot, status: b.status,
      total: (b.quote as { total: number }).total, paidWithCredit: b.paid_with_credit,
    })),
  });
});
```

Note `applyReward` import is unused here — do not import it (lint hygiene). Import only what's used: `computeSavings`, `monthsActive`, `REWARD_LABELS`, types.

- [ ] **Step 2: Deploy** — MCP `deploy_edge_function` project `fiaadogbkvjcddehnymj`, name `member`, with `verify_jwt: false`? No — keep default JWT verification OFF for this function is NOT acceptable; the function must be callable with the anon key header (`Authorization: Bearer <anon>`), which passes default verification. Deploy with default settings; include `_shared/membership.ts`, `_shared/pricing.ts`, `_shared/notify.ts` files in the deploy payload.

- [ ] **Step 3: Smoke test with curl** (ANON = value of `EXPO_PUBLIC_SUPABASE_ANON_KEY` in `bld-app/.env`):

```bash
curl -s -X POST "https://fiaadogbkvjcddehnymj.supabase.co/functions/v1/member" \
  -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" \
  -d '{"code":"BLD-NOPE22"}'
```
Expected: `{"error":"invalid_code"}` (404).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/member/index.ts
git commit -m "feat: member edge function — profile, redeem, upgrade request"
```

---

### Task 5: `book` extension — windows, credits, anchor, bump engine

**Files:**
- Modify: `supabase/functions/book/index.ts`

**Interfaces:**
- Consumes: `decideBump`, `nextOpenSlot`, `ALL_SLOTS` (Task 3); `applyCredits`, `applyReward`, `rankOf`, `MemberCatalog` (Task 2); Task 1 columns.
- Produces (used by Tasks 9, 11): extended `BookBody` fields — `memberCode?: string`, `anchor?: boolean`. New error codes: `too_far_out` (400), `slot_taken` (409, unchanged), `escalated` (200 — booking created without slot, owner resolving). Response gains `{ payable, creditsUsed, bumped: boolean, escalated: boolean }`.
- Card becomes optional when the computed deposit is 0 (`card?: CardDetails`).

- [ ] **Step 1: Rewrite** `supabase/functions/book/index.ts`. Full new content:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2';
import { priceOrder, type CarItem, type CatalogConfig } from '../_shared/pricing.ts';
import { getProvider } from '../_shared/payments/provider.ts';
import type { CardDetails } from '../_shared/payments/types.ts';
import { sendEmail, ownerEmail, functionsBaseUrl, button } from '../_shared/notify.ts';
import { applyCredits, applyReward, rankOf, type MemberCatalog, type RewardKey, REWARD_LABELS } from '../_shared/membership.ts';
import { decideBump, nextOpenSlot } from '../_shared/bump.ts';

interface BookBody {
  items: CarItem[];
  address: string;
  preferredDay: string; // YYYY-MM-DD
  timeSlot?: string; // 24h "HH:MM"
  window: 'morning' | 'afternoon' | 'either';
  notes: string;
  remainderMethod: 'cash' | 'card';
  name: string;
  expectedTotal: number;
  card?: CardDetails;
  memberCode?: string;
  anchor?: boolean;
}

const MEMBER_WINDOW_DAYS = 30;
const PUBLIC_WINDOW_DAYS = 7;

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user || !user.email) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let body: BookBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  if (!body.address?.trim() || !body.preferredDay) return Response.json({ error: 'missing_fields' }, { status: 400 });
  if (body.timeSlot && !/^[0-2][0-9]:[0-5][0-9]$/.test(body.timeSlot)) {
    return Response.json({ error: 'bad_time_slot' }, { status: 400 });
  }

  const { data: cat, error: catErr } = await admin.from('catalog').select('config').eq('id', 1).single();
  if (catErr) return Response.json({ error: 'catalog_unavailable' }, { status: 500 });
  const cfg = cat.config as MemberCatalog;

  // ——— membership lookup (code = identity) ———
  let membership: { id: string; tier: string; customer_id: string } | null = null;
  if (body.memberCode) {
    const { data: m } = await admin.from('memberships')
      .select('id, tier, active, customer_id')
      .eq('code', body.memberCode.trim().toUpperCase())
      .single();
    if (!m || !m.active) return Response.json({ error: 'invalid_code' }, { status: 403 });
    membership = m;
  }
  const bookerRank = rankOf(membership?.tier as 'bronze' | 'silver' | 'gold' | undefined, cfg);

  // ——— booking window: members 30 days out, everyone else 7 ———
  const today = new Date();
  const limit = new Date(today);
  limit.setDate(limit.getDate() + (membership ? MEMBER_WINDOW_DAYS : PUBLIC_WINDOW_DAYS));
  if (body.preferredDay > limit.toISOString().slice(0, 10)) {
    return Response.json({ error: 'too_far_out', maxDays: membership ? MEMBER_WINDOW_DAYS : PUBLIC_WINDOW_DAYS }, { status: 400 });
  }

  // ——— slot decision: open / bump / blocked / escalate ———
  let bumped = false;
  let escalated = false;
  let holderBooking: { id: string; rank: number; anchored: boolean; customer_id: string } | null = null;
  if (body.timeSlot) {
    const { data: clash } = await admin
      .from('bookings')
      .select('id, rank, anchored, customer_id')
      .eq('preferred_day', body.preferredDay)
      .eq('time_slot', body.timeSlot)
      .not('status', 'in', '("declined","refunded")')
      .limit(1);
    holderBooking = clash?.[0] ?? null;
    const decision = decideBump(bookerRank, holderBooking ? { rank: holderBooking.rank, anchored: holderBooking.anchored } : null);
    if (decision === 'blocked') return Response.json({ error: 'slot_taken' }, { status: 409 });
    if (decision === 'escalate') escalated = true;
    if (decision === 'bump') bumped = true;
  }

  // ——— price: retail quote, then credits, then issued reward, then anchor ———
  let quote;
  try {
    quote = priceOrder(body.items, cfg as CatalogConfig);
  } catch (e) {
    return Response.json({ error: String((e as Error).message) }, { status: 400 });
  }
  if (body.expectedTotal !== quote.total) {
    return Response.json({ error: 'price_changed', quote }, { status: 409 });
  }

  let payable = quote.total;
  let creditsUsed = 0;
  let appliedRedemption: { id: string; reward: RewardKey } | null = null;
  if (membership) {
    const plan = cfg.plans[membership.tier as keyof typeof cfg.plans];
    const { data: creditRows } = await admin.from('credit_ledger').select('delta').eq('membership_id', membership.id);
    const balance = (creditRows ?? []).reduce((s, r) => s + r.delta, 0);
    const applied = applyCredits(quote, plan, balance);
    payable = applied.payable;
    creditsUsed = applied.creditsUsed;

    const { data: issued } = await admin.from('redemptions')
      .select('id, reward').eq('membership_id', membership.id).eq('status', 'issued')
      .order('created_at').limit(1);
    if (issued?.[0]) {
      appliedRedemption = issued[0] as { id: string; reward: RewardKey };
      payable = applyReward(payable, appliedRedemption.reward, quote);
    }
  }
  const anchored = !membership && body.anchor === true;
  if (anchored) payable += cfg.anchorPrice;

  const depositPercent = quote.depositPercent;
  const deposit = payable === 0 ? 0 : Math.round((payable * depositPercent) / 100);
  if (deposit > 0 && !body.card) return Response.json({ error: 'card_required' }, { status: 400 });

  await admin.from('customers').upsert({ id: user.id, email: user.email, name: body.name ?? '' });

  const confirmToken = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const fullQuote = { ...quote, payable, deposit, remainder: payable - deposit, creditsUsed, anchored };
  const { data: booking, error: insErr } = await admin
    .from('bookings')
    .insert({
      customer_id: user.id,
      items: body.items,
      quote: fullQuote,
      address: body.address.trim(),
      preferred_day: body.preferredDay,
      time_slot: escalated ? null : body.timeSlot ?? null,
      time_window: body.window,
      notes: body.notes ?? '',
      remainder_method: body.remainderMethod,
      status: 'pending_payment',
      confirm_token: confirmToken,
      membership_id: membership?.id ?? null,
      anchored,
      rank: bookerRank,
      paid_with_credit: creditsUsed > 0,
    })
    .select()
    .single();
  if (insErr) return Response.json({ error: 'booking_insert_failed' }, { status: 500 });

  if (deposit > 0) {
    const charge = await getProvider().chargeDeposit({
      bookingId: booking.id,
      amountCents: deposit * 100,
      card: body.card!,
    });
    if (!charge.ok) return Response.json({ error: charge.error }, { status: 402 });
    await admin.from('payments').insert({
      booking_id: booking.id, kind: 'deposit', amount_cents: deposit * 100,
      status: 'succeeded', provider: 'fake', provider_ref: charge.ref,
    });
  }

  // ——— commit side effects AFTER money: credits, redemption, bump ———
  if (membership && creditsUsed > 0) {
    await admin.from('credit_ledger').insert({
      membership_id: membership.id, delta: -creditsUsed, reason: 'wash', booking_id: booking.id,
    });
  }
  if (appliedRedemption) {
    await admin.from('redemptions').update({ status: 'applied', booking_id: booking.id }).eq('id', appliedRedemption.id);
  }

  if (bumped && holderBooking) {
    const { data: takenRows } = await admin.rpc('slot_states', { day: body.preferredDay });
    const taken = ((takenRows ?? []) as { slot: string }[]).map((r) => r.slot);
    const target = nextOpenSlot([...taken, body.timeSlot!], body.timeSlot!);
    if (target) {
      await admin.from('bookings')
        .update({ time_slot: target, bumped_from: body.timeSlot, time_window: Number(target.slice(0, 2)) < 12 ? 'morning' : 'afternoon' })
        .eq('id', holderBooking.id);
      const { data: holderCust } = await admin.from('customers').select('email').eq('id', holderBooking.customer_id).single();
      if (holderCust?.email) {
        await sendEmail(holderCust.email, `Your detail moved to ${target} — here's why`,
          `<h2 style="color:#A855F7;margin:0 0 12px">Small schedule change</h2>
           <p>A VIP member reserved your original window, so your detail on <b>${body.preferredDay}</b> moved from ${body.timeSlot} to <b>${target}</b>.</p>
           <p style="color:#A9A4AF">Members never get bumped — ask us about membership, or add a $${cfg.anchorPrice} Slot Anchor next time to lock your time.</p>`);
      }
    } else {
      // Nowhere to move the holder — do not double-book. Escalate instead.
      escalated = true;
      await admin.from('bookings').update({ time_slot: null }).eq('id', booking.id);
      await sendEmail(ownerEmail(), `Slot conflict needs you — ${body.preferredDay} ${body.timeSlot}`,
        `<h2 style="color:#A855F7;margin:0 0 12px">No room to bump</h2>
         <p>A rank-${bookerRank} member booked ${body.preferredDay} ${body.timeSlot}, but the day is full so nobody can be moved automatically. Set the exact time on the confirm page.</p>
         ${button(`${functionsBaseUrl()}/confirm?token=${confirmToken}`, 'Resolve →')}`);
    }
  }
  if (escalated && !bumped) {
    await sendEmail(ownerEmail(), `Two members want ${body.preferredDay} ${body.timeSlot} — pick one`,
      `<h2 style="color:#A855F7;margin:0 0 12px">Equal-rank conflict</h2>
       <p>Two members of the same tier want <b>${body.preferredDay} ${body.timeSlot}</b>. The newer booking has no time yet — set its exact time on the confirm page.</p>
       ${button(`${functionsBaseUrl()}/confirm?token=${confirmToken}`, 'Resolve →')}`);
  }

  await admin.from('bookings').update({ status: 'requested' }).eq('id', booking.id);

  const summary = body.items
    .map((i, n) => `<div>Car ${n + 1}: <b>${i.service}</b> / ${i.size}${i.extras.length ? ' + ' + i.extras.join(', ') : ''}</div>`)
    .join('');
  const link = `${functionsBaseUrl()}/confirm?token=${confirmToken}`;
  const shortSummary = body.items.map((i) => `${i.service}/${i.size}`).join(', ');
  const memberTag = membership ? ` — MEMBER ${membership.tier.toUpperCase()}${creditsUsed ? ` (${creditsUsed} credit)` : ''}` : '';
  const rewardTag = appliedRedemption ? `<p style="color:#F5B942">Reward attached: ${REWARD_LABELS[appliedRedemption.reward]}</p>` : '';

  await sendEmail(
    ownerEmail(),
    `New detail — ${shortSummary}${memberTag} — $${deposit} deposit${deposit ? ' PAID' : ' (credit)'}`,
    `<h2 style="color:#A855F7;margin:0 0 12px">New Detail Request${memberTag}</h2>
     ${summary}${rewardTag}
     <p style="color:#A9A4AF">${body.preferredDay} · ${escalated ? 'TIME CONFLICT — resolve' : body.timeSlot ?? body.window} · ${body.address}</p>
     <p style="color:#A9A4AF">Notes: ${body.notes || '—'}</p>
     <p>Retail $${quote.total} · Payable $${payable} · Deposit $${deposit} · $${payable - deposit} due (${body.remainderMethod})${anchored ? ' · ANCHORED' : ''}</p>
     ${button(link, 'Confirm or decline →')}`,
  );

  await sendEmail(
    user.email,
    membership && payable === 0
      ? 'Your member wash is booked'
      : `We got your detail request — $${deposit} deposit received`,
    `<h2 style="color:#A855F7;margin:0 0 12px">Thanks${body.name ? ', ' + body.name : ''}!</h2>
     ${summary}${rewardTag}
     <p style="color:#A9A4AF">${body.preferredDay} · ${escalated ? "we'll confirm your exact time shortly" : body.timeSlot ?? body.window} · ${body.address}</p>
     ${creditsUsed ? `<p>Paid with ${creditsUsed} membership credit${creditsUsed > 1 ? 's' : ''}.</p>` : ''}
     ${deposit ? `<p>Deposit paid: $${deposit}. Due at the detail: $${payable - deposit} (${body.remainderMethod}).</p>` : ''}
     ${anchored ? `<p>Slot Anchor active — your time is locked. 🔒</p>` : ''}
     <p style="color:#A9A4AF">We'll email you shortly to lock in your exact time.</p>`,
  );

  return Response.json({ bookingId: booking.id, quote: fullQuote, payable, creditsUsed, bumped, escalated });
});
```

- [ ] **Step 2: Deploy** via MCP `deploy_edge_function` (name `book`, include `_shared` files: `pricing.ts`, `membership.ts`, `bump.ts`, `notify.ts`, `payments/provider.ts`, `payments/types.ts`).

- [ ] **Step 3: Smoke test** — unauthorized call returns 401:

```bash
curl -s -X POST "https://fiaadogbkvjcddehnymj.supabase.co/functions/v1/book" \
  -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" -d '{}'
```
Expected: `{"error":"unauthorized"}` (the anon key alone is not a user session). Full behavior is covered by the Task 11 E2E.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/book/index.ts
git commit -m "feat: book — member credits, rewards, anchor, booking windows, bump engine"
```

---

### Task 6: `owner-members` function — add/manage members, mark jobs done

**Files:**
- Create: `supabase/functions/owner-members/index.ts`

**Interfaces:**
- Consumes: `generateCode`, `REWARD_LABELS`, `MemberCatalog` (Task 2); Task 1 tables; `notify.ts`.
- Produces: owner HTML page at `GET /owner-members?token=<OWNER_ADMIN_TOKEN>`; POST actions `add` (name, email, tier → shows code), `deactivate`, `tier`, `stamp` (+1), `done` (booking → status done + stamps). Token from env `OWNER_ADMIN_TOKEN`. Task 11 uses `add` + `done`.

- [ ] **Step 1: Implement** `supabase/functions/owner-members/index.ts` (HTML style copied from `confirm/index.ts`):

```ts
import { createClient } from 'npm:@supabase/supabase-js@2';
import { generateCode, type MemberCatalog, type Tier } from '../_shared/membership.ts';
import { sendEmail } from '../_shared/notify.ts';

const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const page = (inner: string) => new Response(
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BLD Members</title><style>
  body{background:#0E0D11;color:#fff;font-family:system-ui;margin:0;padding:24px;max-width:560px;margin-inline:auto}
  .card{background:#141217;border:1px solid #34303A;border-radius:16px;padding:20px;margin-bottom:16px}
  h1{font-size:22px;color:#A855F7}h2{font-size:16px;color:#fff}.muted{color:#A9A4AF;font-size:14px}
  .code{font-family:ui-monospace,monospace;font-size:24px;color:#F5B942;letter-spacing:2px}
  button,input,select{width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:1px solid #34303A;font-size:15px;margin-top:8px}
  input,select{background:#0E0D11;color:#fff}
  .primary{background:linear-gradient(135deg,#7028C9,#A855F7);color:#fff;border:none;font-weight:700}
  .ghost{background:#141217;color:#D5D7DC}.danger{background:#141217;color:#F97066;border-color:#F97066}
  .row{display:flex;gap:8px}.row>*{flex:1}
  .tier-bronze{color:#CD7F32}.tier-silver{color:#C0C0C0}.tier-gold{color:#F5B942}
  </style></head><body>${inner}</body></html>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
);

function authed(req: Request): string | null {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  const expected = Deno.env.get('OWNER_ADMIN_TOKEN') ?? '';
  return expected && token === expected ? token : null;
}

async function renderHome(token: string) {
  const db = admin();
  const [{ data: members }, { data: jobs }] = await Promise.all([
    db.from('memberships').select('id, code, tier, active, customers(name, email)').order('created_at', { ascending: false }),
    db.from('bookings').select('id, preferred_day, time_slot, status, items, customers(name, email), membership_id')
      .in('status', ['requested', 'confirmed']).order('preferred_day'),
  ]);
  const memberRows = (members ?? []).map((m) => {
    const c = m.customers as unknown as { name: string; email: string };
    return `<div class="card">
      <h2>${c?.name || c?.email || '—'} <span class="tier-${m.tier}">${(m.tier ?? '').toUpperCase()}</span>${m.active ? '' : ' · <span class="muted">INACTIVE</span>'}</h2>
      <div class="code">${m.code ?? ''}</div>
      <form method="POST" class="row">
        <input type="hidden" name="token" value="${token}"><input type="hidden" name="id" value="${m.id}">
        <select name="tier"><option value="bronze"${m.tier === 'bronze' ? ' selected' : ''}>Bronze</option><option value="silver"${m.tier === 'silver' ? ' selected' : ''}>Silver</option><option value="gold"${m.tier === 'gold' ? ' selected' : ''}>Gold</option></select>
        <button class="ghost" name="action" value="tier">Set tier</button>
        <button class="ghost" name="action" value="stamp">+1 stamp</button>
        <button class="danger" name="action" value="${m.active ? 'deactivate' : 'activate'}">${m.active ? 'Deactivate' : 'Reactivate'}</button>
      </form>
    </div>`;
  }).join('');
  const jobRows = (jobs ?? []).map((b) => {
    const c = b.customers as unknown as { name: string; email: string };
    const cars = (b.items as unknown[]).length;
    return `<div class="card"><h2>${b.preferred_day} ${b.time_slot ?? ''} — ${c?.name || c?.email}</h2>
      <p class="muted">${cars} car(s) · ${b.status}${b.membership_id ? ' · MEMBER' : ''}</p>
      <form method="POST"><input type="hidden" name="token" value="${token}"><input type="hidden" name="id" value="${b.id}">
      <button class="primary" name="action" value="done">Mark done${b.membership_id ? ' (+stamps)' : ''}</button></form></div>`;
  }).join('');
  return page(`
    <div class="card"><h1>Add a member</h1>
      <form method="POST">
        <input type="hidden" name="token" value="${token}">
        <input name="name" placeholder="Name" required>
        <input name="email" placeholder="Email" type="email" required>
        <select name="tier"><option value="bronze">Bronze</option><option value="silver">Silver</option><option value="gold">Gold</option></select>
        <button class="primary" name="action" value="add">Create member → get code</button>
      </form>
    </div>
    <div class="card"><h1>Jobs to finish</h1>${jobRows || '<p class="muted">No open jobs.</p>'}</div>
    <h1 style="margin:16px 0 8px">Members</h1>${memberRows || '<p class="muted">No members yet.</p>'}`);
}

Deno.serve(async (req) => {
  const token = authed(req);
  if (!token) return page('<div class="card"><h1>Not found</h1><p class="muted">This link is invalid.</p></div>');
  const db = admin();

  if (req.method === 'GET') return renderHome(token);

  if (req.method === 'POST') {
    const form = await req.formData();
    const action = String(form.get('action') ?? '');
    const id = String(form.get('id') ?? '');

    if (action === 'add') {
      const name = String(form.get('name') ?? '').trim();
      const email = String(form.get('email') ?? '').trim().toLowerCase();
      const tier = String(form.get('tier') ?? 'bronze') as Tier;
      if (!name || !email) return page('<div class="card"><h1>Name and email required</h1></div>');
      const { data: cat } = await db.from('catalog').select('config').eq('id', 1).single();
      const cfg = cat!.config as MemberCatalog;
      const plan = cfg.plans[tier];

      // Customer row keyed by email; create an auth-less placeholder id if new.
      const { data: existing } = await db.from('customers').select('id').eq('email', email).single();
      const customerId = existing?.id ?? crypto.randomUUID();
      if (!existing) await db.from('customers').insert({ id: customerId, email, name });

      let code = generateCode();
      for (let i = 0; i < 5; i++) {
        const { error } = await db.from('memberships').insert({
          customer_id: customerId, plan: tier, tier, code,
          credits_per_period: plan.credits, period_start: new Date().toISOString().slice(0, 10),
        });
        if (!error) break;
        code = generateCode(); // unique collision retry
        if (i === 4) return page('<div class="card"><h1>Could not create — try again</h1></div>');
      }
      const { data: m } = await db.from('memberships').select('id').eq('code', code).single();
      await db.from('credit_ledger').insert({ membership_id: m!.id, delta: plan.credits, reason: 'initial grant' });
      await sendEmail(email, 'Welcome to the Brotherhood — your member code inside',
        `<h2 style="color:#A855F7;margin:0 0 12px">Welcome, ${name}!</h2>
         <p>Your <b>${tier.toUpperCase()}</b> membership is live: ${plan.credits} ${plan.service} details every month, priority booking, and rewards on every wash.</p>
         <p>Your member code:</p>
         <p style="font-family:monospace;font-size:28px;color:#F5B942;letter-spacing:3px">${code}</p>
         <p style="color:#A9A4AF">Open the BLD app → "I'm a member" → enter this code once.</p>`);
      return page(`<div class="card"><h1>Member created ✓</h1>
        <p>${name} · ${tier.toUpperCase()} · ${plan.credits} credits granted · welcome email sent.</p>
        <p class="muted">Their code (also emailed):</p><div class="code">${code}</div>
        <form method="GET"><input type="hidden" name="token" value="${token}"><button class="ghost">← Back</button></form></div>`);
    }

    if (action === 'tier') {
      const tier = String(form.get('tier') ?? '') as Tier;
      const { data: cat } = await db.from('catalog').select('config').eq('id', 1).single();
      const plan = (cat!.config as MemberCatalog).plans[tier];
      await db.from('memberships').update({ tier, plan: tier, credits_per_period: plan.credits }).eq('id', id);
      return renderHome(token);
    }
    if (action === 'deactivate' || action === 'activate') {
      await db.from('memberships').update({ active: action === 'activate' }).eq('id', id);
      return renderHome(token);
    }
    if (action === 'stamp') {
      await db.from('reward_ledger').insert({ membership_id: id, delta: 1, reason: 'manual grant' });
      return renderHome(token);
    }
    if (action === 'done') {
      const { data: b } = await db.from('bookings')
        .select('id, items, membership_id, customers(email, name)').eq('id', id).single();
      if (!b) return renderHome(token);
      await db.from('bookings').update({ status: 'done' }).eq('id', b.id);
      if (b.membership_id) {
        const stamps = (b.items as unknown[]).length;
        await db.from('reward_ledger').insert({
          membership_id: b.membership_id, delta: stamps, reason: 'wash completed', booking_id: b.id,
        });
        const c = b.customers as unknown as { email: string; name: string };
        const { data: bal } = await db.from('reward_ledger').select('delta').eq('membership_id', b.membership_id);
        const total = (bal ?? []).reduce((s, r) => s + r.delta, 0);
        await sendEmail(c.email, `+${stamps} stamp${stamps > 1 ? 's' : ''} earned — you have ${total}`,
          `<h2 style="color:#A855F7;margin:0 0 12px">Stamp${stamps > 1 ? 's' : ''} earned 🎉</h2>
           <p>Wash complete — you earned <b>${stamps} stamp${stamps > 1 ? 's' : ''}</b>. You now have <b>${total}</b>. Open the app to redeem rewards.</p>`);
      }
      return renderHome(token);
    }
    return page('<div class="card"><h1>Unknown action</h1></div>');
  }
  return new Response('method not allowed', { status: 405 });
});
```

- [ ] **Step 2: Set `OWNER_ADMIN_TOKEN`** — generate locally (`openssl rand -hex 24`), set as a function secret on the project (Supabase secrets — via MCP `execute_sql` is NOT how; use the dashboard/secrets API through MCP if available, otherwise document: `npx supabase secrets set OWNER_ADMIN_TOKEN=<value> --project-ref fiaadogbkvjcddehnymj`). Record the owner URL `https://fiaadogbkvjcddehnymj.supabase.co/functions/v1/owner-members?token=<value>` in the final report to the user (not in git).

- [ ] **Step 3: Deploy** via MCP `deploy_edge_function` (name `owner-members`, include `_shared/membership.ts`, `_shared/pricing.ts`, `_shared/notify.ts`).

- [ ] **Step 4: Smoke test** — `curl -s "https://fiaadogbkvjcddehnymj.supabase.co/functions/v1/owner-members?token=wrong"` → "Not found" page. With the right token → "Add a member" page.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/owner-members/index.ts
git commit -m "feat: owner members page — add/manage members, mark jobs done, grant stamps"
```

---

### Task 7: `sweep` extension — monthly credit grants

**Files:**
- Modify: `supabase/functions/sweep/index.ts`

**Interfaces:**
- Consumes: `memberships`, `credit_ledger`, `catalog.config.plans`.
- Produces: response gains `{ granted: number }`; each active membership past its period gets `credits_per_period` new credits and `period_start` advanced one month (loop until current).

- [ ] **Step 1: Add to `sweep/index.ts`** — before the final `return Response.json(...)`, insert; and change the return to include `granted`:

```ts
  // ——— monthly membership credit grants ———
  let granted = 0;
  const todayISO = new Date().toISOString().slice(0, 10);
  const { data: members } = await db.from('memberships')
    .select('id, credits_per_period, period_start').eq('active', true);
  for (const m of members ?? []) {
    let start = new Date(String(m.period_start) + 'T00:00:00Z');
    let advanced = false;
    while (true) {
      const next = new Date(start);
      next.setUTCMonth(next.getUTCMonth() + 1);
      if (next.toISOString().slice(0, 10) > todayISO) break;
      await db.from('credit_ledger').insert({
        membership_id: m.id, delta: m.credits_per_period, reason: `monthly grant ${next.toISOString().slice(0, 10)}`,
      });
      start = next;
      advanced = true;
      granted++;
    }
    if (advanced) {
      await db.from('memberships').update({ period_start: start.toISOString().slice(0, 10) }).eq('id', m.id);
    }
  }
  return Response.json({ reminded, refunded, granted });
```

(Replace the existing `return Response.json({ reminded, refunded });` line.)

- [ ] **Step 2: Deploy** via MCP `deploy_edge_function` (name `sweep`, include `_shared` deps it already uses).

- [ ] **Step 3: Smoke test** — `curl -s -X POST -H "Authorization: Bearer $ANON" https://fiaadogbkvjcddehnymj.supabase.co/functions/v1/sweep` → `{"reminded":0,"refunded":0,"granted":0}` (numbers may vary; `granted` key must exist).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/sweep/index.ts
git commit -m "feat: sweep grants monthly membership credits"
```

---

### Task 8: App — member state, code entry, dashboard

**Files:**
- Create: `bld-app/src/state/member.tsx`
- Create: `bld-app/src/screens/MemberCode.tsx`
- Create: `bld-app/src/screens/MemberDashboard.tsx`
- Modify: `bld-app/App.tsx` (register screens), `bld-app/src/screens/Home.tsx` (member link + auto-open)
- Test: `bld-app/__tests__/member-state.test.tsx`

**Interfaces:**
- Consumes: `member` edge function (Task 4 response shape), AsyncStorage, theme.
- Produces (used by Task 9):
  - `MemberProvider` context: `{ profile: MemberProfile | null; code: string | null; loading: boolean; enter(code: string): Promise<string | null>; refresh(): Promise<void>; leave(): void; redeem(reward: string): Promise<string | null>; requestUpgrade(): Promise<void> }` via `useMember()`
  - `interface MemberProfile` mirroring Task 4's profile JSON.
  - AsyncStorage key: `'bld_member_code'`.
  - New routes: `MemberCode: undefined`, `MemberDashboard: undefined` in `RootStackParamList`.
  - `TIER_COLORS: Record<string, string>` = bronze `#CD7F32`, silver `#C0C0C0`, gold `#F5B942` (exported from `member.tsx`).

- [ ] **Step 1: Write failing test** `bld-app/__tests__/member-state.test.tsx`:

```tsx
import React from 'react';
import { Text } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';

jest.mock('../src/api', () => ({
  supabase: {
    functions: {
      invoke: jest.fn(async (_name: string, { body }: { body: { code: string } }) =>
        body.code === 'BLD-GOOD22'
          ? { data: { member: { name: 'T', email: 't@t.co', tier: 'gold', active: true, periodStart: '2026-07-01' }, credits: 2, stamps: 4, savings: 41, rewardMenu: [], issuedRewards: [], history: [] }, error: null }
          : { data: null, error: { context: { json: async () => ({ error: 'invalid_code' }) } } },
      ),
    },
  },
}));

import { MemberProvider, useMember, TIER_COLORS } from '../src/state/member';

function Probe() {
  const m = useMember();
  React.useEffect(() => { m.enter('BLD-GOOD22'); }, []);
  return <Text testID="tier">{m.profile?.member.tier ?? 'none'}</Text>;
}

test('enter(code) loads profile into context', async () => {
  const { getByTestId } = render(<MemberProvider><Probe /></MemberProvider>);
  await waitFor(() => expect(getByTestId('tier').props.children).toBe('gold'));
});

test('tier colors defined', () => {
  expect(TIER_COLORS.gold).toBe('#F5B942');
  expect(TIER_COLORS.bronze).toBe('#CD7F32');
  expect(TIER_COLORS.silver).toBe('#C0C0C0');
});
```

- [ ] **Step 2: Run to verify failure** — `cd bld-app && npx jest member-state` — FAIL.

- [ ] **Step 3: Implement** `bld-app/src/state/member.tsx`:

```tsx
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
```

- [ ] **Step 4: Run test** — `npx jest member-state` — PASS.

- [ ] **Step 5: Create** `bld-app/src/screens/MemberCode.tsx`:

```tsx
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useMember } from '../state/member';
import { colors, fonts, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'MemberCode'>;

export default function MemberCode({ navigation }: Props) {
  const { enter } = useMember();
  const [code, setCode] = useState('BLD-');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const go = async () => {
    setBusy(true); setError('');
    const err = await enter(code);
    setBusy(false);
    if (err === 'invalid_code') return setError("That code doesn't match. Check the letters — no O's or 0's.");
    if (err === 'inactive') return setError('This membership is paused. Text us to reactivate.');
    if (err) return setError('Network problem. Check your signal and try again.');
    navigation.reset({ index: 0, routes: [{ name: 'MemberDashboard' }] });
  };

  return (
    <View style={s.root}>
      <Text style={s.title}>ENTER YOUR{'\n'}MEMBER CODE</Text>
      <Text style={s.hint}>It's on your welcome email — you only do this once.</Text>
      <TextInput
        style={s.input} value={code} onChangeText={(v) => setCode(v.toUpperCase())}
        autoCapitalize="characters" autoCorrect={false} maxLength={10} placeholder="BLD-XXXXXX"
        placeholderTextColor={colors.textMuted}
      />
      <Pressable accessibilityRole="button" style={[s.btn, busy && { opacity: 0.7 }]} onPress={go} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>UNLOCK MEMBER MODE</Text>}
      </Pressable>
      {!!error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: spacing(6), justifyContent: 'center' },
  title: { fontFamily: fonts.headingBlack, fontSize: 30, color: colors.text, textAlign: 'center', lineHeight: 34 },
  hint: { color: colors.textMuted, textAlign: 'center', marginTop: spacing(3), marginBottom: spacing(6) },
  input: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button,
    color: colors.text, padding: spacing(4), fontSize: 24, textAlign: 'center', letterSpacing: 4,
    fontFamily: fonts.heading,
  },
  btn: { backgroundColor: colors.primary, borderRadius: radius.button, minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: spacing(4) },
  btnText: { fontFamily: fonts.heading, color: colors.text, fontSize: 16, letterSpacing: 1 },
  error: { color: colors.danger, marginTop: spacing(4), textAlign: 'center' },
});
```

- [ ] **Step 6: Create** `bld-app/src/screens/MemberDashboard.tsx`:

```tsx
import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { TIER_COLORS, useMember } from '../state/member';
import { useCatalog } from '../state/catalog';
import { colors, fonts, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'MemberDashboard'>;

const TIER_LABEL: Record<string, string> = { bronze: 'BRONZE', silver: 'SILVER', gold: 'GOLD' };
const NEXT_TIER: Record<string, string | null> = { bronze: 'silver', silver: 'gold', gold: null };

export default function MemberDashboard({ navigation }: Props) {
  const m = useMember();
  const catalog = useCatalog() as unknown as { plans?: Record<string, { price: number; credits: number; service: string }> };
  const [redeeming, setRedeeming] = useState('');
  if (!m.profile) return null;
  const p = m.profile;
  const tierColor = TIER_COLORS[p.member.tier];
  const plan = catalog.plans?.[p.member.tier];
  const next = NEXT_TIER[p.member.tier];

  const redeem = (key: string, label: string, cost: number) => {
    Alert.alert(`Redeem ${label}?`, `Uses ${cost} stamps. It applies to your next booking automatically.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Redeem', onPress: async () => {
          setRedeeming(key);
          const err = await m.redeem(key);
          setRedeeming('');
          if (err) Alert.alert('Not yet', err === 'not_enough_stamps' ? 'Not enough stamps yet — keep washing!' : 'Network problem, try again.');
        },
      },
    ]);
  };

  const upgrade = () => {
    Alert.alert('Upgrade?', "We'll text you to set it up — takes one tap on our side.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Request upgrade', onPress: () => { m.requestUpgrade(); Alert.alert('Sent ✓', "You'll hear from us today."); } },
    ]);
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(10) }}>
      {/* Tier card */}
      <View style={[s.card, { borderColor: tierColor }]}>
        <Text style={[s.tier, { color: tierColor }]}>{TIER_LABEL[p.member.tier]} MEMBER</Text>
        <Text style={s.name}>{p.member.name || p.member.email}</Text>
        <View style={s.bigRow}>
          <View style={s.bigCell}>
            <Text style={s.bigNum}>{p.credits}</Text>
            <Text style={s.bigLabel}>washes left</Text>
          </View>
          <View style={s.bigCell}>
            <Text style={[s.bigNum, { color: colors.success }]}>${p.savings}</Text>
            <Text style={s.bigLabel}>saved so far</Text>
          </View>
          <View style={s.bigCell}>
            <Text style={[s.bigNum, { color: tierColor }]}>{p.stamps}</Text>
            <Text style={s.bigLabel}>stamps</Text>
          </View>
        </View>
        {plan && <Text style={s.planLine}>{plan.credits} {plan.service} details / month · ${plan.price}/mo</Text>}
      </View>

      <Pressable accessibilityRole="button" style={s.bookBtn} onPress={() => navigation.navigate('Build')}>
        <Text style={s.bookText}>BOOK A WASH{p.credits > 0 ? ' — USE A CREDIT' : ''}</Text>
      </Pressable>
      {next && (
        <Pressable accessibilityRole="button" style={s.upgradeBtn} onPress={upgrade}>
          <Text style={s.upgradeText}>UPGRADE TO {TIER_LABEL[next]} →</Text>
        </Pressable>
      )}

      {/* Punch card */}
      <Text style={s.section}>Stamps</Text>
      <View style={s.punch}>
        {Array.from({ length: 10 }, (_, i) => (
          <View key={i} style={[s.stamp, i < Math.min(p.stamps, 10) && { backgroundColor: tierColor, borderColor: tierColor }]}>
            <Text style={s.stampText}>{i < Math.min(p.stamps, 10) ? '✓' : ''}</Text>
          </View>
        ))}
      </View>

      <Text style={s.section}>Redeem</Text>
      {p.rewardMenu.map((r) => (
        <Pressable key={r.key} accessibilityRole="button" disabled={p.stamps < r.cost || redeeming === r.key}
          onPress={() => redeem(r.key, r.label, r.cost)}
          style={[s.reward, p.stamps < r.cost && { opacity: 0.45 }]}>
          <Text style={s.rewardLabel}>{r.label}</Text>
          <Text style={[s.rewardCost, { color: tierColor }]}>{r.cost} stamps</Text>
        </Pressable>
      ))}
      {p.issuedRewards.length > 0 && (
        <View style={s.issued}>
          <Text style={{ color: colors.success, fontSize: 14 }}>
            🎁 Ready: {p.issuedRewards.map((r) => r.label).join(', ')} — applies to your next booking.
          </Text>
        </View>
      )}

      <Text style={s.section}>History</Text>
      {p.history.length === 0 && <Text style={{ color: colors.textMuted }}>No washes yet — book your first!</Text>}
      {p.history.map((h) => (
        <View key={h.id} style={s.hist}>
          <Text style={{ color: colors.text }}>{h.day}{h.slot ? ` · ${h.slot}` : ''}</Text>
          <Text style={{ color: h.paidWithCredit ? colors.success : colors.textSecondary }}>
            {h.paidWithCredit ? 'credit' : `$${h.total}`} · {h.status}
          </Text>
        </View>
      ))}

      <Pressable accessibilityRole="button" onPress={() => { m.leave(); navigation.reset({ index: 0, routes: [{ name: 'Home' }] }); }}>
        <Text style={s.leave}>Exit member mode</Text>
      </Pressable>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderWidth: 1.5, borderRadius: radius.card, padding: spacing(5) },
  tier: { fontFamily: fonts.heading, fontSize: 13, letterSpacing: 3 },
  name: { fontFamily: fonts.headingBlack, color: colors.text, fontSize: 24, marginTop: spacing(1) },
  bigRow: { flexDirection: 'row', marginTop: spacing(4) },
  bigCell: { flex: 1, alignItems: 'center' },
  bigNum: { fontFamily: fonts.headingBlack, color: colors.text, fontSize: 32 },
  bigLabel: { color: colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 },
  planLine: { color: colors.textMuted, fontSize: 13, marginTop: spacing(4), textAlign: 'center' },
  bookBtn: { backgroundColor: colors.primary, borderRadius: radius.button, minHeight: 56, alignItems: 'center', justifyContent: 'center', marginTop: spacing(4) },
  bookText: { fontFamily: fonts.heading, color: colors.text, fontSize: 17, letterSpacing: 1 },
  upgradeBtn: { borderWidth: 1, borderColor: colors.primaryBright, borderRadius: radius.button, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: spacing(2) },
  upgradeText: { fontFamily: fonts.heading, color: colors.primaryBright, fontSize: 14, letterSpacing: 1 },
  section: { color: colors.textMuted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing(6), marginBottom: spacing(2) },
  punch: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2) },
  stamp: { width: 44, height: 44, borderRadius: 22, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  stampText: { color: colors.bg, fontSize: 18, fontWeight: '700' },
  reward: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, padding: spacing(4), marginBottom: spacing(2) },
  rewardLabel: { color: colors.text, fontSize: 15 },
  rewardCost: { fontFamily: fonts.heading, fontSize: 14 },
  issued: { backgroundColor: 'rgba(50,213,131,0.08)', borderWidth: 1, borderColor: colors.success, borderRadius: radius.button, padding: spacing(3), marginTop: spacing(2) },
  hist: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing(2.5), borderBottomWidth: 1, borderBottomColor: colors.border },
  leave: { color: colors.textMuted, textAlign: 'center', marginTop: spacing(8), fontSize: 13, textDecorationLine: 'underline' },
});
```

- [ ] **Step 7: Wire into `App.tsx`** — add to `RootStackParamList`: `MemberCode: undefined; MemberDashboard: undefined;`. Wrap providers: `<MemberProvider>` inside `<CatalogProvider>` around `<OrderProvider>`. Register:

```tsx
<Stack.Screen name="MemberCode" component={MemberCode} options={{ title: 'MEMBER LOGIN' }} />
<Stack.Screen name="MemberDashboard" component={MemberDashboard} options={{ title: 'BROTHERHOOD', headerBackVisible: false }} />
```

- [ ] **Step 8: Update `Home.tsx`** — replace the inert `<Text style={s.member}>Brotherhood member? Coming soon.</Text>` with a live link, and auto-open the dashboard when a stored code already loaded:

```tsx
// inside Home component, after player setup:
const { profile, loading } = useMember();
React.useEffect(() => {
  if (!loading && profile) navigation.reset({ index: 0, routes: [{ name: 'MemberDashboard' }] });
}, [loading, profile]);
```

```tsx
<Pressable accessibilityRole="button" onPress={() => navigation.navigate('MemberCode')}>
  <Text style={s.member}>Brotherhood member? Enter your code →</Text>
</Pressable>
```

(Import `useMember` from `../state/member`; `s.member` style unchanged.)

- [ ] **Step 9: Run all tests + typecheck** — `cd bld-app && npx jest && npx tsc --noEmit` — green.

- [ ] **Step 10: Commit**

```bash
git add bld-app/App.tsx bld-app/src/state/member.tsx bld-app/src/screens/MemberCode.tsx bld-app/src/screens/MemberDashboard.tsx bld-app/src/screens/Home.tsx bld-app/__tests__/member-state.test.tsx
git commit -m "feat: member mode UI — code entry, dashboard, auto-open"
```

---

### Task 9: App — booking flow member context (slots, credits, anchor)

**Files:**
- Modify: `bld-app/src/state/order.tsx` (add `anchor: boolean` field)
- Modify: `bld-app/src/screens/Schedule.tsx` (slot_states + bumpable UI)
- Modify: `bld-app/src/screens/Pay.tsx` (credits display, anchor toggle, member body fields, zero-deposit path)
- Modify: `bld-app/src/screens/Booked.tsx` (stamp preview line for members)
- Test: `bld-app/__tests__/order.test.ts` (extend for anchor field)

**Interfaces:**
- Consumes: `useMember()` (Task 8), `slot_states` RPC (Task 1), `book` body fields (Task 5), `decideBump` for display hints (Task 3).
- Produces: `OrderState.anchor: boolean` (default false), `SET_FIELD` accepts `'anchor'` with `'true' | 'false'` string? No — add a dedicated action `{ type: 'SET_ANCHOR'; anchor: boolean }`.

- [ ] **Step 1: Extend order state test** — append to `bld-app/__tests__/order.test.ts`:

```ts
test('anchor toggles and resets', () => {
  let st = orderReducer(initialOrder, { type: 'SET_ANCHOR', anchor: true });
  expect(st.anchor).toBe(true);
  st = orderReducer(st, { type: 'RESET' });
  expect(st.anchor).toBe(false);
});
```

(Match the existing import style in that file — check its current imports first and reuse them.)

- [ ] **Step 2: Run to verify failure** — `npx jest order` — FAIL.

- [ ] **Step 3: Implement in `order.tsx`** — add `anchor: boolean` to `OrderState`, `anchor: false` to `initialOrder`, action `| { type: 'SET_ANCHOR'; anchor: boolean }`, and case:

```ts
    case 'SET_ANCHOR':
      return { ...state, anchor: action.anchor };
```

- [ ] **Step 4: Run** — `npx jest order` — PASS.

- [ ] **Step 5: Schedule.tsx — priority slot UI.** Replace the `booked_slots` RPC block and slot rendering:

```tsx
// state: replace `taken` with slot state map
const [slotStates, setSlotStates] = useState<Map<string, { rank: number; anchored: boolean }>>(new Map());
const { profile } = useMember();
const catalog = useCatalog() as unknown as { plans?: Record<string, { rank: number }> };
const myRank = profile ? catalog.plans?.[profile.member.tier]?.rank ?? 0 : 0;

useEffect(() => {
  if (!state.preferredDay) return;
  let alive = true;
  setLoadingSlots(true);
  supabase.rpc('slot_states', { day: state.preferredDay }).then(
    ({ data }) => {
      if (!alive) return;
      const map = new Map<string, { rank: number; anchored: boolean }>();
      for (const r of (data ?? []) as { slot: string; rank: number; anchored: boolean }[]) {
        map.set(r.slot, { rank: r.rank, anchored: r.anchored });
      }
      setSlotStates(map);
      setLoadingSlots(false);
    },
    () => { if (alive) { setSlotStates(new Map()); setLoadingSlots(false); } },
  );
  return () => { alive = false; };
}, [state.preferredDay]);
```

Slot rendering — three visual states (open / bumpable-for-me / taken):

```tsx
{SLOTS.map((slot) => {
  const holder = slotStates.get(slot.key) ?? null;
  const decision = decideBump(myRank, holder);
  const selectable = decision === 'open' || decision === 'bump' || decision === 'escalate';
  const on = state.timeSlot === slot.key;
  const bumpable = !!holder && selectable;
  return (
    <Pressable key={slot.key} accessibilityRole="button" disabled={!selectable}
      onPress={() => pickSlot(slot.key)}
      style={[s.slot, on && s.slotOn, !selectable && s.slotTaken, bumpable && !on && s.slotBumpable]}>
      <Text style={[s.slotText, on && s.slotTextOn, !selectable && s.slotTextTaken]}>{slot.label}</Text>
      {!selectable && <Text style={s.takenTag}>{holder?.anchored ? 'LOCKED' : 'TAKEN'}</Text>}
      {bumpable && <Text style={s.vipTag}>VIP — TAKE IT</Text>}
    </Pressable>
  );
})}
```

Add styles: `slotBumpable: { borderColor: '#F5B942' }`, `vipTag: { color: '#F5B942', fontSize: 9, letterSpacing: 1, marginTop: 2 }`. Import `decideBump` from `'../../../supabase/functions/_shared/bump'`, `useMember` from `'../state/member'`, `useCatalog` from `'../state/catalog'`. Below the grid, when member selected a bumpable slot show: `<Text style={s.hint}>VIP perk: booking this moves the current appointment to the next open time — they'll be notified.</Text>`. Members get 30-day picker: replace the `past` calc limit only (calendar already allows future); enforce max day: `const maxISO = addDays(todayISO, profile ? 30 : 7)` — implement `addDays` inline with `Date`; disable cells `iso > maxISO` same as `past`.

- [ ] **Step 6: Pay.tsx — credits, anchor, zero-deposit.** Changes:
  - `const { profile, code, refresh } = useMember();` and compute member pricing client-side for display: import `applyCredits` + `applyReward` from `'../../../supabase/functions/_shared/membership'`; plans from `useCatalog()`.
  - Display block above card form: if member with `creditsUsed > 0`: show `wash covered by N credit(s)` line and payable/deposit numbers from `applyCredits`; if `payable === 0`, hide the card form and show button label `BOOK WITH CREDIT — $0 TODAY`.
  - Anchor toggle (non-members only), below remainder Seg:

```tsx
{!profile && (
  <Pressable accessibilityRole="button" onPress={() => dispatch({ type: 'SET_ANCHOR', anchor: !state.anchor })}
    style={[s2.anchor, state.anchor && s2.anchorOn]}>
    <Text style={{ color: state.anchor ? '#F5B942' : colors.textSecondary, fontSize: 15 }}>
      🔒 Slot Anchor — lock your time, bump-proof (+${(catalog as unknown as { anchorPrice?: number }).anchorPrice ?? 10})
    </Text>
  </Pressable>
)}
```

  - `pay()` body gains: `memberCode: code ?? undefined, anchor: state.anchor`, `card` only when deposit > 0; validation skips card/email checks when deposit is 0 AND member (email known server-side? NO — book still requires auth user; keep email+OTP flow as-is; only card fields skipped).
  - Handle new errors: `too_far_out` → "Members can book 30 days out; everyone else 7. Pick a closer day."; `invalid_code` → "Your member code stopped working — re-enter it."; response `escalated: true` → Booked screen still, messaging handled there via param? Keep simple: pass `escalated` into Booked route params.
  - After successful member booking call `refresh()` so dashboard credits update.
  - `Booked` route params change: `Booked: { bookingId: string; escalated?: boolean; memberStampPreview?: boolean }`.

- [ ] **Step 7: Booked.tsx** — read new params; if `escalated` show line "Two VIPs wanted this slot — we'll email your exact time today."; if member (`useMember().profile`) show "✓ You'll earn a stamp when this wash is done." Check current `Booked.tsx` content and match its style.

- [ ] **Step 8: Run all tests + typecheck** — `cd bld-app && npx jest && npx tsc --noEmit` — green. Fix type fallout (e.g. `App.tsx` param list change for Booked).

- [ ] **Step 9: Commit**

```bash
git add bld-app/src/state/order.tsx bld-app/src/screens/Schedule.tsx bld-app/src/screens/Pay.tsx bld-app/src/screens/Booked.tsx bld-app/App.tsx bld-app/__tests__/order.test.ts
git commit -m "feat: booking flow member context — priority slots, credits, anchor add-on"
```

---

### Task 10: Website price sync

**Files:**
- Modify: `Brotherly Love Detailing.dc.html`

**Interfaces:**
- Consumes: public `catalog` row via Supabase REST (`GET /rest/v1/catalog?id=eq.1&select=config` with anon key — RLS `catalog_public_read` already allows it).
- Produces: service cards + membership section render live prices; static values remain as fallback.

- [ ] **Step 1: Tag the four service price spans** — the `Starting at <span style="color:#fff;font-size:20px">$45</span>` spans (lines ~141-144) get ids: `id="bld-price-outside"`, `id="bld-price-inside"`, `id="bld-price-full"`, `id="bld-price-ceramic"` (keep existing text as fallback).

- [ ] **Step 2: Add tier price strip** — inside the Membership CTA card (the `<div ... >Membership</div>` badge block, ~line 195), after the feature grid `</div>`, insert:

```html
<div id="bld-tiers" style="display:flex;gap:14px;margin-top:18px;flex-wrap:wrap">
  <div style="border:1px solid #CD7F32;border-radius:12px;padding:10px 16px"><span style="color:#CD7F32;font-family:'League Spartan',sans-serif;font-weight:700;font-size:12px;letter-spacing:1px">BRONZE</span><div style="color:#fff;font-family:'League Spartan',sans-serif;font-weight:900;font-size:20px">$<span id="bld-tier-bronze">79</span><span style="font-size:12px;color:#A9A4AF">/mo</span></div><div id="bld-tier-bronze-inc" style="color:#A9A4AF;font-size:12px">2 outside details</div></div>
  <div style="border:1px solid #C0C0C0;border-radius:12px;padding:10px 16px"><span style="color:#C0C0C0;font-family:'League Spartan',sans-serif;font-weight:700;font-size:12px;letter-spacing:1px">SILVER</span><div style="color:#fff;font-family:'League Spartan',sans-serif;font-weight:900;font-size:20px">$<span id="bld-tier-silver">99</span><span style="font-size:12px;color:#A9A4AF">/mo</span></div><div id="bld-tier-silver-inc" style="color:#A9A4AF;font-size:12px">2 inside details</div></div>
  <div style="border:1px solid #F5B942;border-radius:12px;padding:10px 16px"><span style="color:#F5B942;font-family:'League Spartan',sans-serif;font-weight:700;font-size:12px;letter-spacing:1px">GOLD</span><div style="color:#fff;font-family:'League Spartan',sans-serif;font-weight:900;font-size:20px">$<span id="bld-tier-gold">199</span><span style="font-size:12px;color:#A9A4AF">/mo</span></div><div id="bld-tier-gold-inc" style="color:#A9A4AF;font-size:12px">2 full details</div></div>
</div>
```

- [ ] **Step 3: Add the sync script** before `</body>` (SUPABASE_URL/ANON copied from `bld-app/.env` — anon key is public by design):

```html
<script>
(function () {
  var SUPABASE_URL = 'https://fiaadogbkvjcddehnymj.supabase.co';
  var ANON = '<value of EXPO_PUBLIC_SUPABASE_ANON_KEY from bld-app/.env>';
  fetch(SUPABASE_URL + '/rest/v1/catalog?id=eq.1&select=config', {
    headers: { apikey: ANON, Authorization: 'Bearer ' + ANON },
  })
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      var cfg = rows && rows[0] && rows[0].config;
      if (!cfg) return;
      var set = function (id, v) { var el = document.getElementById(id); if (el && v != null) el.textContent = '$' + v; };
      if (cfg.services) {
        set('bld-price-outside', cfg.services.outside);
        set('bld-price-inside', cfg.services.inside);
        set('bld-price-full', cfg.services.full);
      }
      if (cfg.extras) set('bld-price-ceramic', cfg.extras.ceramic);
      if (cfg.plans) {
        ['bronze', 'silver', 'gold'].forEach(function (t) {
          var p = cfg.plans[t];
          if (!p) return;
          var priceEl = document.getElementById('bld-tier-' + t);
          if (priceEl) priceEl.textContent = String(p.price);
          var incEl = document.getElementById('bld-tier-' + t + '-inc');
          if (incEl) incEl.textContent = p.credits + ' ' + p.service + ' details';
        });
      }
    })
    .catch(function () { /* static fallbacks already rendered */ });
})();
</script>
```

Note: the price `set()` helper writes `$45` into spans whose surrounding text is `Starting at ` — the `$` prefix lives INSIDE the span already (`$45`), so `textContent = '$' + v` is correct. The tier spans contain only the number, so `priceEl.textContent = String(p.price)` (no `$`).

- [ ] **Step 4: Verify in browser** — `python3 -m http.server 8017` from the repo root, open `http://localhost:8017/Brotherly%20Love%20Detailing.dc.html` in the Browser pane, confirm: no console errors, prices render, tier strip visible. Then change gold price via `execute_sql` to 201, reload, see $201, change it back to 199.

- [ ] **Step 5: Commit**

```bash
git add "Brotherly Love Detailing.dc.html"
git commit -m "feat: website reads live prices + membership tiers from catalog"
```

---

### Task 11: End-to-end proof (live project, fake payments)

**Files:**
- Create: `scripts/e2e-member.mjs`

**Interfaces:**
- Consumes: everything deployed in Tasks 1–7. Env: `SUPABASE_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY` (from MCP/project settings), `OWNER_ADMIN_TOKEN`.
- Produces: a script that exercises the whole feature and prints PASS/FAIL per step; exits non-zero on failure.

- [ ] **Step 1: Write `scripts/e2e-member.mjs`** — sequence (each step asserts + logs):
  1. Create two test auth users via `e2e-setup` pattern (email variant: use admin API `createUser({ email, password, email_confirm: true })` through the service role key directly with `@supabase/supabase-js` — add temporary `email` support to `e2e-setup` if not present: pass `{ email, password }` and call `admin.auth.admin.createUser({ email, password, email_confirm: true })`).
  2. Owner adds a GOLD member via `POST owner-members` form-encoded (`action=add`, `name=E2E Gold`, `email=<user1 email>`, `tier=gold`, `token=$OWNER_ADMIN_TOKEN`); scrape the `BLD-......` code from the HTML response with regex `/BLD-[A-Z2-9]{6}/`.
  3. `member` profile: credits=2, stamps=0.
  4. Non-member (user2) books tomorrow 10:00, no anchor (fake card `4242...4242`): expect 200.
  5. Member books SAME day 10:00 with code, single full-detail sedan: expect `bumped: true`, `creditsUsed: 1`, `payable: 0`.
  6. `slot_states` for that day: 10:00 held by rank 3; 11:00 held by rank 0 (bumped non-member).
  7. Non-member (user2) books another day WITH `anchor: true`: expect quote payable includes +$10; then member tries same slot: expect 409 `slot_taken`.
  8. Member profile: credits=1.
  9. Owner marks the member booking `done` (`action=done`, id from booking response): member stamps = 1 (1 car).
  10. Grant 2 manual stamps (`action=stamp` ×2) → stamps=3 → `redeem` `tireShine` → ok; profile shows `issuedRewards` length 1, stamps 0.
  11. Member books again (credits=1 → creditsUsed=1): response indicates redemption attached (owner email dry-run logged; assert `redemptions.status='applied'` via service-role select).
  12. Equal-rank escalation: owner adds a second GOLD member; second gold books the same slot as first gold's future booking → expect `escalated: true`, booking `time_slot` null.
  13. Booking window: member books 40 days out → 400 `too_far_out`; non-member 10 days out → 400 `too_far_out`.
  14. Cleanup: delete created bookings, ledgers, redemptions, memberships, customers, auth users (service role).
- [ ] **Step 2: Run** — `SUPABASE_URL=... ANON_KEY=... SERVICE_ROLE_KEY=... OWNER_ADMIN_TOKEN=... node scripts/e2e-member.mjs` — every step PASS. Fix bugs found; re-run until green.
- [ ] **Step 3: Commit**

```bash
git add scripts/e2e-member.mjs supabase/functions/e2e-setup/index.ts
git commit -m "test: end-to-end member mode proof against live project"
```

---

### Task 12: Final verification + docs

- [ ] **Step 1:** `cd bld-app && npx jest && npx tsc --noEmit` — full green.
- [ ] **Step 2:** Launch the app (`cd bld-app && npx expo start --ios` or the `.claude/launch.json` config) and walk: Home → member code → dashboard → book with credit → Booked. Screenshot the dashboard.
- [ ] **Step 3:** Cross-check the spec section by section against what shipped; fix gaps.
- [ ] **Step 4:** Update `README.md` with: member mode summary, owner members URL pattern (no token), price-change workflow (one SQL update or ask Claude — both app + website update instantly).
- [ ] **Step 5:** Commit + report to the user: what shipped, owner URL + token (in chat, not git), example prices reminder (tune in catalog anytime).
