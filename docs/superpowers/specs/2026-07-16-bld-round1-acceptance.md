# Round 1 Acceptance — Owner Checklist

## Already verified automatically (2026-07-16, production stack)

- 14/14 unit tests pass (pricing math, fake payments, order state, price bar)
- Full E2E on the live Supabase project: book → $54 deposit charged (fake card) →
  owner confirm page → confirm with time / decline with auto-refund → correct
  final statuses and payment ledger rows
- Declined card (…0002) returns "card declined," no money row is ever written
- Price tampering returns the real price BEFORE charging (409)
- Sweep policy: 24h-old request → owner reminder once; 48h → auto-refund
- Hourly sweep cron scheduled in Postgres (pg_cron + vault)
- Customer flow walked in a browser: Home → Build (live prices) → Schedule → Pay

## Do these on your own phone before store submission

1. Open the app in Expo Go (`cd bld-app && npx expo start`, scan the QR).
2. Book a fake detail with card `4242 4242 4242 4242`.
3. You should get a text within seconds with the job + a confirm link.
4. Tap the link, type a time, hit Confirm — the customer phone gets the confirmation text.
5. Book another and hit Decline & refund — customer gets the refund text.
6. Try card `4000 0000 0000 0002` — must decline, nothing booked.

## Manual setup still required (owner)

- **Twilio**: create account, then (a) enable Phone provider in Supabase Auth
  settings with the Twilio credentials (this turns on real login codes), and
  (b) set function secrets `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_FROM`, `OWNER_PHONE` so booking/confirm texts go out for real.
  Until then SMS prints to function logs (dry-run).
- **Payment processor**: pick Stripe (recommended) or Square. Swap lives in ONE
  file: `supabase/functions/_shared/payments/provider.ts`.
- **Final numbers** (SQL update to `catalog.config`, no app release needed):
  deposit %, SUV/truck multipliers, service and extra prices.
- **Store accounts**: Apple Developer ($99/yr) + Google Play ($25 once), then
  `eas build` + submit.
