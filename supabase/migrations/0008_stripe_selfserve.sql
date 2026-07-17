-- 0008_stripe_selfserve.sql
-- Link Stripe subscriptions to memberships for self-serve purchase + cancel handling,
-- and add a service-role-only slot for the Stripe webhook signing secret.

-- A membership created from a Stripe checkout carries the Stripe customer + subscription.
alter table memberships add column if not exists stripe_customer_id text;
alter table memberships add column if not exists stripe_subscription_id text;

-- One membership per Stripe subscription. This is ALSO the webhook idempotency key:
-- a replayed checkout.session.completed cannot mint a second membership for the same sub.
create unique index if not exists memberships_stripe_sub_uniq
  on memberships (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- Edge functions in this project cannot take env secrets (no CLI/access token), so the
-- Stripe webhook signing secret lives in app_config (service-role-only, same as owner token).
-- Seeded empty; set the real whsec_... after creating the endpoint in the Stripe dashboard:
--   update app_config set value = '<whsec>' where key = 'stripe_webhook_secret';
insert into app_config (key, value) values ('stripe_webhook_secret', '')
  on conflict (key) do nothing;
