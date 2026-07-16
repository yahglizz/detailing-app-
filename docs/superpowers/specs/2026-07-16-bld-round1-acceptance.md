# Round 1 Acceptance — Owner Checklist

**No SMS anywhere.** Login codes and every booking notification go by email.
Twilio was removed on 2026-07-16; there is no phone number in the system.

## Already verified automatically (production stack, email flow)

- 14/14 unit tests pass (pricing math, fake payments, order state, price bar)
- 13/13 end-to-end checks on the live Supabase project: book → $54 deposit
  charged (fake card) → owner confirm page → confirm with time / decline with
  auto-refund → correct final statuses and payment ledger rows
- Declined card (…0002) returns 402, no money row is ever written
- Price tampering returns the real price BEFORE charging (409)
- Anonymous booking attempt returns 401
- Sweep policy: 24h-old request → owner reminder once; 48h → auto-refund
- Hourly sweep cron scheduled in Postgres (pg_cron + vault)
- Customer flow walked in a browser: Home → Build (live prices) → Schedule → Pay

## Do these on your own phone before store submission

1. Open the app in Expo Go (`cd bld-app && npx expo start`, scan the QR).
2. Book a fake detail with card `4242 4242 4242 4242`.
3. Check your inbox — you get the job details + a confirm link.
4. Open the link, type a time, hit Confirm — the customer gets a confirmation email.
5. Book another and hit Decline & refund — customer gets the refund email.
6. Try card `4000 0000 0000 0002` — must decline, nothing booked.

## Manual setup still required (owner)

- **Resend account** (free, 3k emails/mo) — then set function secrets:
  - `RESEND_API_KEY` — your Resend key
  - `OWNER_EMAIL` — where new-booking alerts land
  - `MAIL_FROM` — e.g. `Brotherly Love Detailing <book@yourdomain.com>`
    (needs domain verification in Resend; until then Resend's test sender works)
  - `PUBLIC_FUNCTIONS_URL` — `https://fiaadogbkvjcddehnymj.supabase.co/functions/v1`

  Until `RESEND_API_KEY` is set, emails print to the function logs (dry-run) and
  everything else still works.
- **Login emails**: Supabase sends the 6-digit codes built-in, but its default
  sender is rate-limited. Point Supabase Auth → SMTP at Resend for production.
- **Payment processor**: pick Stripe (recommended) or Square. The swap lives in
  ONE file: `supabase/functions/_shared/payments/provider.ts`.
- **Final numbers** (SQL update to `catalog.config`, no app release needed):
  deposit %, SUV/truck multipliers, service and extra prices.
- **Store accounts**: Apple Developer ($99/yr) + Google Play ($25 once), then
  `eas build` + submit.

## Note on the owner alert

Email is easier to miss than a text. Turn on a phone notification for the
address you set as `OWNER_EMAIL`, or you'll leave deposits sitting — the sweep
auto-refunds anything you ignore for 48 hours.
