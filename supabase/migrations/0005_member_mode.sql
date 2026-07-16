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
-- No public policies: all reads/writes go through edge functions with the service role.

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
