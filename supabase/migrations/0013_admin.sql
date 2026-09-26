-- 0013_admin.sql
-- Owner / management dashboard: staff logins, private customer reports (with photos),
-- a daily job cap with closed days, and lead follow-up. Apply AFTER 0012.

-- ——— staff: the owner and managers log in with a personal code ———
-- Only the code's sha256 is stored; the code itself is shown once when it's made.
create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null check (role in ('owner', 'manager')),
  code_hash text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

-- ——— private customer reports: only staff ever see these ———
create table if not exists customer_reports (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  booking_id uuid references bookings(id) on delete set null,
  category text not null default 'note'
    check (category in ('note', 'damage', 'complaint', 'no_show', 'payment', 'other')),
  body text not null check (length(body) between 1 and 4000),
  photos text[] not null default '{}', -- paths in the private report-photos bucket
  author_staff_id uuid references staff(id) on delete set null,
  author_name text not null,
  created_at timestamptz not null default now()
);
create index if not exists customer_reports_customer on customer_reports (customer_id, created_at desc);

-- ——— availability: a default daily job cap + weekdays closed (catalog.schedule), and
-- per-date overrides. An override row decides that date outright: it can close a normally
-- open day, or open a normally closed weekday with its own cap. ———
create table if not exists day_overrides (
  day date primary key,
  closed boolean not null default false,
  capacity int check (capacity is null or capacity between 0 and 50),
  note text not null default ''
);

-- ——— lead follow-up ———
alter table quote_leads add column if not exists status text not null default 'new'
  check (status in ('new', 'contacted', 'booked', 'lost'));

alter table staff enable row level security;
alter table customer_reports enable row level security;
alter table day_overrides enable row level security;
-- No policies: every read/write goes through the admin edge function (service role).

-- ——— catalog: schedule defaults + prices the website shows. Existing keys win. ———
update catalog set config =
  '{"schedule": {"dailyCapacity": 9, "closedWeekdays": []},
    "firstWashDiscountPercent": 10,
    "packages": {"ministry": 220}}'::jsonb || config
where id = 1;

-- Per-day availability, no PII. The app greys out closed/full days with it, `book` refuses
-- them, and the dashboard calendar draws from it — one source of truth. closedWeekdays
-- uses 0 = Sunday … 6 = Saturday. Range capped at ~3 months (callable by anyone).
create or replace function day_states(from_day date, to_day date)
returns table(day date, capacity int, booked int, closed boolean)
language sql
security definer
set search_path = public
stable
as $$
  with cfg as (select coalesce(config->'schedule', '{}'::jsonb) s from catalog where id = 1),
  days as (
    select d::date as day
    from generate_series(from_day, least(to_day, from_day + 92), interval '1 day') d
  ),
  st as (
    select days.day,
      case when o.day is not null then o.closed
           else coalesce((cfg.s->'closedWeekdays') @> to_jsonb(extract(dow from days.day)::int), false)
      end as closed,
      coalesce(o.capacity, (cfg.s->>'dailyCapacity')::int, 9) as cap
    from days cross join cfg
    left join day_overrides o on o.day = days.day
  )
  select st.day,
    case when st.closed then 0 else st.cap end,
    (select count(*)::int from bookings b
      where b.preferred_day = st.day and b.status not in ('declined', 'refunded')),
    st.closed
  from st order by st.day
$$;

revoke all on function day_states(date, date) from public;
grant execute on function day_states(date, date) to anon, authenticated;

-- ——— report photos: private bucket; staff upload through signed URLs and view through
-- short-lived signed URLs from the admin function. ———
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-photos', 'report-photos', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do nothing;
