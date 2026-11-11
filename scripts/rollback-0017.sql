-- Rolls back the functions migration 0017 added or replaced. Run only with the owner's go.
-- Restores detail_invoice_pay(uuid, text) exactly as migration 0015 wrote it (cash|card, one
-- service_price line, no member %, no stamps) and drops detail_reserve and detail_pay_demo.
-- The pre-0017 edge functions must be deployed with it (they call the 0015 signatures). The additive columns and widened checks from 0017
-- (memberships.vehicle_type, booking_invoices.lines/member_percent/reward_percent,
-- 'balance' as a method) stay:
-- they are harmless to the old code, and narrowing the checks would fail on any row already
-- paid by balance. The detailPricing plan keys and the truck->suv car fix also stay (the old
-- validator accepts the extra keys; 'suv' was always a valid saved-car size).

drop function if exists detail_reserve(jsonb, int, int, jsonb, timestamptz);
drop function if exists detail_reserve(jsonb, int, int); -- an early draft's signature
drop function if exists detail_pay_demo(uuid, text);
drop function if exists detail_invoice_pay(uuid, text, int);

-- ——— copied from 0015_detail_booking.sql ———
create or replace function detail_invoice_pay(p_booking uuid, p_method text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b bookings%rowtype; inv booking_invoices%rowtype;
  v_extras int; v_total int; v_deposit int; v_credit int; v_balance int;
begin
  if p_method not in ('cash', 'card') then raise exception 'bad_method'; end if;
  select * into b from bookings where id = p_booking and flow = 'detail_v2' for update;
  if not found then raise exception 'not_found'; end if;
  if b.status not in ('confirmed', 'done') then raise exception 'not_open'; end if;
  select * into inv from booking_invoices where booking_id = p_booking for update;
  if found and inv.status = 'paid' then raise exception 'already_paid'; end if;
  if not found then -- paid without editing the price: the invoice is the starting price
    insert into booking_invoices (booking_id, service_price)
    values (p_booking, coalesce((b.quote->>'startingPrice')::int, (b.quote->>'total')::int, 0))
    returning * into inv;
  end if;

  select coalesce(sum((e->>'price')::int), 0) into v_extras from jsonb_array_elements(inv.extras) e;
  v_total := inv.service_price + v_extras;
  v_deposit := case when b.deposit_status = 'paid' then coalesce((b.quote->>'deposit')::int, 0) else 0 end;
  v_credit := least(v_deposit, v_total);
  v_balance := v_total - v_credit;

  update booking_invoices set status = 'paid', paid_at = now(), paid_method = p_method,
    deposit_credit = v_credit, total = v_total, balance = v_balance where booking_id = p_booking;
  if v_balance > 0 then
    insert into payments (booking_id, kind, amount_cents, status, provider)
    values (p_booking, 'remainder', v_balance * 100, 'succeeded', case when p_method = 'cash' then 'cash' else 'card_in_person' end);
  end if;
  update bookings set status = 'done', remainder_method = p_method, -- paid = the job is done
    quote = b.quote || jsonb_build_object('total', v_total, 'balanceDue', v_balance, 'remainder', v_balance)
    where id = p_booking;
  return jsonb_build_object('total', v_total, 'credit', v_credit, 'balance', v_balance, 'refundDue', v_deposit - v_credit);
end $$;
revoke all on function detail_invoice_pay(uuid, text) from public, anon, authenticated;
grant execute on function detail_invoice_pay(uuid, text) to service_role;
