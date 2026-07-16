-- Specific appointment times. time_slot is 24h "HH:MM" (e.g. '09:00', '14:00').
-- time_window stays for legacy rows; new bookings derive it from the slot.
alter table bookings add column if not exists time_slot text
  check (time_slot is null or time_slot ~ '^[0-2][0-9]:[0-5][0-9]$');

create index if not exists bookings_day_slot on bookings (preferred_day, time_slot);

-- Public availability surface: which slots are taken on a given day.
-- SECURITY DEFINER so anon can see taken times WITHOUT reading booking rows
-- (RLS on bookings stays customer-own). Returns time strings only — no
-- customer data can leak through this function.
create or replace function booked_slots(day date)
returns setof text
language sql
security definer
set search_path = public
stable
as $$
  select time_slot from bookings
  where preferred_day = day
    and time_slot is not null
    and status not in ('declined', 'refunded')
$$;

revoke all on function booked_slots(date) from public;
grant execute on function booked_slots(date) to anon, authenticated;
