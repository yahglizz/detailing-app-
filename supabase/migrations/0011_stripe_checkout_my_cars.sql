-- 0011_stripe_checkout_my_cars.sql
-- Real booking payments through Stripe Checkout, plus member settings (saved address
-- and cars) that the app autofills at checkout.

-- Member settings, edited in the app's Settings screen.
alter table customers add column if not exists address text not null default '';
alter table customers add column if not exists cars jsonb not null default '[]'::jsonb;

-- While the customer is on Stripe's hosted checkout page the booking waits in
-- pending_payment, holding its slot. The session id links the two (one per booking).
alter table bookings add column if not exists stripe_session_id text;
create unique index if not exists bookings_stripe_session_uniq
  on bookings (stripe_session_id) where stripe_session_id is not null;

-- The customer picks: 25% deposit now (rest at the detail) or everything now.
alter table bookings add column if not exists pay_mode text not null default 'deposit'
  check (pay_mode in ('deposit', 'full'));

alter table payments drop constraint if exists payments_kind_check;
alter table payments add constraint payments_kind_check
  check (kind in ('deposit', 'full', 'remainder', 'refund'));

-- One row per Stripe object (payment intent or refund). The webhook and the app's
-- return can both report the same payment; this records it once.
create unique index if not exists payments_stripe_ref_uniq
  on payments (provider_ref) where provider = 'stripe';

-- Stripe secret key for booking payments, and the signing secret of the TEST-mode
-- webhook endpoint (the live one stays in stripe_webhook_secret). Service-role-only
-- like the other app_config rows; seeded empty and filled in from the dashboard:
--   update app_config set value = 'sk_test_...', updated_at = now() where key = 'stripe_secret_key';
-- An empty key means online payments are off: book answers payments_not_configured.
insert into app_config (key, value) values ('stripe_secret_key', ''), ('stripe_webhook_secret_test', '')
  on conflict (key) do nothing;
