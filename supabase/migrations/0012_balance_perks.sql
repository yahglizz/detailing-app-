-- 0012_balance_perks.sql
-- Tier perks (member price, top-up bonus, stamps per car) and a prepaid balance that
-- anyone can load and spend at checkout. Apply AFTER 0011.

-- ——— tier perks: the higher the tier, the better every perk ———
update catalog set config = jsonb_set(jsonb_set(jsonb_set(config,
    '{plans,bronze}', (config #> '{plans,bronze}') || '{"discountPercent": 10, "topupBonusPercent": 5,  "stampsPerCar": 1}'),
    '{plans,silver}', (config #> '{plans,silver}') || '{"discountPercent": 15, "topupBonusPercent": 10, "stampsPerCar": 2}'),
    '{plans,gold}',   (config #> '{plans,gold}')   || '{"discountPercent": 20, "topupBonusPercent": 15, "stampsPerCar": 3}')
  || '{"topup": {"min": 10, "max": 500}}'
where id = 1;

-- ——— login codes for everyone ———
-- Members log in with memberships.code. Anyone else who loads a balance gets a code of
-- the same BLD-XXXXXX shape here, emailed to them (never shown in the app).
alter table customers add column if not exists code text unique;

-- Owner-made test accounts get a tier switcher in the app. Only settable here, in SQL.
alter table memberships add column if not exists is_test boolean not null default false;
update memberships m set is_test = true
  from customers c where c.id = m.customer_id and c.email like '%@bld.local';

-- ——— prepaid balance ———
-- A top-up is a Stripe Checkout for a whole-dollar amount; `bonus` is the tier bonus
-- promised when it was started.
create table if not exists topups (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  amount int not null check (amount > 0),
  bonus int not null default 0 check (bonus >= 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'cancelled')),
  stripe_session_id text unique,
  payment_ref text unique, -- the payment intent; a refund of it takes the money back
  created_at timestamptz not null default now()
);

-- Balance in whole dollars, like quotes and credits. `ref` makes each write happen once
-- (the webhook and the app's return can both report the same payment).
create table if not exists wallet_ledger (
  id bigint generated always as identity primary key,
  customer_id uuid not null references customers(id),
  delta int not null check (delta <> 0),
  reason text not null,
  ref text unique,
  booking_id uuid references bookings(id),
  topup_id uuid references topups(id),
  created_at timestamptz not null default now()
);
create index if not exists wallet_ledger_customer on wallet_ledger (customer_id);
create index if not exists wallet_ledger_booking on wallet_ledger (booking_id) where booking_id is not null;

-- Balance can't go negative. The lock serializes writers per customer: without it two
-- concurrent spends each miss the other's uncommitted row under READ COMMITTED and both
-- pass. After the lock, the sum runs on a fresh snapshot that sees the other commit.
create or replace function enforce_nonnegative_wallet() returns trigger language plpgsql as $$
declare bal int;
begin
  perform pg_advisory_xact_lock(hashtextextended('wallet_ledger:' || new.customer_id::text, 0));
  select coalesce(sum(delta), 0) into bal from wallet_ledger where customer_id = new.customer_id;
  if bal < 0 then
    raise exception 'wallet balance cannot go negative';
  end if;
  return new;
end $$;
drop trigger if exists wallet_ledger_nonnegative on wallet_ledger;
create trigger wallet_ledger_nonnegative after insert on wallet_ledger
  for each row execute function enforce_nonnegative_wallet();

-- Same race in the credit and stamp ledgers (two bookings spending the last credit at
-- once): same fix.
create or replace function enforce_nonnegative_credits() returns trigger language plpgsql as $$
declare bal int;
begin
  perform pg_advisory_xact_lock(hashtextextended('credit_ledger:' || new.membership_id::text, 0));
  select coalesce(sum(delta), 0) into bal from credit_ledger where membership_id = new.membership_id;
  if bal < 0 then
    raise exception 'credit balance cannot go negative';
  end if;
  return new;
end $$;
create or replace function enforce_nonnegative_stamps() returns trigger language plpgsql as $$
declare bal int;
begin
  perform pg_advisory_xact_lock(hashtextextended('reward_ledger:' || new.membership_id::text, 0));
  select coalesce(sum(delta), 0) into bal from reward_ledger where membership_id = new.membership_id;
  if bal < 0 then
    raise exception 'stamp balance cannot go negative';
  end if;
  return new;
end $$;

-- ——— code guessing limit ———
-- One row per failed code lookup; the functions refuse an IP with too many recent
-- failures. sweep deletes rows older than a day.
create table if not exists code_attempts (
  id bigint generated always as identity primary key,
  ip text not null,
  created_at timestamptz not null default now()
);
create index if not exists code_attempts_recent on code_attempts (created_at, ip);

alter table topups enable row level security;
alter table wallet_ledger enable row level security;
alter table code_attempts enable row level security;
-- No policies: only the edge functions (service role) read or write these.
