-- Applied to project fiaadogbkvjcddehnymj on 2026-07-16 via MCP apply_migration
-- "customers_email_identity".
--
-- Twilio/SMS removed entirely. Customer identity moves from phone number to
-- email: login is a 6-digit code to the inbox (Supabase email OTP), and all
-- booking notifications go out as email via Resend.
alter table customers drop constraint customers_phone_key;
alter table customers rename column phone to email;
alter table customers add constraint customers_email_key unique (email);
