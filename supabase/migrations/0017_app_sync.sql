-- App sync: several cars per booking, member pricing on the Bronze/Silver/Gold plans,
-- VIP bumping and prepaid-balance payments, each done atomically in one database function.
-- Apply to project fiaadogbkvjcddehnymj only (never eqblpbeqothkpyqiafzs), after the owner's go.
-- Safe to re-run: additive columns, replaceable functions, and the config merge never
-- overwrites an owner's edits. Function rollback: scripts/rollback-0017.sql.
-- Spec: docs/superpowers/specs/2026-11-11-bld-app-sync-design.md ("Corrections" section).

-- ——— the member's plan vehicle size: included visits cover cars up to this size ———
alter table memberships add column if not exists vehicle_type text not null default 'sedan'
  check (vehicle_type in ('sedan', 'suv', 'large'));

-- ——— per-car invoices ———
-- lines: [{price, covered, credit?}] (see invoiceTotalsLines in _shared/detail_pricing.ts).
-- An empty list = an invoice saved by the single-price editor: one uncovered line at service_price.
alter table booking_invoices add column if not exists lines jsonb not null default '[]'::jsonb;
alter table booking_invoices add column if not exists member_percent int not null default 0
  check (member_percent between 0 and 50);
-- the percent25 reward the booking's quote used (25, else 0); applied before the member %
alter table booking_invoices add column if not exists reward_percent int not null default 0
  check (reward_percent between 0 and 100);

-- ——— balance as a payment method. The old checks are found by what they check, not by
-- name, so a differently named constraint on the live table can't survive and block 'balance'. ———
do $$
declare c record;
begin
  for c in select conrelid::regclass as tbl, conname from pg_constraint
    where contype = 'c' and (
      (conrelid = 'booking_invoices'::regclass and pg_get_constraintdef(oid) like '%paid_method%')
      or (conrelid = 'bookings'::regclass and pg_get_constraintdef(oid) like '%remainder_method%'))
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;
alter table booking_invoices add constraint booking_invoices_paid_method_check
  check (paid_method in ('cash', 'card', 'balance'));
-- detail_invoice_pay copies the method to bookings.remainder_method
alter table bookings add constraint bookings_remainder_method_check
  check (remainder_method in ('cash', 'card', 'balance'));

-- ——— reserve: VIP bump or escalate, insert, and balance-paid deposit in one transaction ———
-- p_row: the new booking as bookings columns (flow must be 'detail_v2'); columns it leaves
-- out take their defaults. p_rank: the booker's plan rank (0 = guest). p_wallet_debit: the
-- deposit to take from the prepaid balance (0 = the normal demo-deposit step).
-- Holder rules (= decideBump in _shared/bump.ts, plus the owner's rule that only bookings he
-- hasn't confirmed can move): anchored, or not pending_payment|requested -> slot_taken;
-- higher rank -> the holder moves to the first free slot after this one that day (or loses
-- its time, needs a new one); same rank above 0 -> this booking is saved with no time
-- (escalated, the owner confirms one); otherwise slot_taken.
-- p_visit_cap: the plan's included visits per service ({"exterior": 2, ...}); p_period_start:
-- the start of the member's billing month (00:00 Eastern). Both only matter for a member row.
-- Errors: bad_row, bad_debit, slot_taken, insufficient_balance, price_changed (the issued
-- reward the quote used is gone, or another booking used the included visits this quote
-- counted on), plus the capacity trigger's day_full, day_closed, too_many.
drop function if exists detail_reserve(jsonb, int, int); -- the first draft's signature
create or replace function detail_reserve(p_row jsonb, p_rank int, p_wallet_debit int,
  p_visit_cap jsonb default null, p_period_start timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_day date := (p_row->>'preferred_day')::date;
  v_slot text := p_row->>'time_slot';
  v_rank int := coalesce(p_rank, 0);
  v_debit int := coalesce(p_wallet_debit, 0);
  v_member uuid := nullif(p_row->>'membership_id', '')::uuid;
  v_new jsonb := case when jsonb_typeof(p_row #> '{quote,visitsUsed}') = 'object' then p_row #> '{quote,visitsUsed}' else '{}' end;
  h record;
  v_holders int;
  v_cols text;
  v_id uuid;
  v_escalated boolean := false;
  v_bumped uuid;
  v_moved text;
  v_reward uuid;
begin
  if p_row->>'flow' is distinct from 'detail_v2' or v_day is null or p_row->>'customer_id' is null then
    raise exception 'bad_row';
  end if;
  if v_debit < 0 then raise exception 'bad_debit'; end if;

  -- Same key as the enforce_detail_capacity trigger (0015), and re-entrant in one transaction:
  -- every detail_v2 insert and every move on this day runs one at a time, so the unique slot
  -- index can't fire halfway through a move.
  perform pg_advisory_xact_lock(hashtext('detail-day:' || v_day::text));

  -- Included visits: one member's bookings run one at a time (lock order: day, then member),
  -- and the visits this quote uses are recounted against the plan here, so two bookings at
  -- once can't both spend the last visit. A service missing from the cap has 0 included; a
  -- missing period start counts every booking (fails closed).
  if v_member is not null then
    perform pg_advisory_xact_lock(hashtext('detail-member:' || v_member::text));
    if exists (
      select 1 from jsonb_each(v_new) n
      where jsonb_typeof(n.value) = 'number' and n.value::int > 0
        and n.value::int + coalesce((
          select sum((b.quote #>> array['visitsUsed', n.key])::int) from bookings b
          where b.membership_id = v_member
            and b.status in ('pending_payment', 'requested', 'confirmed', 'done')
            and b.created_at >= coalesce(p_period_start, '-infinity'::timestamptz)
            and jsonb_typeof(b.quote #> array['visitsUsed', n.key]) = 'number'), 0)
          > coalesce((p_visit_cap->>n.key)::int, 0)
    ) then
      raise exception 'price_changed';
    end if;
  end if;

  if v_slot is not null then
    select count(*) into v_holders from bookings
      where preferred_day = v_day and time_slot = v_slot and status not in ('declined', 'refunded');
    select b.id, b.status, b.anchored, b.rank into h from bookings b
      where b.preferred_day = v_day and b.time_slot = v_slot and b.status not in ('declined', 'refunded')
      order by b.anchored desc, b.rank desc limit 1
      for update;
    if found then
      if v_holders > 1 or h.anchored or h.status not in ('pending_payment', 'requested') then
        raise exception 'slot_taken';
      elsif v_rank > h.rank then
        -- the slots must match ALL_SLOTS in _shared/bump.ts ('09:00' .. '17:00', hourly)
        select s into v_moved
          from (select lpad(g::text, 2, '0') || ':00' as s from generate_series(9, 17) g) a
          where s > v_slot and s not in (select t from booked_slots(v_day) t)
          order by s limit 1;
        update bookings set
          time_slot = v_moved,
          time_window = case when v_moved is null then time_window
                             when v_moved < '12:00' then 'morning' else 'afternoon' end,
          bumped_from = v_slot,
          detail = (coalesce(detail, '{}'::jsonb) - 'bumpNotified') -- a new move needs its own notice
            || jsonb_build_object('bumpedFrom', v_slot, 'bumpedAt', now(), 'bumpedBy', p_row->>'id')
          where id = h.id;
        v_bumped := h.id;
      elsif v_rank = h.rank and v_rank > 0 then
        v_escalated := true;
        p_row := p_row || '{"time_slot": null}'::jsonb;
      else
        raise exception 'slot_taken';
      end if;
    end if;
  end if;

  -- insert only the columns p_row names, so every other column keeps its default
  select string_agg(quote_ident(k), ', ') into v_cols from jsonb_object_keys(p_row) k;
  execute format('insert into bookings (%1$s) select %1$s from jsonb_populate_record(null::bookings, $1) returning id', v_cols)
    using p_row into v_id;

  if v_debit > 0 then
    begin
      insert into wallet_ledger (customer_id, delta, reason, booking_id)
        values ((p_row->>'customer_id')::uuid, -v_debit, 'deposit', v_id);
    exception when raise_exception then
      raise exception 'insufficient_balance'; -- the wallet's non-negative trigger (0012)
    end;
    -- the deposit step is complete, so the reward the quote used is spent now (never at a
    -- demo hold); if it was spent elsewhere meanwhile the price no longer holds
    v_reward := nullif(p_row #>> '{quote,rewardId}', '')::uuid;
    if v_reward is not null then
      update redemptions set status = 'applied', booking_id = v_id
        where id = v_reward and status = 'issued' and membership_id = (p_row->>'membership_id')::uuid;
      if not found then raise exception 'price_changed'; end if;
    end if;
    update bookings set deposit_status = 'paid', status = 'requested',
      quote = quote || jsonb_build_object('paidOnline', v_debit,
        'balanceDue', coalesce((quote->>'payable')::int, (quote->>'total')::int, 0) - v_debit,
        'remainder', coalesce((quote->>'payable')::int, (quote->>'total')::int, 0) - v_debit)
      where id = v_id;
  end if;

  return jsonb_build_object('bookingId', v_id, 'escalated', v_escalated, 'bumpedId', v_bumped, 'movedTo', v_moved);
end $$;
revoke all on function detail_reserve(jsonb, int, int, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function detail_reserve(jsonb, int, int, jsonb, timestamptz) to service_role;

-- ——— demo deposit step: claim the quote's reward and flip to requested in one transaction ———
-- The caller (detail pay-demo) checks app_config.payments_mode = 'demo' first.
-- Errors: not_found (no such detail_v2 booking, or wrong payKey), not_pending, price_changed
-- (the reward the quote used was spent elsewhere; the booking stays pending_payment).
-- Returns bumped: the bookings a VIP bump by this one moved and nobody has told yet. They are
-- marked detail.bumpNotified here, in the same transaction, and detail pay-demo emails them.
create or replace function detail_pay_demo(p_booking uuid, p_paykey text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b bookings%rowtype; v_reward uuid; v_bumped jsonb;
begin
  select * into b from bookings where id = p_booking and flow = 'detail_v2' for update;
  if not found or p_paykey is null or p_paykey = '' or b.detail->>'payKey' is distinct from p_paykey then
    raise exception 'not_found';
  end if;
  if b.status <> 'pending_payment' then raise exception 'not_pending'; end if;
  v_reward := nullif(b.quote->>'rewardId', '')::uuid;
  if v_reward is not null then
    update redemptions set status = 'applied', booking_id = b.id
      where id = v_reward and status = 'issued' and membership_id = b.membership_id;
    if not found then raise exception 'price_changed'; end if;
  end if;
  update bookings set status = 'requested', deposit_status = 'demo' where id = b.id;
  with m as (
    update bookings set detail = detail || '{"bumpNotified": true}'::jsonb
      where detail->>'bumpedBy' = b.id::text and status not in ('declined', 'refunded')
        and not (detail ? 'bumpNotified')
      returning id)
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_bumped from m;
  return jsonb_build_object('ok', true, 'bumped', v_bumped);
end $$;
revoke all on function detail_pay_demo(uuid, text) from public, anon, authenticated;
grant execute on function detail_pay_demo(uuid, text) to service_role;

-- ——— undo a VIP bump whose deposit step never finished ———
-- A VIP hold moves the holder at reserve time. If that hold is then released or expires
-- (p_booking declined/refunded), each booking it moved that the owner hasn't confirmed
-- (pending_payment|requested, same day) goes back to its old time if that time is free, and
-- loses the bump marks. One whose old time is taken by now keeps the time it was moved to.
-- Same day lock as detail_reserve, so nothing can take the old time halfway through.
-- Returns the number restored (0 when p_booking is still live). Service role only.
create or replace function detail_unbump(p_booking uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_day date; h record; v_n int := 0;
begin
  select preferred_day into v_day from bookings where id = p_booking;
  if v_day is null then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('detail-day:' || v_day::text));
  if not exists (select 1 from bookings where id = p_booking and status in ('declined', 'refunded')) then
    return 0;
  end if;
  for h in select b.id, b.detail->>'bumpedFrom' as slot from bookings b
      where b.detail->>'bumpedBy' = p_booking::text and b.preferred_day = v_day
        and b.status in ('pending_payment', 'requested')
      for update of b
  loop
    -- = booked_slots(v_day) without h itself (every flow, like the unique slot check)
    if h.slot is not null and not exists (
        select 1 from bookings o where o.preferred_day = v_day and o.time_slot = h.slot and o.id <> h.id
          and o.status not in ('declined', 'refunded')) then
      update bookings set time_slot = h.slot,
          time_window = case when h.slot < '12:00' then 'morning' else 'afternoon' end,
          bumped_from = null,
          detail = detail - 'bumpedFrom' - 'bumpedAt' - 'bumpedBy' - 'bumpNotified'
        where id = h.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;
revoke all on function detail_unbump(uuid) from public, anon, authenticated;
grant execute on function detail_unbump(uuid) to service_role;

-- ——— mark an invoice paid (replaces 0015's): one line per car, member % off, and balance
-- as a payment method. One transaction, row-locked, as before. The deposit counts as credit
-- ONLY when it was really paid (deposit_status = 'paid'). p_stamps: the member's stamps for
-- this job (cars x stampsPerCar, computed by admin), recorded in the same transaction, once
-- per booking. Returns stamps = the stamps recorded now (0 if none or already given).
-- Service role only. ———
drop function if exists detail_invoice_pay(uuid, text); -- 0015's signature
create or replace function detail_invoice_pay(p_booking uuid, p_method text, p_stamps int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b bookings%rowtype; inv booking_invoices%rowtype;
  v_lines jsonb; v_gross int; v_extras int; v_total int; v_deposit int; v_credit int; v_balance int;
  v_stamps int := 0;
begin
  if p_method is null or p_method not in ('cash', 'card', 'balance') then raise exception 'bad_method'; end if;
  if coalesce(p_stamps, 0) < 0 then raise exception 'bad_stamps'; end if;
  select * into b from bookings where id = p_booking and flow = 'detail_v2' for update;
  if not found then raise exception 'not_found'; end if;
  if b.status not in ('confirmed', 'done') then raise exception 'not_open'; end if;
  select * into inv from booking_invoices where booking_id = p_booking for update;
  if found and inv.status = 'paid' then raise exception 'already_paid'; end if;
  if not found then
    -- paid without editing: one line per car from the booking's quote (covered/credit as
    -- memberQuote set them), or one line at the starting price for an older single-car quote
    if jsonb_typeof(b.quote->'lines') = 'array' and jsonb_array_length(b.quote->'lines') > 0 then
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'price', coalesce((l->>'startingPrice')::int, 0),
          'covered', coalesce((l->>'covered')::boolean, false),
          'credit', (l->>'credit')::int)) order by n)
        into v_lines from jsonb_array_elements(b.quote->'lines') with ordinality as x(l, n);
    else
      v_lines := jsonb_build_array(jsonb_build_object(
        'price', coalesce((b.quote->>'startingPrice')::int, (b.quote->>'total')::int, 0), 'covered', false));
    end if;
    insert into booking_invoices (booking_id, service_price, lines, member_percent, reward_percent)
    values (p_booking, 0, v_lines, coalesce((b.quote->>'memberPercent')::int, 0), coalesce((b.quote->>'rewardPercent')::int, 0))
    on conflict (booking_id) do nothing
    returning * into inv;
    if inv.booking_id is null then -- an invoice_save inserted one first: pay that one
      select * into inv from booking_invoices where booking_id = p_booking for update;
      if inv.status = 'paid' then raise exception 'already_paid'; end if;
    end if;
  end if;

  v_lines := case when jsonb_typeof(inv.lines) = 'array' then
      case when jsonb_array_length(inv.lines) > 0 then inv.lines end end;
  if v_lines is null then
    v_lines := jsonb_build_array(jsonb_build_object('price', inv.service_price, 'covered', false));
  end if;
  -- = invoiceTotalsLines in _shared/detail_pricing.ts: a line pays covered ? 0 : max(0, price - credit);
  -- cars + extras, then the reward % and the member % off together, rounded once, half up
  select coalesce(sum(case when coalesce((l->>'covered')::boolean, false) then 0
      else greatest(0, coalesce((l->>'price')::int, 0) - coalesce((l->>'credit')::int, 0)) end), 0)::int
    into v_gross from jsonb_array_elements(v_lines) l;
  select coalesce(sum((e->>'price')::int), 0)::int into v_extras from jsonb_array_elements(inv.extras) e;
  v_total := round((v_gross + v_extras)::numeric * (100 - inv.reward_percent) * (100 - inv.member_percent) / 10000)::int;
  v_deposit := case when b.deposit_status = 'paid' then coalesce((b.quote->>'deposit')::int, 0) else 0 end;
  v_credit := least(v_deposit, v_total);
  v_balance := v_total - v_credit;

  -- Only a booking made with the customer's own member/account code may spend their balance:
  -- a guest can type anyone's email, which lands the booking on that customer's row.
  if p_method = 'balance' and coalesce((b.detail->>'viaCode')::boolean, false) is not true then
    raise exception 'balance_not_allowed';
  end if;
  if p_method = 'balance' and v_balance > 0 then
    begin
      insert into wallet_ledger (customer_id, delta, reason, booking_id)
        values (b.customer_id, -v_balance, 'job payment', p_booking);
    exception when raise_exception then
      raise exception 'insufficient_balance'; -- the wallet's non-negative trigger (0012)
    end;
  end if;

  -- service_price = the cars' part before the % off (display only once lines exist)
  update booking_invoices set status = 'paid', paid_at = now(), paid_method = p_method, lines = v_lines,
    service_price = v_gross, deposit_credit = v_credit, total = v_total, balance = v_balance
    where booking_id = p_booking;
  if v_balance > 0 then
    insert into payments (booking_id, kind, amount_cents, status, provider)
    values (p_booking, 'remainder', v_balance * 100, 'succeeded',
            case p_method when 'cash' then 'cash' when 'card' then 'card_in_person' else 'balance' end);
  end if;
  update bookings set status = 'done', remainder_method = p_method, -- paid = the job is done
    quote = b.quote || jsonb_build_object('total', v_total, 'balanceDue', v_balance, 'remainder', v_balance)
    where id = p_booking;
  -- A deposit taken from the prepaid balance that is more than the final bill goes back onto the
  -- balance here, in the same transaction (a card/cash deposit refund stays the owner's job).
  if v_deposit - v_credit > 0 and exists (
      select 1 from wallet_ledger where booking_id = p_booking and reason = 'deposit' and delta < 0) then
    insert into wallet_ledger (customer_id, delta, reason, booking_id)
      values (b.customer_id, v_deposit - v_credit, 'deposit refund', p_booking);
  end if;
  -- paid = job done: the member's stamps, unless this booking already got them (markDone)
  if b.membership_id is not null and coalesce(p_stamps, 0) > 0 and not exists (
      select 1 from reward_ledger where booking_id = p_booking and reason = 'wash completed') then
    insert into reward_ledger (membership_id, delta, reason, booking_id)
      values (b.membership_id, p_stamps, 'wash completed', p_booking);
    v_stamps := p_stamps;
  end if;
  return jsonb_build_object('total', v_total, 'credit', v_credit, 'balance', v_balance, 'refundDue', v_deposit - v_credit,
    'stamps', v_stamps);
end $$;
revoke all on function detail_invoice_pay(uuid, text, int) from public, anon, authenticated;
grant execute on function detail_invoice_pay(uuid, text, int) to service_role;

-- One stamp grant per finished job, whichever path (invoice pay or the old markDone) gets there
-- first; a racing second insert fails instead of double-stamping. (reward_ledger had 0 rows when
-- this was written, so no existing duplicates can block it.)
create unique index if not exists reward_ledger_wash_once
  on reward_ledger (booking_id) where reason = 'wash completed';

-- ——— plan numbers: rank, stamps per car, top-up bonus, % off. Adds only the keys a tier is
-- missing (the saved tier object is on the right of ||, so the owner's edits win). A config
-- with no detailPricing at all gets the whole default. The JSON between the markers must
-- equal DEFAULT_DETAIL_PRICING (a Jest test checks the newest migration that has markers). ———
update catalog c
set config = case
  when not (c.config ? 'detailPricing') then c.config || jsonb_build_object('detailPricing', d.v)
  when jsonb_typeof(c.config #> '{detailPricing,membership}') is distinct from 'object' then c.config
  else jsonb_set(c.config, '{detailPricing,membership}', coalesce((
    select jsonb_object_agg(e.key, case
      when jsonb_typeof(e.value) = 'object' and jsonb_typeof(d.v #> array['membership', e.key]) = 'object' then
        (select coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb)
           from jsonb_each(d.v #> array['membership', e.key]) f
           where f.key in ('rank', 'stampsPerCar', 'topupBonusPercent', 'discountPercent')) || e.value
      else e.value end)
    from jsonb_each(c.config #> '{detailPricing,membership}') e), '{}'::jsonb))
end
from (select
-- detailPricing:begin
$json$
{
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
  },
  "membership": {
    "bronze": {
      "name": "Bronze",
      "tagline": "Keep it clean between details.",
      "visits": {
        "exterior": 2
      },
      "perks": [
        "Priority booking over non-members",
        "10% off any other service",
        "Cancel anytime"
      ],
      "prices": {
        "sedan": 65,
        "suv": 80,
        "large": 95
      },
      "rank": 1,
      "stampsPerCar": 1,
      "topupBonusPercent": 5,
      "discountPercent": 10
    },
    "silver": {
      "name": "Silver",
      "tagline": "Clean inside and out, every month.",
      "visits": {
        "exterior": 2,
        "refresh": 1
      },
      "perks": [
        "Priority booking ahead of Bronze",
        "15% off any other service",
        "Cancel anytime"
      ],
      "prices": {
        "sedan": 125,
        "suv": 150,
        "large": 180
      },
      "rank": 2,
      "stampsPerCar": 2,
      "topupBonusPercent": 10,
      "discountPercent": 15
    },
    "gold": {
      "name": "Gold",
      "tagline": "A full detail every month, with washes in between.",
      "visits": {
        "full": 1,
        "exterior": 2
      },
      "perks": [
        "First priority booking",
        "20% off any other service",
        "Cancel anytime"
      ],
      "prices": {
        "sedan": 190,
        "suv": 230,
        "large": 265
      },
      "rank": 3,
      "stampsPerCar": 3,
      "topupBonusPercent": 15,
      "discountPercent": 20
    }
  }
}
$json$::jsonb
-- detailPricing:end
  as v) d
where c.id = 1;

-- ——— saved cars: 'truck' now reads as 'suv' (SUV / Truck) ———
update customers set cars = (
  select jsonb_agg(case when e->>'size' = 'truck' then jsonb_set(e, '{size}', '"suv"') else e end order by n)
  from jsonb_array_elements(cars) with ordinality as x(e, n))
where jsonb_typeof(cars) = 'array' and cars @> '[{"size": "truck"}]';
