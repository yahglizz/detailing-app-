-- Applied to project fiaadogbkvjcddehnymj (brotherly-love-detailing) on 2026-07-16
-- via MCP apply_migration "init_booking_schema".
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
