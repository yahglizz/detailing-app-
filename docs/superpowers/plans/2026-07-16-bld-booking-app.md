# Brotherly Love Detailing Booking App (Round 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customer books a mobile detail and pays a percentage deposit in an Expo app; owner confirms via SMS + signed web link.

**Architecture:** Expo/React Native app talks only to a new, dedicated Supabase project (`brotherly-love-detailing`). Server-trusted logic lives in Supabase edge functions: `price` (authoritative pricing from the `catalog` table), `book` (create booking → charge deposit via a swappable payment-provider interface → notify owner), `confirm` (owner's signed-link HTML page), `sweep` (24h reminder / 48h auto-refund). Payment processor is deferred: round 1 ships a `FakeProvider` behind the interface; membership tables ship with no UI.

**Tech Stack:** Expo SDK (TypeScript, blank template), React Navigation native-stack, @supabase/supabase-js, Supabase CLI (migrations, edge functions, pgTAP tests), Deno edge functions, Twilio SMS (dry-run mode when env absent), jest-expo + @testing-library/react-native.

## Global Constraints

- **Never touch the existing Supabase project `blessings-daycare` (ref `eqblpbeqothkpyqiafzs`).** That ref must not appear anywhere in this codebase. New project only: name `brotherly-love-detailing`, org `bocyrqdnhbkwrnofzhrr`, region `us-east-1`, cost $0/mo (already confirmed).
- Repo root is `C:\Users\ymjg0\Downloads\Brotherly Love Detailing Website` (git repo already initialized; spec committed). All paths below are relative to it.
- Colors (from existing website): bg `#0E0D11`, surface `#141217`, border `#34303A`, primary `#7028C9`, primary-bright `#A855F7`, text `#FFFFFF`, secondary `#D5D7DC`, muted `#A9A4AF`, success `#32D583`. Headings font: League Spartan (`@expo-google-fonts/league-spartan`). No Tailwind, no Bootstrap — plain StyleSheet.
- Prices live ONLY in the `catalog` DB table (seeded from `DEFAULT_CATALOG`); app uses the same shared pricing module for live estimates; the server quote is authoritative and is frozen onto the booking row.
- Seed config (all changeable in DB without app release): services outside $45 / inside $60 / full $120; extras ceramic $199, headlight $40, engine $35, pet $35; size multipliers sedan 1.0 / suv 1.25 / truck 1.5 (multiplier applies to the service price only, extras are flat); deposit 25%.
- Deposit is ALWAYS card in-app. Remainder is customer's choice of cash or card at the job.
- Booking status values (exact strings): `pending_payment`, `requested`, `confirmed`, `done`, `paid`, `declined`, `refunded`.
- Quotes are in whole dollars (`Math.round`); the `payments` table stores cents.
- Node 20+, Docker Desktop required for `supabase test db` and `supabase functions serve` locally. Supabase CLI via `npx supabase@latest`.
- TypeScript everywhere, strict mode. Commit after every task.

## File Structure

```
bld-app/                          Expo app
├── App.tsx                       fonts + navigation + providers
├── .env                          EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY (gitignored)
├── metro.config.js               watchFolders → ../supabase/functions/_shared
├── jest.config.js
├── src/
│   ├── theme.ts                  color/spacing/radius tokens
│   ├── api.ts                    supabase client
│   ├── state/order.tsx           order reducer + context
│   ├── state/catalog.tsx         catalog fetch + context (fallback DEFAULT_CATALOG)
│   ├── components/Seg.tsx        segmented picker
│   ├── components/PriceBar.tsx   pinned live price bar
│   └── screens/{Home,Build,Schedule,Pay,Booked}.tsx
├── __tests__/                    jest tests (also tests _shared modules)
supabase/
├── migrations/0001_init.sql      tables, trigger, RLS, seed
├── migrations/0002_cron.sql      hourly sweep schedule
├── tests/database/credit_ledger.test.sql   pgTAP
└── functions/
    ├── _shared/pricing.ts        canonical pricing engine + DEFAULT_CATALOG
    ├── _shared/payments/types.ts provider interface
    ├── _shared/payments/provider.ts  FakeProvider + getProvider() swap point
    ├── _shared/notify.ts         Twilio SMS (dry-run without env)
    ├── price/index.ts
    ├── book/index.ts
    ├── confirm/index.ts          deploy with --no-verify-jwt
    └── sweep/index.ts
```

---

### Task 1: Scaffold Expo app, theme, fonts, jest

**Files:**
- Create: `bld-app/` (via create-expo-app), `bld-app/src/theme.ts`, `bld-app/jest.config.js`, `bld-app/metro.config.js`, `bld-app/.env`
- Modify: `.gitignore` (repo root)

**Interfaces:**
- Produces: `theme.ts` exports `colors`, `spacing(n)`, `radius`, `fonts` used by every screen; jest config that also compiles `../supabase/functions/_shared`.

- [ ] **Step 1: Scaffold app**

```powershell
npx create-expo-app@latest bld-app --template blank-typescript
Remove-Item -Recurse -Force bld-app\.git -ErrorAction SilentlyContinue
cd bld-app
npx expo install @react-navigation/native @react-navigation/native-stack react-native-screens react-native-safe-area-context @supabase/supabase-js react-native-url-polyfill @react-native-async-storage/async-storage expo-location expo-calendar @expo-google-fonts/league-spartan expo-font
npm i -D jest-expo jest @testing-library/react-native @types/jest
```

- [ ] **Step 2: Root .gitignore additions**

Append to repo-root `.gitignore` (create if missing):

```
bld-app/node_modules/
bld-app/.expo/
bld-app/.env
supabase/.temp/
```

- [ ] **Step 3: Write `bld-app/src/theme.ts`**

```ts
export const colors = {
  bg: '#0E0D11',
  surface: '#141217',
  border: '#34303A',
  primary: '#7028C9',
  primaryBright: '#A855F7',
  text: '#FFFFFF',
  textSecondary: '#D5D7DC',
  textMuted: '#A9A4AF',
  success: '#32D583',
  danger: '#F97066',
};
export const spacing = (n: number) => n * 4;
export const radius = { card: 16, button: 12, pill: 999 };
export const fonts = {
  heading: 'LeagueSpartan_800ExtraBold',
  headingBlack: 'LeagueSpartan_900Black',
  body: undefined as string | undefined, // system body font
};
```

- [ ] **Step 4: Write `bld-app/jest.config.js`**

```js
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/src', '<rootDir>/__tests__', '<rootDir>/../supabase/functions/_shared'],
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@supabase/.*|isows|@testing-library)/)',
  ],
};
```

Also add to `bld-app/package.json` scripts: `"test": "jest"`.

- [ ] **Step 5: Write `bld-app/metro.config.js`**

```js
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../supabase/functions/_shared')];
module.exports = config;
```

- [ ] **Step 6: Write `bld-app/.env`**

```
EXPO_PUBLIC_SUPABASE_URL=REPLACED_IN_TASK_4
EXPO_PUBLIC_SUPABASE_ANON_KEY=REPLACED_IN_TASK_4
```

(Values filled by Task 4 after project creation; `.env` is gitignored.)

- [ ] **Step 7: Verify app boots**

Run: `npx expo start` from `bld-app/`, press `w` (web) or open Expo Go. Expected: default blank screen renders without red error. Stop the server.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Expo app with theme tokens and jest"
```

---

### Task 2: Shared pricing engine (TDD)

**Files:**
- Create: `supabase/functions/_shared/pricing.ts`
- Test: `bld-app/__tests__/pricing.test.ts`

**Interfaces:**
- Produces: `priceOrder(items: CarItem[], cfg: CatalogConfig): Quote`, types `Size ('sedan'|'suv'|'truck')`, `Service ('outside'|'inside'|'full')`, `Extra ('ceramic'|'headlight'|'engine'|'pet')`, `CarItem {size, service, extras: Extra[]}`, `Quote {lines, total, depositPercent, deposit, remainder}` (whole dollars), and `DEFAULT_CATALOG: CatalogConfig`. Used by Tasks 5, 6, 9, 11.

- [ ] **Step 1: Write the failing test `bld-app/__tests__/pricing.test.ts`**

```ts
import { priceOrder, DEFAULT_CATALOG, CarItem } from '../../supabase/functions/_shared/pricing';

const car = (over: Partial<CarItem> = {}): CarItem => ({ size: 'sedan', service: 'full', extras: [], ...over });

test('sedan outside is $45', () => {
  const q = priceOrder([car({ service: 'outside' })], DEFAULT_CATALOG);
  expect(q.total).toBe(45);
});

test('size multiplier applies to service only', () => {
  expect(priceOrder([car({ size: 'suv' })], DEFAULT_CATALOG).total).toBe(150); // 120 * 1.25
  expect(priceOrder([car({ size: 'truck' })], DEFAULT_CATALOG).total).toBe(180); // 120 * 1.5
  const q = priceOrder([car({ size: 'suv', extras: ['headlight'] })], DEFAULT_CATALOG);
  expect(q.total).toBe(190); // 150 + flat 40
});

test('multi-car totals and deposit math', () => {
  const q = priceOrder([car(), car({ size: 'suv' })], DEFAULT_CATALOG); // 120 + 150
  expect(q.total).toBe(270);
  expect(q.depositPercent).toBe(25);
  expect(q.deposit).toBe(68); // round(67.5)
  expect(q.remainder).toBe(202);
  expect(q.lines).toHaveLength(2);
  expect(q.lines[1].car).toBe(2);
});

test('extras are itemized on the line', () => {
  const q = priceOrder([car({ extras: ['ceramic', 'engine'] })], DEFAULT_CATALOG);
  expect(q.lines[0].extras).toEqual([
    { name: 'ceramic', price: 199 },
    { name: 'engine', price: 35 },
  ]);
  expect(q.lines[0].lineTotal).toBe(354);
});

test('empty order throws', () => {
  expect(() => priceOrder([], DEFAULT_CATALOG)).toThrow('empty order');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `bld-app/`: `npx jest __tests__/pricing.test.ts`
Expected: FAIL — cannot find module `../../supabase/functions/_shared/pricing`.

- [ ] **Step 3: Write `supabase/functions/_shared/pricing.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/pricing.test.ts` — Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/pricing.ts bld-app/__tests__/pricing.test.ts
git commit -m "feat: shared pricing engine with catalog config"
```

---

### Task 3: Payment provider interface + FakeProvider (TDD)

**Files:**
- Create: `supabase/functions/_shared/payments/types.ts`, `supabase/functions/_shared/payments/provider.ts`
- Test: `bld-app/__tests__/payments.test.ts`

**Interfaces:**
- Produces: `PaymentProvider { chargeDeposit({bookingId, amountCents, card}): Promise<ChargeResult>; refund({bookingId, providerRef}): Promise<ChargeResult> }`, `CardDetails {number, expMonth, expYear, cvc}`, `ChargeResult = {ok: true; ref: string} | {ok: false; error: string}`, and `getProvider(): PaymentProvider` — the ONLY swap point when Stripe/Square is chosen. Used by Tasks 6, 7.

- [ ] **Step 1: Write the failing test `bld-app/__tests__/payments.test.ts`**

```ts
import { getProvider } from '../../supabase/functions/_shared/payments/provider';

const card = (number: string) => ({ number, expMonth: 12, expYear: 2030, cvc: '123' });

test('charge succeeds and returns a ref tied to the booking', async () => {
  const r = await getProvider().chargeDeposit({ bookingId: 'b1', amountCents: 6000, card: card('4242424242424242') });
  expect(r).toEqual({ ok: true, ref: 'fake_b1' });
});

test('card ending 0002 declines', async () => {
  const r = await getProvider().chargeDeposit({ bookingId: 'b1', amountCents: 6000, card: card('4000000000000002') });
  expect(r).toEqual({ ok: false, error: 'card_declined' });
});

test('non-positive amount rejected', async () => {
  const r = await getProvider().chargeDeposit({ bookingId: 'b1', amountCents: 0, card: card('4242424242424242') });
  expect(r).toEqual({ ok: false, error: 'invalid_amount' });
});

test('refund succeeds against a prior ref', async () => {
  const r = await getProvider().refund({ bookingId: 'b1', providerRef: 'fake_b1' });
  expect(r).toEqual({ ok: true, ref: 'refund_fake_b1' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest __tests__/payments.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Write `supabase/functions/_shared/payments/types.ts`**

```ts
export interface CardDetails {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
}

export type ChargeResult = { ok: true; ref: string } | { ok: false; error: string };

export interface PaymentProvider {
  chargeDeposit(input: { bookingId: string; amountCents: number; card: CardDetails }): Promise<ChargeResult>;
  refund(input: { bookingId: string; providerRef: string }): Promise<ChargeResult>;
}
```

- [ ] **Step 4: Write `supabase/functions/_shared/payments/provider.ts`**

```ts
import type { CardDetails, ChargeResult, PaymentProvider } from './types';

class FakeProvider implements PaymentProvider {
  async chargeDeposit({ bookingId, amountCents, card }: { bookingId: string; amountCents: number; card: CardDetails }): Promise<ChargeResult> {
    if (amountCents <= 0) return { ok: false, error: 'invalid_amount' };
    if (card.number.endsWith('0002')) return { ok: false, error: 'card_declined' };
    return { ok: true, ref: `fake_${bookingId}` };
  }
  async refund({ providerRef }: { bookingId: string; providerRef: string }): Promise<ChargeResult> {
    return { ok: true, ref: `refund_${providerRef}` };
  }
}

// Swap point: when a real processor is chosen, return its implementation here.
// Nothing outside this file may import a processor SDK.
export function getProvider(): PaymentProvider {
  return new FakeProvider();
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest __tests__/payments.test.ts` — Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/payments bld-app/__tests__/payments.test.ts
git commit -m "feat: payment provider interface with fake provider"
```

---

### Task 4: New Supabase project + schema migration + ledger pgTAP test

**Files:**
- Create: `supabase/config.toml` (via CLI init), `supabase/migrations/0001_init.sql`, `supabase/tests/database/credit_ledger.test.sql`
- Modify: `bld-app/.env` (real URL + anon key)

**Interfaces:**
- Produces: tables `customers`, `bookings`, `catalog`, `payments`, `memberships`, `credit_ledger`; ledger trigger `credit_ledger_nonnegative`; seeded catalog row id=1. Consumed by Tasks 5–8, 13.

- [ ] **Step 1: Create the NEW Supabase project (never the daycare one)**

Via Supabase MCP tools already connected in this session: `confirm_cost` (project, monthly, $0) then `create_project` with name `brotherly-love-detailing`, org `bocyrqdnhbkwrnofzhrr`, region `us-east-1`. Wait for status `ACTIVE_HEALTHY` via `get_project`. Record the new project ref — call it `<REF>` below. Guard: `<REF>` must NOT be `eqblpbeqothkpyqiafzs`.

- [ ] **Step 2: Init CLI and link**

```powershell
npx supabase@latest init
npx supabase@latest link --project-ref <REF>
```

- [ ] **Step 3: Write `supabase/migrations/0001_init.sql`**

```sql
create extension if not exists pgcrypto;

create table customers (
  id uuid primary key,                 -- equals auth.uid(); no FK so tests can insert freely
  phone text unique not null,
  name text not null default '',
  created_at timestamptz not null default now()
);

create table catalog (
  id int primary key default 1 check (id = 1),
  config jsonb not null
);

insert into catalog (id, config) values (1, '{
  "services": {"outside": 45, "inside": 60, "full": 120},
  "extras": {"ceramic": 199, "headlight": 40, "engine": 35, "pet": 35},
  "sizeMultipliers": {"sedan": 1, "suv": 1.25, "truck": 1.5},
  "depositPercent": 25
}'::jsonb);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  items jsonb not null,
  quote jsonb not null,                -- frozen at booking time; never recomputed
  address text not null,
  preferred_day date not null,
  time_window text not null check (time_window in ('morning','afternoon','either')),
  notes text not null default '',
  remainder_method text not null check (remainder_method in ('cash','card')),
  status text not null default 'pending_payment' check (status in
    ('pending_payment','requested','confirmed','done','paid','declined','refunded')),
  confirm_token text unique not null,
  scheduled_note text,
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger bookings_updated_at before update on bookings
  for each row execute function set_updated_at();

create table payments (
  id bigint generated always as identity primary key,
  booking_id uuid not null references bookings(id),
  kind text not null check (kind in ('deposit','remainder','refund')),
  amount_cents int not null check (amount_cents > 0),
  status text not null check (status in ('succeeded','failed')),
  provider text not null,
  provider_ref text,
  created_at timestamptz not null default now()
);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  plan text not null,
  credits_per_period int not null check (credits_per_period > 0),
  period_start date not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table credit_ledger (
  id bigint generated always as identity primary key,
  membership_id uuid not null references memberships(id),
  delta int not null check (delta <> 0),
  reason text not null,
  booking_id uuid references bookings(id),
  created_at timestamptz not null default now()
);

create function enforce_nonnegative_credits() returns trigger language plpgsql as $$
declare bal int;
begin
  select coalesce(sum(delta), 0) into bal from credit_ledger where membership_id = new.membership_id;
  if bal < 0 then
    raise exception 'credit balance cannot go negative';
  end if;
  return new;
end $$;
create trigger credit_ledger_nonnegative after insert on credit_ledger
  for each row execute function enforce_nonnegative_credits();

alter table customers enable row level security;
alter table catalog enable row level security;
alter table bookings enable row level security;
alter table payments enable row level security;
alter table memberships enable row level security;
alter table credit_ledger enable row level security;

create policy customers_own on customers for select using (id = auth.uid());
create policy bookings_own on bookings for select using (customer_id = auth.uid());
create policy catalog_public_read on catalog for select using (true);
-- All writes go through edge functions with the service role (bypasses RLS).
```

- [ ] **Step 4: Write `supabase/tests/database/credit_ledger.test.sql`**

```sql
begin;
select plan(3);

insert into customers (id, phone) values ('11111111-1111-1111-1111-111111111111', '+15550001111');
insert into memberships (id, customer_id, plan, credits_per_period, period_start)
  values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'club', 2, current_date);

select lives_ok(
  $$insert into credit_ledger (membership_id, delta, reason) values ('22222222-2222-2222-2222-222222222222', 2, 'grant')$$,
  'granting credits works');

select throws_ok(
  $$insert into credit_ledger (membership_id, delta, reason) values ('22222222-2222-2222-2222-222222222222', -3, 'spend')$$,
  'credit balance cannot go negative');

select lives_ok(
  $$insert into credit_ledger (membership_id, delta, reason) values ('22222222-2222-2222-2222-222222222222', -2, 'spend')$$,
  'spending down to zero works');

select * from finish();
rollback;
```

- [ ] **Step 5: Run DB tests locally (Docker required)**

```powershell
npx supabase@latest start
npx supabase@latest test db
```

Expected: `credit_ledger.test.sql .. ok`, 3/3. (If Docker unavailable: `npx supabase db push` then run each statement in the SQL editor and verify the -3 insert raises the exception.)

- [ ] **Step 6: Push migration to the hosted project**

```powershell
npx supabase@latest db push
```

Expected: `0001_init.sql` applied.

- [ ] **Step 7: Fill `bld-app/.env`**

Get URL + anon key via MCP `get_project_url` / `get_publishable_keys` for `<REF>`, write into `bld-app/.env`. Also enable **Phone auth** in the Supabase dashboard (Auth → Providers → Phone) with Twilio credentials — manual step; until done, OTP works in Supabase's test mode only.

- [ ] **Step 8: Commit**

```bash
git add supabase/config.toml supabase/migrations/0001_init.sql supabase/tests
git commit -m "feat: dedicated Supabase project schema with credit ledger invariants"
```

---

### Task 5: `price` edge function

**Files:**
- Create: `supabase/functions/price/index.ts`

**Interfaces:**
- Consumes: `priceOrder`, `CatalogConfig` from `../_shared/pricing.ts`; `catalog` table.
- Produces: `POST /functions/v1/price` body `{items: CarItem[]}` → `200 {quote: Quote}` or `400 {error}`. Consumed by the app if its local estimate needs server confirmation, and by Task 6's flow.

- [ ] **Step 1: Write `supabase/functions/price/index.ts`**

```ts
import { createClient } from 'npm:@supabase/supabase-js@2';
import { priceOrder, type CarItem, type CatalogConfig } from '../_shared/pricing.ts';

Deno.serve(async (req) => {
  try {
    const { items } = (await req.json()) as { items: CarItem[] };
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data, error } = await admin.from('catalog').select('config').eq('id', 1).single();
    if (error) throw error;
    const quote = priceOrder(items, data.config as CatalogConfig);
    return Response.json({ quote });
  } catch (e) {
    return Response.json({ error: String((e as Error).message ?? e) }, { status: 400 });
  }
});
```

- [ ] **Step 2: Serve locally and verify**

```powershell
npx supabase@latest functions serve price
```

Then in a second terminal:

```powershell
curl -s -X POST http://127.0.0.1:54321/functions/v1/price -H "Content-Type: application/json" -H "Authorization: Bearer <local anon key from supabase start output>" -d "{\"items\":[{\"size\":\"suv\",\"service\":\"full\",\"extras\":[\"headlight\"]}]}"
```

Expected: `{"quote":{...,"total":190,"deposit":48,...}}`.

- [ ] **Step 3: Deploy**

```powershell
npx supabase@latest functions deploy price
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/price
git commit -m "feat: authoritative price edge function"
```

---

### Task 6: `notify` module + `book` edge function

**Files:**
- Create: `supabase/functions/_shared/notify.ts`, `supabase/functions/book/index.ts`

**Interfaces:**
- Consumes: `priceOrder` (Task 2), `getProvider` (Task 3), tables (Task 4).
- Produces: `sendSMS(to: string, body: string): Promise<void>` (dry-run logs when Twilio env absent). `POST /functions/v1/book` (authed user JWT) body `{items, address, preferredDay, window, notes, remainderMethod, name, expectedTotal, card}` → `200 {bookingId, quote}` | `409 {error:'price_changed', quote}` | `402 {error}` on decline | `401`. Consumed by Task 13 (Pay screen).
- Env (set via `npx supabase secrets set`): `OWNER_PHONE`, `PUBLIC_FUNCTIONS_URL` (`https://<REF>.supabase.co/functions/v1`), optional `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.

- [ ] **Step 1: Write `supabase/functions/_shared/notify.ts`**

```ts
export async function sendSMS(to: string, body: string): Promise<void> {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_FROM');
  if (!sid || !token || !from) {
    console.log(`[SMS dry-run] to=${to}: ${body}`);
    return;
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${sid}:${token}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) console.error('twilio error', res.status, await res.text());
}
```

- [ ] **Step 2: Write `supabase/functions/book/index.ts`**

```ts
import { createClient } from 'npm:@supabase/supabase-js@2';
import { priceOrder, type CarItem, type CatalogConfig } from '../_shared/pricing.ts';
import { getProvider } from '../_shared/payments/provider.ts';
import type { CardDetails } from '../_shared/payments/types.ts';
import { sendSMS } from '../_shared/notify.ts';

interface BookBody {
  items: CarItem[];
  address: string;
  preferredDay: string; // YYYY-MM-DD
  window: 'morning' | 'afternoon' | 'either';
  notes: string;
  remainderMethod: 'cash' | 'card';
  name: string;
  expectedTotal: number;
  card: CardDetails;
}

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user || !user.phone) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let body: BookBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  if (!body.address?.trim() || !body.preferredDay) return Response.json({ error: 'missing_fields' }, { status: 400 });

  const { data: cat, error: catErr } = await admin.from('catalog').select('config').eq('id', 1).single();
  if (catErr) return Response.json({ error: 'catalog_unavailable' }, { status: 500 });

  let quote;
  try {
    quote = priceOrder(body.items, cat.config as CatalogConfig);
  } catch (e) {
    return Response.json({ error: String((e as Error).message) }, { status: 400 });
  }
  // Server price is authoritative; surface any drift BEFORE charging.
  if (body.expectedTotal !== quote.total) {
    return Response.json({ error: 'price_changed', quote }, { status: 409 });
  }

  await admin.from('customers').upsert({ id: user.id, phone: user.phone, name: body.name ?? '' });

  const confirmToken = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const { data: booking, error: insErr } = await admin
    .from('bookings')
    .insert({
      customer_id: user.id,
      items: body.items,
      quote,
      address: body.address.trim(),
      preferred_day: body.preferredDay,
      time_window: body.window,
      notes: body.notes ?? '',
      remainder_method: body.remainderMethod,
      status: 'pending_payment',
      confirm_token: confirmToken,
    })
    .select()
    .single();
  if (insErr) return Response.json({ error: 'booking_insert_failed' }, { status: 500 });

  const charge = await getProvider().chargeDeposit({
    bookingId: booking.id,
    amountCents: quote.deposit * 100,
    card: body.card,
  });
  if (!charge.ok) {
    // Booking stays pending_payment; customer can retry; sweep cleans up abandoned rows.
    return Response.json({ error: charge.error }, { status: 402 });
  }

  await admin.from('payments').insert({
    booking_id: booking.id,
    kind: 'deposit',
    amount_cents: quote.deposit * 100,
    status: 'succeeded',
    provider: 'fake',
    provider_ref: charge.ref,
  });
  await admin.from('bookings').update({ status: 'requested' }).eq('id', booking.id);

  const summary = body.items
    .map((i) => `${i.service}/${i.size}${i.extras.length ? '+' + i.extras.join(',') : ''}`)
    .join(' | ');
  const link = `${Deno.env.get('PUBLIC_FUNCTIONS_URL')}/confirm?token=${confirmToken}`;
  await sendSMS(
    Deno.env.get('OWNER_PHONE') ?? '',
    `New request: ${summary}. ${body.preferredDay} ${body.window}. $${quote.deposit} deposit PAID. ${body.address}. Confirm: ${link}`,
  );

  return Response.json({ bookingId: booking.id, quote });
});
```

- [ ] **Step 3: Set secrets and deploy**

```powershell
npx supabase@latest secrets set OWNER_PHONE=+1XXXXXXXXXX PUBLIC_FUNCTIONS_URL=https://<REF>.supabase.co/functions/v1
npx supabase@latest functions deploy book
```

(Twilio secrets set later; until then SMS dry-runs into function logs.)

- [ ] **Step 4: Verify locally**

`npx supabase functions serve` then curl `book` with a valid local user JWT (create one via `supabase auth` test OTP or use the app in Task 13). Minimum check now: POST without auth returns `{"error":"unauthorized"}` 401; POST with auth + card `...0002` returns 402 `card_declined` and the booking row in Studio (`http://127.0.0.1:54323`) stays `pending_payment`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/notify.ts supabase/functions/book
git commit -m "feat: book edge function with deposit charge and owner SMS"
```

---

### Task 7: `confirm` edge function (owner page)

**Files:**
- Create: `supabase/functions/confirm/index.ts`

**Interfaces:**
- Consumes: `bookings`/`payments` tables, `getProvider().refund`, `sendSMS`.
- Produces: `GET /confirm?token=…` → branded HTML page. `POST /confirm` form-encoded `{token, action: 'confirm'|'propose'|'decline', time?}` → updates booking, texts customer, returns result HTML. Deployed with `--no-verify-jwt` (capability URL is the auth).

- [ ] **Step 1: Write `supabase/functions/confirm/index.ts`**

```ts
import { createClient } from 'npm:@supabase/supabase-js@2';
import { getProvider } from '../_shared/payments/provider.ts';
import { sendSMS } from '../_shared/notify.ts';

const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const page = (inner: string) => new Response(
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Brotherly Love Detailing</title><style>
  body{background:#0E0D11;color:#fff;font-family:system-ui;margin:0;padding:24px;max-width:480px;margin-inline:auto}
  .card{background:#141217;border:1px solid #34303A;border-radius:16px;padding:20px;margin-bottom:16px}
  h1{font-size:22px;color:#A855F7}.muted{color:#A9A4AF;font-size:14px}
  button,input{width:100%;box-sizing:border-box;padding:14px;border-radius:12px;border:1px solid #34303A;font-size:16px;margin-top:10px}
  input{background:#0E0D11;color:#fff}
  .primary{background:linear-gradient(135deg,#7028C9,#A855F7);color:#fff;border:none;font-weight:700}
  .ghost{background:#141217;color:#D5D7DC}.danger{background:#141217;color:#F97066;border-color:#F97066}
  </style></head><body>${inner}</body></html>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
);

async function loadBooking(token: string) {
  const { data } = await admin()
    .from('bookings')
    .select('*, customers(phone, name)')
    .eq('confirm_token', token)
    .single();
  return data;
}

Deno.serve(async (req) => {
  const db = admin();

  if (req.method === 'GET') {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    const b = await loadBooking(token);
    if (!b) return page('<div class="card"><h1>Not found</h1><p class="muted">This link is invalid.</p></div>');
    if (b.status !== 'requested') {
      return page(`<div class="card"><h1>Already handled</h1><p class="muted">Status: ${b.status}</p></div>`);
    }
    const items = (b.items as { size: string; service: string; extras: string[] }[])
      .map((i, n) => `<div>Car ${n + 1}: <b>${i.service}</b> / ${i.size}${i.extras.length ? ' + ' + i.extras.join(', ') : ''}</div>`)
      .join('');
    const q = b.quote as { total: number; deposit: number; remainder: number };
    return page(`
      <div class="card"><h1>New Detail Request</h1>
        ${items}
        <p class="muted">${b.preferred_day} · ${b.time_window} · ${b.address}</p>
        <p class="muted">Notes: ${b.notes || '—'}</p>
        <p>Total $${q.total} · Deposit $${q.deposit} PAID · $${q.remainder} due (${b.remainder_method})</p>
      </div>
      <form method="POST" class="card">
        <input type="hidden" name="token" value="${token}">
        <input name="time" placeholder="Exact time, e.g. Thu 10:00 AM">
        <button class="primary" name="action" value="confirm">Confirm this time</button>
        <button class="ghost" name="action" value="propose">Propose this time instead</button>
        <button class="danger" name="action" value="decline">Decline &amp; refund</button>
      </form>`);
  }

  if (req.method === 'POST') {
    const form = await req.formData();
    const token = String(form.get('token') ?? '');
    const action = String(form.get('action') ?? '');
    const time = String(form.get('time') ?? '').trim();
    const b = await loadBooking(token);
    if (!b || b.status !== 'requested') return page('<div class="card"><h1>Already handled</h1></div>');
    const customerPhone = (b.customers as { phone: string }).phone;

    if (action === 'confirm') {
      if (!time) return page('<div class="card"><h1>Enter a time first</h1><p class="muted">Go back and type the exact time.</p></div>');
      await db.from('bookings').update({ status: 'confirmed', scheduled_note: time }).eq('id', b.id);
      await sendSMS(customerPhone, `Brotherly Love Detailing: you're confirmed for ${time} at ${b.address}. See you then!`);
      return page('<div class="card"><h1>Confirmed ✓</h1><p class="muted">Customer has been texted.</p></div>');
    }
    if (action === 'propose') {
      if (!time) return page('<div class="card"><h1>Enter a time first</h1></div>');
      await sendSMS(customerPhone, `Brotherly Love Detailing: that window is tight — does ${time} work instead? Reply YES and we'll lock it in.`);
      return page('<div class="card"><h1>Proposal sent</h1><p class="muted">Booking stays pending until you confirm.</p></div>');
    }
    if (action === 'decline') {
      const { data: pay } = await db.from('payments').select('provider_ref')
        .eq('booking_id', b.id).eq('kind', 'deposit').eq('status', 'succeeded').single();
      if (pay?.provider_ref) {
        const r = await getProvider().refund({ bookingId: b.id, providerRef: pay.provider_ref });
        if (r.ok) {
          const q = b.quote as { deposit: number };
          await db.from('payments').insert({
            booking_id: b.id, kind: 'refund', amount_cents: q.deposit * 100,
            status: 'succeeded', provider: 'fake', provider_ref: r.ref,
          });
        }
      }
      await db.from('bookings').update({ status: 'refunded' }).eq('id', b.id);
      await sendSMS(customerPhone, `Brotherly Love Detailing: we couldn't take this one — your $ deposit has been refunded in full. Sorry, and hope to catch you next time.`);
      return page('<div class="card"><h1>Declined &amp; refunded</h1><p class="muted">Customer has been texted.</p></div>');
    }
    return page('<div class="card"><h1>Unknown action</h1></div>');
  }

  return new Response('method not allowed', { status: 405 });
});
```

- [ ] **Step 2: Deploy public (capability URL is the gate)**

```powershell
npx supabase@latest functions deploy confirm --no-verify-jwt
```

- [ ] **Step 3: Verify**

Insert a test booking via local Studio (or reuse Task 6's row after a successful charge), open `http://127.0.0.1:54321/functions/v1/confirm?token=<token>` in a browser: page renders items + three buttons. Click Decline: status flips to `refunded`, a `refund` payments row exists, SMS dry-run appears in `supabase functions serve` logs.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/confirm
git commit -m "feat: owner confirm page with confirm/propose/decline+refund"
```

---

### Task 8: `sweep` function + hourly cron

**Files:**
- Create: `supabase/functions/sweep/index.ts`, `supabase/migrations/0002_cron.sql`

**Interfaces:**
- Consumes: `bookings`, `payments`, `getProvider().refund`, `sendSMS`.
- Produces: `POST /sweep` (service-role JWT via cron) → `{reminded: n, refunded: n, cleaned: n}`. Policy: `requested` >24h with no reminder → text owner once; `requested` >48h → auto-refund + text customer; `pending_payment` >24h → status stays but is ignored by owner views (no deletion — audit trail).

- [ ] **Step 1: Write `supabase/functions/sweep/index.ts`**

```ts
import { createClient } from 'npm:@supabase/supabase-js@2';
import { getProvider } from '../_shared/payments/provider.ts';
import { sendSMS } from '../_shared/notify.ts';

Deno.serve(async () => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const dayAgo = new Date(Date.now() - 24 * 3600e3).toISOString();
  const twoDaysAgo = new Date(Date.now() - 48 * 3600e3).toISOString();
  let reminded = 0, refunded = 0;

  const { data: stale } = await db.from('bookings')
    .select('id, confirm_token, created_at, quote, customers(phone)')
    .eq('status', 'requested').lt('created_at', dayAgo);

  for (const b of stale ?? []) {
    if (b.created_at < twoDaysAgo) {
      const { data: pay } = await db.from('payments').select('provider_ref')
        .eq('booking_id', b.id).eq('kind', 'deposit').eq('status', 'succeeded').single();
      if (pay?.provider_ref) {
        const r = await getProvider().refund({ bookingId: b.id, providerRef: pay.provider_ref });
        if (r.ok) {
          await db.from('payments').insert({
            booking_id: b.id, kind: 'refund',
            amount_cents: (b.quote as { deposit: number }).deposit * 100,
            status: 'succeeded', provider: 'fake', provider_ref: r.ref,
          });
        }
      }
      await db.from('bookings').update({ status: 'refunded' }).eq('id', b.id);
      await sendSMS((b.customers as unknown as { phone: string }).phone,
        `Brotherly Love Detailing: sorry — we couldn't get to your request in time. Your deposit has been refunded in full.`);
      refunded++;
    } else {
      const { data: row } = await db.from('bookings').select('reminder_sent_at').eq('id', b.id).single();
      if (!row?.reminder_sent_at) {
        await sendSMS(Deno.env.get('OWNER_PHONE') ?? '',
          `Reminder: unanswered detail request from yesterday. Auto-refund at 48h. ${Deno.env.get('PUBLIC_FUNCTIONS_URL')}/confirm?token=${b.confirm_token}`);
        await db.from('bookings').update({ reminder_sent_at: new Date().toISOString() }).eq('id', b.id);
        reminded++;
      }
    }
  }
  return Response.json({ reminded, refunded });
});
```

- [ ] **Step 2: Write `supabase/migrations/0002_cron.sql`**

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store secrets in Vault first (Dashboard → Vault): project_functions_url, service_role_key
select cron.schedule(
  'sweep-hourly',
  '0 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_functions_url') || '/sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
      'Content-Type', 'application/json'),
    body := '{}'::jsonb)
  $$
);
```

- [ ] **Step 3: Add the two Vault secrets** in Dashboard → Project Settings → Vault: `project_functions_url` = `https://<REF>.supabase.co/functions/v1`, `service_role_key` = the service-role key. Then `npx supabase db push`.

- [ ] **Step 4: Deploy + manual verify**

```powershell
npx supabase@latest functions deploy sweep
```

Manually POST to `/sweep` with the service-role bearer; expected `{"reminded":0,"refunded":0}` on a clean DB. Backdate a test booking's `created_at` by 25h in SQL editor, re-POST: `reminded:1` and `reminder_sent_at` set; backdate 49h, re-POST: `refunded:1`, status `refunded`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/sweep supabase/migrations/0002_cron.sql
git commit -m "feat: sweep function with 24h reminder and 48h auto-refund"
```

---

### Task 9: App order state (TDD) + api client + catalog context

**Files:**
- Create: `bld-app/src/state/order.tsx`, `bld-app/src/state/catalog.tsx`, `bld-app/src/api.ts`
- Test: `bld-app/__tests__/order.test.ts`

**Interfaces:**
- Consumes: `CarItem`, `DEFAULT_CATALOG`, `CatalogConfig` from `_shared/pricing`.
- Produces: `orderReducer(state, action)`, `initialOrder`, `OrderProvider`/`useOrder()` → `{state, dispatch}`; actions `{type:'SET_CAR_COUNT', count}`, `{type:'SET_SIZE', index, size}`, `{type:'SET_SERVICE', index, service}`, `{type:'TOGGLE_EXTRA', index, extra}`, `{type:'SET_FIELD', field, value}`, `{type:'RESET'}`. `CatalogProvider`/`useCatalog(): CatalogConfig`. `supabase` client export. Consumed by Tasks 10–14.

- [ ] **Step 1: Write failing test `bld-app/__tests__/order.test.ts`**

```ts
import { orderReducer, initialOrder } from '../src/state/order';

test('initial order has one full-service sedan', () => {
  expect(initialOrder.items).toEqual([{ size: 'sedan', service: 'full', extras: [] }]);
});

test('SET_CAR_COUNT grows preserving existing cars and shrinks from the end', () => {
  let s = orderReducer(initialOrder, { type: 'SET_SIZE', index: 0, size: 'truck' });
  s = orderReducer(s, { type: 'SET_CAR_COUNT', count: 3 });
  expect(s.items).toHaveLength(3);
  expect(s.items[0].size).toBe('truck');
  expect(s.items[2]).toEqual({ size: 'sedan', service: 'full', extras: [] });
  s = orderReducer(s, { type: 'SET_CAR_COUNT', count: 1 });
  expect(s.items).toEqual([{ size: 'truck', service: 'full', extras: [] }]);
});

test('TOGGLE_EXTRA adds then removes', () => {
  let s = orderReducer(initialOrder, { type: 'TOGGLE_EXTRA', index: 0, extra: 'ceramic' });
  expect(s.items[0].extras).toEqual(['ceramic']);
  s = orderReducer(s, { type: 'TOGGLE_EXTRA', index: 0, extra: 'ceramic' });
  expect(s.items[0].extras).toEqual([]);
});

test('SET_FIELD sets schedule fields; RESET restores initial', () => {
  let s = orderReducer(initialOrder, { type: 'SET_FIELD', field: 'address', value: '2841 S 12th St' });
  expect(s.address).toBe('2841 S 12th St');
  expect(orderReducer(s, { type: 'RESET' })).toEqual(initialOrder);
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

`npx jest __tests__/order.test.ts`

- [ ] **Step 3: Write `bld-app/src/state/order.tsx`**

```tsx
import React, { createContext, useContext, useReducer } from 'react';
import type { CarItem, Extra, Service, Size } from '../../../supabase/functions/_shared/pricing';

export interface OrderState {
  items: CarItem[];
  address: string;
  preferredDay: string; // YYYY-MM-DD
  window: 'morning' | 'afternoon' | 'either';
  notes: string;
  remainderMethod: 'cash' | 'card';
  name: string;
}

export type OrderAction =
  | { type: 'SET_CAR_COUNT'; count: number }
  | { type: 'SET_SIZE'; index: number; size: Size }
  | { type: 'SET_SERVICE'; index: number; service: Service }
  | { type: 'TOGGLE_EXTRA'; index: number; extra: Extra }
  | { type: 'SET_FIELD'; field: 'address' | 'preferredDay' | 'window' | 'notes' | 'remainderMethod' | 'name'; value: string }
  | { type: 'RESET' };

const newCar = (): CarItem => ({ size: 'sedan', service: 'full', extras: [] });

export const initialOrder: OrderState = {
  items: [newCar()],
  address: '',
  preferredDay: '',
  window: 'either',
  notes: '',
  remainderMethod: 'cash',
  name: '',
};

export function orderReducer(state: OrderState, action: OrderAction): OrderState {
  switch (action.type) {
    case 'SET_CAR_COUNT': {
      const count = Math.max(1, Math.min(6, action.count));
      const items = state.items.slice(0, count);
      while (items.length < count) items.push(newCar());
      return { ...state, items };
    }
    case 'SET_SIZE':
      return { ...state, items: state.items.map((c, i) => (i === action.index ? { ...c, size: action.size } : c)) };
    case 'SET_SERVICE':
      return { ...state, items: state.items.map((c, i) => (i === action.index ? { ...c, service: action.service } : c)) };
    case 'TOGGLE_EXTRA':
      return {
        ...state,
        items: state.items.map((c, i) =>
          i !== action.index ? c : {
            ...c,
            extras: c.extras.includes(action.extra) ? c.extras.filter((e) => e !== action.extra) : [...c.extras, action.extra],
          },
        ),
      };
    case 'SET_FIELD':
      return { ...state, [action.field]: action.value };
    case 'RESET':
      return initialOrder;
  }
}

const Ctx = createContext<{ state: OrderState; dispatch: React.Dispatch<OrderAction> } | null>(null);

export function OrderProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(orderReducer, initialOrder);
  return <Ctx.Provider value={{ state, dispatch }}>{children}</Ctx.Provider>;
}

export function useOrder() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useOrder outside OrderProvider');
  return v;
}
```

- [ ] **Step 4: Run — expect 4 passed.** `npx jest __tests__/order.test.ts`

- [ ] **Step 5: Write `bld-app/src/api.ts`**

```ts
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false } },
);
```

- [ ] **Step 6: Write `bld-app/src/state/catalog.tsx`**

```tsx
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
```

- [ ] **Step 7: Commit**

```bash
git add bld-app/src/state bld-app/src/api.ts bld-app/__tests__/order.test.ts
git commit -m "feat: order reducer, catalog context, supabase client"
```

---

### Task 10: Navigation + Home screen

**Files:**
- Create: `bld-app/src/screens/Home.tsx`
- Modify: `bld-app/App.tsx`

**Interfaces:**
- Produces: `RootStackParamList = { Home: undefined; Build: undefined; Schedule: undefined; Pay: undefined; Booked: { bookingId: string } }` exported from `App.tsx`. Consumed by Tasks 11–14.

- [ ] **Step 1: Rewrite `bld-app/App.tsx`**

```tsx
import React from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts, LeagueSpartan_800ExtraBold, LeagueSpartan_900Black } from '@expo-google-fonts/league-spartan';
import { View } from 'react-native';
import { colors } from './src/theme';
import { OrderProvider } from './src/state/order';
import { CatalogProvider } from './src/state/catalog';
import Home from './src/screens/Home';
import Build from './src/screens/Build';
import Schedule from './src/screens/Schedule';
import Pay from './src/screens/Pay';
import Booked from './src/screens/Booked';

export type RootStackParamList = {
  Home: undefined;
  Build: undefined;
  Schedule: undefined;
  Pay: undefined;
  Booked: { bookingId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const [loaded] = useFonts({ LeagueSpartan_800ExtraBold, LeagueSpartan_900Black });
  if (!loaded) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return (
    <CatalogProvider>
      <OrderProvider>
        <NavigationContainer theme={{ ...DarkTheme, colors: { ...DarkTheme.colors, background: colors.bg } }}>
          <Stack.Navigator
            screenOptions={{
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.text,
              headerTitleStyle: { fontFamily: 'LeagueSpartan_800ExtraBold' },
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="Home" component={Home} options={{ headerShown: false }} />
            <Stack.Screen name="Build" component={Build} options={{ title: 'BUILD YOUR DETAIL' }} />
            <Stack.Screen name="Schedule" component={Schedule} options={{ title: 'WHEN & WHERE' }} />
            <Stack.Screen name="Pay" component={Pay} options={{ title: 'PAY DEPOSIT' }} />
            <Stack.Screen name="Booked" component={Booked} options={{ headerShown: false, gestureEnabled: false }} />
          </Stack.Navigator>
        </NavigationContainer>
      </OrderProvider>
    </CatalogProvider>
  );
}
```

Note: Build/Schedule/Pay/Booked don't exist yet — create four placeholder files in this step so the app compiles, each replaced by its own task:

```tsx
// bld-app/src/screens/Build.tsx (same shape for Schedule.tsx, Pay.tsx, Booked.tsx until their tasks)
import React from 'react';
import { View } from 'react-native';
export default function Build() { return <View />; }
```

- [ ] **Step 2: Write `bld-app/src/screens/Home.tsx`**

```tsx
import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { colors, fonts, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

export default function Home({ navigation }: Props) {
  return (
    <View style={s.root}>
      <Image source={require('../../assets/bld-logo.png')} style={s.logo} resizeMode="contain" />
      <Text style={s.title}>BROTHERLY LOVE{'\n'}DETAILING</Text>
      <Text style={s.tagline}>Philly's mobile detail ministry. We come to you.</Text>
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [s.cta, pressed && { transform: [{ scale: 0.98 }] }]}
        onPress={() => navigation.navigate('Build')}
      >
        <Text style={s.ctaText}>GET MY DETAIL</Text>
      </Pressable>
      <Text style={s.member}>Brotherhood member? Coming soon.</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing(8) },
  logo: { width: 140, height: 140, marginBottom: spacing(6) },
  title: { fontFamily: fonts.headingBlack, fontSize: 34, color: colors.text, textAlign: 'center', lineHeight: 38 },
  tagline: { color: colors.textMuted, fontSize: 16, marginTop: spacing(3), textAlign: 'center' },
  cta: {
    marginTop: spacing(12), backgroundColor: colors.primary, borderRadius: radius.button,
    paddingVertical: spacing(5), paddingHorizontal: spacing(12), minHeight: 56, justifyContent: 'center',
    shadowColor: colors.primary, shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 8,
  },
  ctaText: { fontFamily: fonts.heading, color: colors.text, fontSize: 22, letterSpacing: 1 },
  member: { color: colors.textMuted, fontSize: 13, marginTop: spacing(8) },
});
```

- [ ] **Step 3: Copy the logo**

```powershell
Copy-Item "assets\bld-logo.png" "bld-app\assets\bld-logo.png"
```

- [ ] **Step 4: Verify** — `npx expo start`, Home renders: logo, headline, one purple CTA; tapping navigates to the empty Build screen. Run `npx jest` — all prior tests still pass.

- [ ] **Step 5: Commit**

```bash
git add bld-app/App.tsx bld-app/src/screens bld-app/assets/bld-logo.png
git commit -m "feat: navigation shell and home screen"
```

---

### Task 11: Build screen with live PriceBar (TDD on PriceBar)

**Files:**
- Create: `bld-app/src/components/Seg.tsx`, `bld-app/src/components/PriceBar.tsx`
- Modify: `bld-app/src/screens/Build.tsx` (replace placeholder)
- Test: `bld-app/__tests__/pricebar.test.tsx`

**Interfaces:**
- Consumes: `useOrder`, `useCatalog`, `priceOrder`.
- Produces: `<Seg options labels value onChange />` generic segmented control; `<PriceBar onNext label />` — pinned bar showing live total + deposit, renders `Continue` button calling `onNext`. Consumed by Tasks 12–13 (Seg reused).

- [ ] **Step 1: Write failing test `bld-app/__tests__/pricebar.test.tsx`**

```tsx
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { OrderProvider } from '../src/state/order';
import PriceBar from '../src/components/PriceBar';

jest.mock('../src/api', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }) }) } }));
import { CatalogProvider } from '../src/state/catalog';

test('shows default single sedan full detail price and deposit', () => {
  render(
    <CatalogProvider><OrderProvider>
      <PriceBar onNext={() => {}} label="Continue" />
    </OrderProvider></CatalogProvider>,
  );
  expect(screen.getByText('$120')).toBeTruthy();
  expect(screen.getByText(/\$30 deposit/)).toBeTruthy(); // 25% of 120
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx jest __tests__/pricebar.test.tsx`

- [ ] **Step 3: Write `bld-app/src/components/Seg.tsx`**

```tsx
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';

export default function Seg<T extends string>({
  options, labels, value, onChange,
}: { options: readonly T[]; labels?: Partial<Record<T, string>>; value: T; onChange: (v: T) => void }) {
  return (
    <View style={s.row}>
      {options.map((o) => {
        const active = o === value;
        return (
          <Pressable
            key={o}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o)}
            style={[s.opt, active && s.active]}
          >
            <Text style={[s.text, active && s.textActive]}>{labels?.[o] ?? o}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing(2) },
  opt: {
    flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface, borderRadius: radius.button, borderWidth: 1, borderColor: colors.border,
  },
  active: { borderColor: colors.primaryBright, backgroundColor: '#1a1030' },
  text: { color: colors.textMuted, fontSize: 15, textTransform: 'capitalize' },
  textActive: { color: colors.text, fontWeight: '700' },
});
```

- [ ] **Step 4: Write `bld-app/src/components/PriceBar.tsx`**

```tsx
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { priceOrder } from '../../../supabase/functions/_shared/pricing';
import { useCatalog } from '../state/catalog';
import { useOrder } from '../state/order';
import { colors, fonts, radius, spacing } from '../theme';

export default function PriceBar({ onNext, label }: { onNext: () => void; label: string }) {
  const catalog = useCatalog();
  const { state } = useOrder();
  const quote = priceOrder(state.items, catalog);
  return (
    <View style={s.bar}>
      <View>
        <Text style={s.total}>${quote.total}</Text>
        <Text style={s.deposit}>${quote.deposit} deposit · ${quote.remainder} at the job</Text>
      </View>
      <Pressable accessibilityRole="button" style={s.btn} onPress={onNext}>
        <Text style={s.btnText}>{label}</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderTopWidth: 1, borderColor: colors.border,
    padding: spacing(4), paddingBottom: spacing(7),
  },
  total: { fontFamily: fonts.headingBlack, fontSize: 30, color: colors.primaryBright },
  deposit: { color: colors.textMuted, fontSize: 13 },
  btn: { backgroundColor: colors.primary, borderRadius: radius.button, paddingVertical: spacing(4), paddingHorizontal: spacing(7), minHeight: 48, justifyContent: 'center' },
  btnText: { fontFamily: fonts.heading, color: colors.text, fontSize: 16, letterSpacing: 0.5 },
});
```

- [ ] **Step 5: Run — expect PASS.** `npx jest __tests__/pricebar.test.tsx`

- [ ] **Step 6: Replace `bld-app/src/screens/Build.tsx`**

```tsx
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import type { Extra } from '../../../supabase/functions/_shared/pricing';
import Seg from '../components/Seg';
import PriceBar from '../components/PriceBar';
import { useOrder } from '../state/order';
import { useCatalog } from '../state/catalog';
import { colors, fonts, radius, spacing } from '../theme';

const SIZES = ['sedan', 'suv', 'truck'] as const;
const SERVICES = ['outside', 'inside', 'full'] as const;
const EXTRAS: { key: Extra; label: string }[] = [
  { key: 'ceramic', label: 'Ceramic coating' },
  { key: 'headlight', label: 'Headlight restore' },
  { key: 'engine', label: 'Engine bay' },
  { key: 'pet', label: 'Pet hair / odor' },
];

type Props = NativeStackScreenProps<RootStackParamList, 'Build'>;

export default function Build({ navigation }: Props) {
  const { state, dispatch } = useOrder();
  const catalog = useCatalog();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(8) }}>
        <Text style={s.label}>How many cars?</Text>
        <View style={s.stepper}>
          <Pressable accessibilityRole="button" style={s.stepBtn} onPress={() => dispatch({ type: 'SET_CAR_COUNT', count: state.items.length - 1 })}>
            <Text style={s.stepText}>−</Text>
          </Pressable>
          <Text style={s.count}>{state.items.length}</Text>
          <Pressable accessibilityRole="button" style={s.stepBtn} onPress={() => dispatch({ type: 'SET_CAR_COUNT', count: state.items.length + 1 })}>
            <Text style={s.stepText}>+</Text>
          </Pressable>
        </View>

        {state.items.map((car, i) => (
          <View key={i} style={s.card}>
            <Text style={s.carTitle}>CAR {i + 1}</Text>
            <Text style={s.label}>Size</Text>
            <Seg options={SIZES} labels={{ sedan: 'Sedan', suv: 'SUV', truck: 'Truck/Van' }} value={car.size}
              onChange={(size) => dispatch({ type: 'SET_SIZE', index: i, size })} />
            <Text style={s.label}>Service</Text>
            <Seg
              options={SERVICES}
              labels={{
                outside: `Outside $${Math.round(catalog.services.outside * catalog.sizeMultipliers[car.size])}`,
                inside: `Inside $${Math.round(catalog.services.inside * catalog.sizeMultipliers[car.size])}`,
                full: `Full $${Math.round(catalog.services.full * catalog.sizeMultipliers[car.size])}`,
              }}
              value={car.service}
              onChange={(service) => dispatch({ type: 'SET_SERVICE', index: i, service })}
            />
            <Text style={s.label}>Extras</Text>
            {EXTRAS.map((e) => {
              const on = car.extras.includes(e.key);
              return (
                <Pressable key={e.key} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                  style={[s.extra, on && s.extraOn]}
                  onPress={() => dispatch({ type: 'TOGGLE_EXTRA', index: i, extra: e.key })}>
                  <Text style={[s.extraText, on && { color: colors.text }]}>{e.label}</Text>
                  <Text style={s.extraPrice}>+${catalog.extras[e.key]}</Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
      <PriceBar label="Continue" onNext={() => navigation.navigate('Schedule')} />
    </View>
  );
}

const s = StyleSheet.create({
  label: { color: colors.textMuted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing(4), marginBottom: spacing(2) },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing(4) },
  stepBtn: { width: 48, height: 48, borderRadius: radius.button, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  stepText: { color: colors.text, fontSize: 24 },
  count: { fontFamily: fonts.headingBlack, color: colors.text, fontSize: 28, minWidth: 32, textAlign: 'center' },
  card: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, padding: spacing(4), marginTop: spacing(4) },
  carTitle: { fontFamily: fonts.heading, color: colors.primaryBright, fontSize: 16, letterSpacing: 1 },
  extra: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44, paddingHorizontal: spacing(3), borderRadius: radius.button, borderWidth: 1, borderColor: colors.border, marginBottom: spacing(2) },
  extraOn: { borderColor: colors.primaryBright, backgroundColor: '#1a1030' },
  extraText: { color: colors.textMuted, fontSize: 15 },
  extraPrice: { color: colors.textSecondary, fontSize: 14 },
});
```

- [ ] **Step 7: Verify** — `npx expo start`: tapping sizes/services/extras updates the bottom bar instantly; SUV full shows `Full $150` in the segment label. `npx jest` all green.

- [ ] **Step 8: Commit**

```bash
git add bld-app/src/components bld-app/src/screens/Build.tsx bld-app/__tests__/pricebar.test.tsx
git commit -m "feat: build-your-detail screen with live price bar"
```

---

### Task 12: Schedule screen

**Files:**
- Modify: `bld-app/src/screens/Schedule.tsx` (replace placeholder)

**Interfaces:**
- Consumes: `useOrder` (`SET_FIELD`), `Seg`, `PriceBar`; `expo-location` for the "Use my location" autofill.
- Produces: validated `address` + `preferredDay` + `window` + `notes` on order state; blocks Continue until address and day set.

- [ ] **Step 1: Write `bld-app/src/screens/Schedule.tsx`**

```tsx
import React, { useMemo } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import Seg from '../components/Seg';
import PriceBar from '../components/PriceBar';
import { useOrder } from '../state/order';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Schedule'>;

function nextDays(n: number): { iso: string; label: string }[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i + 1);
    return {
      iso: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
    };
  });
}

export default function Schedule({ navigation }: Props) {
  const { state, dispatch } = useOrder();
  const days = useMemo(() => nextDays(10), []);
  const set = (field: 'address' | 'preferredDay' | 'window' | 'notes') => (value: string) =>
    dispatch({ type: 'SET_FIELD', field, value });

  const useMyLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    const pos = await Location.getCurrentPositionAsync({});
    const [a] = await Location.reverseGeocodeAsync(pos.coords);
    if (a) set('address')(`${a.streetNumber ?? ''} ${a.street ?? ''}, ${a.city ?? ''} ${a.postalCode ?? ''}`.trim());
  };

  const next = () => {
    if (!state.address.trim()) return Alert.alert('Where to?', 'Enter the address where the vehicle will be.');
    if (!state.preferredDay) return Alert.alert('Pick a day', 'Choose your preferred day.');
    navigation.navigate('Pay');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing(4) }}>
        <Text style={s.label}>Where's the vehicle?</Text>
        <TextInput style={s.input} placeholder="Street address" placeholderTextColor={colors.textMuted}
          value={state.address} onChangeText={set('address')} />
        <Pressable accessibilityRole="button" onPress={useMyLocation}>
          <Text style={s.link}>📍 Use my location</Text>
        </Pressable>

        <Text style={s.label}>Preferred day</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing(2) }}>
          {days.map((d) => (
            <Pressable key={d.iso} accessibilityRole="button" onPress={() => set('preferredDay')(d.iso)}
              style={[s.day, state.preferredDay === d.iso && s.dayOn]}>
              <Text style={[s.dayText, state.preferredDay === d.iso && { color: colors.text }]}>{d.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <Text style={s.label}>Time window</Text>
        <Seg options={['morning', 'afternoon', 'either'] as const}
          labels={{ morning: 'Morning', afternoon: 'Afternoon', either: 'Either' }}
          value={state.window} onChange={set('window')} />
        <Text style={s.hint}>We'll text you to lock in the exact time.</Text>

        <Text style={s.label}>Notes (gate code, which car, etc.)</Text>
        <TextInput style={[s.input, { height: 88, textAlignVertical: 'top' }]} multiline
          placeholder="Optional" placeholderTextColor={colors.textMuted}
          value={state.notes} onChangeText={set('notes')} />
      </ScrollView>
      <PriceBar label="Continue" onNext={next} />
    </View>
  );
}

const s = StyleSheet.create({
  label: { color: colors.textMuted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing(5), marginBottom: spacing(2) },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, color: colors.text, padding: spacing(3.5), fontSize: 16 },
  link: { color: colors.primaryBright, marginTop: spacing(2), fontSize: 14 },
  day: { paddingHorizontal: spacing(4), minHeight: 44, justifyContent: 'center', borderRadius: radius.button, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  dayOn: { borderColor: colors.primaryBright, backgroundColor: '#1a1030' },
  dayText: { color: colors.textMuted, fontSize: 14 },
  hint: { color: colors.textMuted, fontSize: 13, marginTop: spacing(2) },
});
```

- [ ] **Step 2: Verify** — flow Home → Build → Continue → Schedule: address entry, day chips, window seg, notes; Continue without address alerts; with data navigates to Pay placeholder. `npx jest` still green.

- [ ] **Step 3: Commit**

```bash
git add bld-app/src/screens/Schedule.tsx
git commit -m "feat: schedule screen with day and window pickers"
```

---

### Task 13: Pay screen (phone OTP + card + book call)

**Files:**
- Modify: `bld-app/src/screens/Pay.tsx` (replace placeholder)

**Interfaces:**
- Consumes: `supabase.auth.signInWithOtp({phone})` / `verifyOtp({phone, token, type: 'sms'})`; `supabase.functions.invoke('book', {body})` per Task 6's contract; `priceOrder` for the displayed quote; `useOrder`.
- Produces: on success navigates `Booked {bookingId}`. Handles `409 price_changed` (show new quote, require re-tap), `402` decline (retry message), OTP resend with 60s cooldown.

- [ ] **Step 1: Write `bld-app/src/screens/Pay.tsx`**

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { priceOrder, type Quote } from '../../../supabase/functions/_shared/pricing';
import Seg from '../components/Seg';
import { supabase } from '../api';
import { useCatalog } from '../state/catalog';
import { useOrder } from '../state/order';
import { colors, fonts, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Pay'>;

const normalizePhone = (raw: string) => {
  const d = raw.replace(/\D/g, '');
  return d.length === 10 ? `+1${d}` : d.startsWith('1') && d.length === 11 ? `+${d}` : raw.startsWith('+') ? raw : `+${d}`;
};

export default function Pay({ navigation }: Props) {
  const { state, dispatch } = useOrder();
  const catalog = useCatalog();
  const [quote, setQuote] = useState<Quote>(() => priceOrder(state.items, catalog));
  const [phase, setPhase] = useState<'phone' | 'code' | 'card'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [exp, setExp] = useState('');
  const [cvc, setCvc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { if (data.session) setPhase('card'); });
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  const startCooldown = () => {
    setCooldown(60);
    timer.current = setInterval(() => setCooldown((c) => {
      if (c <= 1 && timer.current) clearInterval(timer.current);
      return Math.max(0, c - 1);
    }), 1000);
  };

  const sendCode = async () => {
    setError(''); setBusy(true);
    const { error: e } = await supabase.auth.signInWithOtp({ phone: normalizePhone(phone) });
    setBusy(false);
    if (e) return setError(e.message);
    setPhase('code'); startCooldown();
  };

  const verify = async () => {
    setError(''); setBusy(true);
    const { error: e } = await supabase.auth.verifyOtp({ phone: normalizePhone(phone), token: code, type: 'sms' });
    setBusy(false);
    if (e) return setError('Wrong code — check the text and try again.');
    setPhase('card');
  };

  const pay = async () => {
    setError(''); setBusy(true);
    const [mm, yy] = exp.split('/');
    const { data, error: e } = await supabase.functions.invoke('book', {
      body: {
        items: state.items, address: state.address, preferredDay: state.preferredDay,
        window: state.window, notes: state.notes, remainderMethod: state.remainderMethod,
        name: state.name, expectedTotal: quote.total,
        card: { number: cardNumber.replace(/\s/g, ''), expMonth: Number(mm), expYear: 2000 + Number(yy), cvc },
      },
    });
    setBusy(false);
    if (e) {
      const ctx = (e as { context?: Response }).context;
      if (ctx) {
        const body = await ctx.json().catch(() => ({}));
        if (body.error === 'price_changed' && body.quote) {
          setQuote(body.quote);
          return setError(`Prices were updated — new total is $${body.quote.total}. Tap Pay again to accept.`);
        }
        if (body.error === 'card_declined') return setError('Card declined. Try another card.');
        return setError(body.error ?? 'Something went wrong. Try again.');
      }
      return setError('Network problem. Check your signal and try again.');
    }
    navigation.reset({ index: 0, routes: [{ name: 'Booked', params: { bookingId: data.bookingId } }] });
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing(4) }}>
      <View style={s.summary}>
        <Text style={s.total}>${quote.total}</Text>
        <Text style={s.line}>${quote.deposit} deposit due now (card)</Text>
        <Text style={s.line}>${quote.remainder} at the detail</Text>
        <Text style={s.label}>Pay the rest with</Text>
        <Seg options={['cash', 'card'] as const} labels={{ cash: 'Cash at the job', card: 'Card at the job' }}
          value={state.remainderMethod}
          onChange={(v) => dispatch({ type: 'SET_FIELD', field: 'remainderMethod', value: v })} />
      </View>

      {phase === 'phone' && (
        <View>
          <Text style={s.label}>Your name</Text>
          <TextInput style={s.input} placeholder="First name" placeholderTextColor={colors.textMuted}
            value={state.name} onChangeText={(v) => dispatch({ type: 'SET_FIELD', field: 'name', value: v })} />
          <Text style={s.label}>Phone (we text your booking updates here)</Text>
          <TextInput style={s.input} placeholder="(215) 555-0134" placeholderTextColor={colors.textMuted}
            keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
          <Pressable accessibilityRole="button" style={s.btn} onPress={sendCode} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>TEXT ME A CODE</Text>}
          </Pressable>
        </View>
      )}

      {phase === 'code' && (
        <View>
          <Text style={s.label}>Enter the 6-digit code we texted</Text>
          <TextInput style={[s.input, s.code]} keyboardType="number-pad" maxLength={6} value={code} onChangeText={setCode} />
          <Pressable accessibilityRole="button" style={s.btn} onPress={verify} disabled={busy || code.length !== 6}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>VERIFY</Text>}
          </Pressable>
          <Pressable accessibilityRole="button" onPress={sendCode} disabled={cooldown > 0}>
            <Text style={s.resend}>{cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}</Text>
          </Pressable>
        </View>
      )}

      {phase === 'card' && (
        <View>
          <Text style={s.label}>Card for the ${quote.deposit} deposit</Text>
          <TextInput style={s.input} placeholder="Card number" placeholderTextColor={colors.textMuted}
            keyboardType="number-pad" value={cardNumber} onChangeText={setCardNumber} />
          <View style={{ flexDirection: 'row', gap: spacing(2) }}>
            <TextInput style={[s.input, { flex: 1 }]} placeholder="MM/YY" placeholderTextColor={colors.textMuted}
              value={exp} onChangeText={setExp} />
            <TextInput style={[s.input, { flex: 1 }]} placeholder="CVC" placeholderTextColor={colors.textMuted}
              keyboardType="number-pad" maxLength={4} value={cvc} onChangeText={setCvc} />
          </View>
          <Pressable accessibilityRole="button" style={s.btn} onPress={pay} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>PAY ${quote.deposit} DEPOSIT</Text>}
          </Pressable>
        </View>
      )}

      {!!error && <Text style={s.error}>{error}</Text>}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  summary: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, padding: spacing(4), marginBottom: spacing(4) },
  total: { fontFamily: fonts.headingBlack, fontSize: 36, color: colors.primaryBright },
  line: { color: colors.textSecondary, fontSize: 15, marginTop: spacing(1) },
  label: { color: colors.textMuted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing(4), marginBottom: spacing(2) },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, color: colors.text, padding: spacing(3.5), fontSize: 16, marginBottom: spacing(2) },
  code: { textAlign: 'center', fontSize: 24, letterSpacing: 8 },
  btn: { backgroundColor: colors.primary, borderRadius: radius.button, minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: spacing(2) },
  btnText: { fontFamily: fonts.heading, color: colors.text, fontSize: 16, letterSpacing: 1 },
  resend: { color: colors.primaryBright, textAlign: 'center', marginTop: spacing(4), fontSize: 14 },
  error: { color: colors.danger, marginTop: spacing(4), fontSize: 14, textAlign: 'center' },
});
```

- [ ] **Step 2: Verify against local stack** — `npx supabase start` + `npx supabase functions serve`; point `.env` at `http://127.0.0.1:54321` temporarily. Local OTP: Supabase local logs the code (no real SMS). Card `4242 4242 4242 4242` → Booked; card ending `0002` → "Card declined" and booking row stays `pending_payment`. Restore hosted `.env` values after.

- [ ] **Step 3: Commit**

```bash
git add bld-app/src/screens/Pay.tsx
git commit -m "feat: pay screen with phone OTP and deposit payment"
```

---

### Task 14: Booked screen + full walkthrough + owner acceptance

**Files:**
- Modify: `bld-app/src/screens/Booked.tsx` (replace placeholder)
- Create: `docs/superpowers/specs/2026-07-16-bld-round1-acceptance.md`

**Interfaces:**
- Consumes: route param `{bookingId}`, `useOrder` (`RESET`), `expo-calendar`.
- Produces: terminal screen; "Done" resets order and returns Home.

- [ ] **Step 1: Write `bld-app/src/screens/Booked.tsx`**

```tsx
import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Calendar from 'expo-calendar';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useOrder } from '../state/order';
import { colors, fonts, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Booked'>;

export default function Booked({ navigation }: Props) {
  const { state, dispatch } = useOrder();

  const addToCalendar = async () => {
    const { status } = await Calendar.requestCalendarPermissionsAsync();
    if (status !== 'granted') return;
    const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const cal = cals.find((c) => c.allowsModifications);
    if (!cal) return;
    const start = new Date(`${state.preferredDay}T${state.window === 'afternoon' ? '13:00' : '09:00'}:00`);
    await Calendar.createEventAsync(cal.id, {
      title: 'Brotherly Love Detailing',
      location: state.address,
      startDate: start,
      endDate: new Date(start.getTime() + 2 * 3600e3),
      notes: 'Exact time will be confirmed by text.',
    });
    Alert.alert('Added', 'Detail day is on your calendar.');
  };

  const done = () => {
    dispatch({ type: 'RESET' });
    navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
  };

  return (
    <View style={s.root}>
      <Text style={s.check}>✓</Text>
      <Text style={s.title}>YOU'RE BOOKED</Text>
      <Text style={s.sub}>Deposit paid. We'll text you shortly to lock in your exact time for {state.preferredDay} ({state.window}).</Text>
      <Text style={s.addr}>{state.address}</Text>
      <Pressable accessibilityRole="button" style={s.ghost} onPress={addToCalendar}>
        <Text style={s.ghostText}>ADD TO CALENDAR</Text>
      </Pressable>
      <Pressable accessibilityRole="button" style={s.btn} onPress={done}>
        <Text style={s.btnText}>DONE</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing(8) },
  check: { fontSize: 64, color: colors.success },
  title: { fontFamily: fonts.headingBlack, fontSize: 32, color: colors.text, marginTop: spacing(4) },
  sub: { color: colors.textSecondary, fontSize: 16, textAlign: 'center', marginTop: spacing(3), lineHeight: 23 },
  addr: { color: colors.textMuted, fontSize: 14, marginTop: spacing(2) },
  ghost: { marginTop: spacing(8), borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, paddingVertical: spacing(3.5), paddingHorizontal: spacing(8), minHeight: 48, justifyContent: 'center' },
  ghostText: { color: colors.textSecondary, fontFamily: fonts.heading, fontSize: 14, letterSpacing: 1 },
  btn: { marginTop: spacing(3), backgroundColor: colors.primary, borderRadius: radius.button, paddingVertical: spacing(3.5), paddingHorizontal: spacing(12), minHeight: 48, justifyContent: 'center' },
  btnText: { color: colors.text, fontFamily: fonts.heading, fontSize: 16, letterSpacing: 1 },
});
```

- [ ] **Step 2: Full end-to-end walkthrough (fake payments)**

Against the hosted project: `npx expo start`, open on a real phone via Expo Go.
1. Home → GET MY DETAIL → build 2 cars (sedan full + SUV outside w/ headlight) → bar shows $120 + $96 = $216, deposit $54.
2. Schedule: address, day, Morning. 3. Pay: real phone → real OTP text (Twilio configured) or test OTP → card `4242…4242` → Booked screen.
4. Owner phone (OWNER_PHONE) receives SMS with confirm link (or check function logs for dry-run). Open link → Confirm with "Thu 10:00 AM" → customer receives confirmation SMS → booking row `confirmed` in dashboard.
5. Repeat with decline: booking `refunded`, refund row in `payments`, customer SMS sent.
6. Run `npx jest` from `bld-app/`: all suites pass.

- [ ] **Step 3: Write acceptance doc `docs/superpowers/specs/2026-07-16-bld-round1-acceptance.md`**

```markdown
# Round 1 Acceptance — Owner Checklist

Do these on your own phone before we submit to the stores:
1. Open the app, book a fake detail (card 4242 4242 4242 4242).
2. You should get a text within seconds with the job + a link.
3. Tap the link, type a time, hit Confirm — the customer phone gets the confirmation text.
4. Book another one and hit Decline & refund — customer gets the refund text.
5. Try card 4000 0000 0000 0002 — it must decline and nothing gets booked.

If all five work, round 1 is done. Before real customers:
- Pick the payment processor (Stripe recommended) — one file swap.
- Set Twilio credentials so texts are real.
- Set the deposit % and SUV/Truck multipliers in the catalog table.
```

- [ ] **Step 4: Commit**

```bash
git add bld-app/src/screens/Booked.tsx docs/superpowers/specs/2026-07-16-bld-round1-acceptance.md
git commit -m "feat: booked screen and round-1 acceptance checklist"
```

---

## Self-Review (performed at plan-writing time)

- **Spec coverage:** 5 screens (Tasks 10–14) ✓; request-day+window scheduling ✓ (Task 12); percentage deposit, card-only deposit, cash/card remainder ✓ (Tasks 2, 13); phone-code-at-checkout ✓ (Task 13); catalog-in-DB pricing with frozen quote ✓ (Tasks 4, 6); price-drift 409 before charging ✓ (Tasks 6, 13); owner SMS + signed confirm page with confirm/propose/decline+refund ✓ (Tasks 6–7); 24h/48h silence policy ✓ (Task 8); membership tables + ledger invariant, no UI ✓ (Task 4); provider swap point ✓ (Task 3); separate Supabase project guard ✓ (Task 4, Global Constraints); fake-payment E2E + owner acceptance ✓ (Task 14).
- **Type consistency:** `time_window` is the DB column (SQL reserved-ish `window` avoided); app/API field is `window`, mapped in Task 6's insert ✓. `Quote.deposit` dollars vs `payments.amount_cents` cents conversion at `* 100` in Tasks 6–8 ✓. `getProvider().refund` signature matches Tasks 3/7/8 ✓.
- **Placeholders:** `.env` REPLACED_IN_TASK_4 values are real instructions with a defined owner task, not open questions. No TBDs remain.
```
