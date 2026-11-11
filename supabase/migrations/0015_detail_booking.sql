-- Starting-price booking: five services priced by vehicle type, flat vehicle deposits,
-- demo-first payments, and the owner's inspection invoice.
-- Apply to project fiaadogbkvjcddehnymj (brotherly-love-detailing) via MCP apply_migration
-- or the Supabase CLI, after the owner's go. Safe to re-run: nothing here overwrites data.
-- Spec: docs/superpowers/specs/2026-11-10-bld-starting-prices-design.md

-- ——— new-flow columns on bookings (app rows keep flow = null) ———
alter table bookings add column if not exists flow text;
alter table bookings add column if not exists detail jsonb;
alter table bookings add column if not exists deposit_status text not null default 'pending'
  check (deposit_status in ('pending', 'demo', 'paid', 'refunded'));

-- One live booking per slot for the new flow. The detail function also checks app rows.
create unique index if not exists bookings_detail_slot_once
  on bookings (preferred_day, time_slot)
  where flow = 'detail_v2' and time_slot is not null and status not in ('declined', 'refunded');

-- ——— the owner's in-person invoice, one per booking ———
create table if not exists booking_invoices (
  booking_id uuid primary key references bookings(id) on delete cascade,
  service_price int not null default 0 check (service_price between 0 and 10000),
  extras jsonb not null default '[]'::jsonb,
  customer_approved_at timestamptz,
  approved_note text,
  deposit_credit int not null default 0 check (deposit_credit >= 0),
  total int not null default 0 check (total >= 0),
  balance int not null default 0 check (balance >= 0),
  status text not null default 'draft' check (status in ('draft', 'approved', 'paid')),
  paid_at timestamptz,
  paid_method text check (paid_method in ('cash', 'card')),
  updated_at timestamptz not null default now()
);
alter table booking_invoices enable row level security;
-- No policies: only edge functions (service role) read or write invoices.
drop trigger if exists booking_invoices_updated_at on booking_invoices;
create trigger booking_invoices_updated_at before update on booking_invoices
  for each row execute function set_updated_at();

-- ——— capacity, enforced atomically. Two requests racing for a nearly full day would both
-- pass the function's read-then-insert checks; this trigger serialises them per day. App
-- bookings (`book`) don't take this lock; that older race is documented in book/index.ts. ———
create or replace function enforce_detail_capacity() returns trigger language plpgsql as $$
declare st record;
begin
  if new.flow is distinct from 'detail_v2' then return new; end if;
  perform pg_advisory_xact_lock(hashtext('detail-day:' || new.preferred_day::text));
  select * into st from day_states(new.preferred_day, new.preferred_day) limit 1;
  if st.day is null then return new; end if;
  if st.closed then raise exception 'day_closed'; end if;
  if st.booked >= st.capacity then raise exception 'day_full'; end if;
  return new;
end $$;
drop trigger if exists bookings_detail_capacity on bookings;
create trigger bookings_detail_capacity before insert on bookings
  for each row execute function enforce_detail_capacity();

-- ——— customer vehicle photos: private; customers upload through signed URLs the
-- detail function issues, the owner views through short-lived signed URLs ———
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('booking-photos', 'booking-photos', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do nothing;

-- ——— payments stay in demo until the owner flips this ('demo' is the only value the
-- demo endpoint accepts; a real provider path will use a different one) ———
insert into app_config (key, value) values ('payments_mode', 'demo')
on conflict (key) do nothing;

-- ——— prices: the single source of truth. Never overwrites an owner's edits. The JSON
-- between the markers must equal DEFAULT_DETAIL_PRICING (a Jest test checks it). ———
update catalog
set config = case
  when config ? 'detailPricing' then config
  else config || jsonb_build_object('detailPricing',
-- detailPricing:begin
$json${
  "vehicleTypes": {
    "sedan": "Sedan",
    "suv": "SUV / Truck",
    "large": "Large SUV / 3-Row"
  },
  "deposits": {
    "sedan": 25,
    "suv": 35,
    "large": 45
  },
  "bookingWindowDays": 14,
  "services": {
    "exterior": {
      "name": "Exterior Wash",
      "blurb": "A careful hand wash that leaves the outside clean and glossy.",
      "includes": [
        "Hand wash and dry",
        "Wheels and tires cleaned",
        "Exterior windows",
        "Tire dressing"
      ],
      "duration": "45 to 60 minutes",
      "popular": false,
      "prices": {
        "sedan": 40,
        "suv": 50,
        "large": 60
      }
    },
    "refresh": {
      "name": "Interior Refresh",
      "blurb": "A light clean to reset the cabin between details.",
      "includes": [
        "Full vacuum",
        "Dash, console and door panels wiped",
        "Interior windows",
        "Floor mats cleaned",
        "Trash removed"
      ],
      "duration": "1 to 1.5 hours",
      "popular": false,
      "prices": {
        "sedan": 80,
        "suv": 95,
        "large": 110
      }
    },
    "deep": {
      "name": "Interior Deep Clean",
      "blurb": "Top-to-bottom interior cleaning for built-up dirt, stains and odor.",
      "includes": [
        "Deep vacuum including seams and vents",
        "Seat and carpet shampoo",
        "Steam clean of trim and cupholders",
        "Leather cleaned and conditioned",
        "Interior windows"
      ],
      "duration": "2.5 to 3.5 hours",
      "popular": false,
      "prices": {
        "sedan": 150,
        "suv": 175,
        "large": 200
      }
    },
    "full": {
      "name": "Full Detail",
      "blurb": "Inside and out, top to bottom. Our most booked service.",
      "includes": [
        "Exterior hand wash and wheels",
        "Full interior deep clean",
        "Spray wax or sealant",
        "Windows inside and out",
        "Tire dressing"
      ],
      "duration": "3.5 to 4.5 hours",
      "popular": true,
      "prices": {
        "sedan": 175,
        "suv": 205,
        "large": 235
      }
    },
    "premium": {
      "name": "Premium Full Detail",
      "blurb": "The most thorough service, with paint decontamination and longer-lasting protection.",
      "includes": [
        "Everything in Full Detail",
        "Clay bar paint decontamination",
        "Hand-applied paint sealant",
        "Engine bay cleaned",
        "Headlight cleaning"
      ],
      "duration": "5 to 6.5 hours",
      "popular": false,
      "prices": {
        "sedan": 260,
        "suv": 295,
        "large": 335
      }
    }
  }
}$json$::jsonb
-- detailPricing:end
  )
end
where id = 1;
