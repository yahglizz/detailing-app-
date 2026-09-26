# Brotherly Love Detailing

Mobile car detailing in Philadelphia — marketing site + booking app.

## What's in here

| Path | What it is |
|---|---|
| `bld-app/` | The customer app (Expo / React Native — iPhone + Android, one codebase) |
| `supabase/` | Backend: database migrations + edge functions |
| `docs/superpowers/specs/` | Design spec and the owner acceptance checklist |
| `docs/superpowers/plans/` | Implementation plan |
| `Brotherly Love Detailing.dc.html` | The marketing website |
| `admin/` | The owner & management dashboard (static page; talks to the `admin` function) |
| `assets/`, `uploads/` | Logos, hero video, image exports |

## The booking flow

Customer taps **GET MY DETAIL** → picks cars, sizes (sedan/SUV/truck), and
service (outside/inside/full) with extras → live price updates at the bottom →
picks a day + morning/afternoon window and address → pays a percentage deposit
by card → the owner gets an email that opens the booking in the dashboard, where
they set the exact time.
The rest is paid cash or card at the job.

Requests the owner ignores get a reminder at 24 hours and auto-refund at 48.

## Owner dashboard

**https://brotherly-love-detailing.vercel.app/admin** (the website is at `/` on the same
Vercel project, `brotherly-love-detailing`; deploy with `vercel deploy --prod` from the repo root).

- **Bookings:** today's cars, what's awaiting a time, money still due at jobs; confirm or
  move a time (customer is emailed), mark done and record the cash/card collected
  (members get their stamps), cancel & refund (owner only).
- **Calendar:** cars per day, closed weekdays, and per-date changes (close a day, change
  its cap, add a staff note). The app greys out closed/full days and `book` refuses them.
- **Customers:** profile, balance, cars, history, and **private reports** (note, damage,
  complaint, no-show, payment) with photos. Only staff ever see these.
- **Leads:** every instant quote and quote request from the website.
- **Owner only:** Members, Pricing (edits flow to the app, the website and Stripe at once),
  and Settings (team codes, Stripe).
- **Signing in:** each person has a personal staff code (Settings → Team; shown once).
  The owner's first sign-in uses the owner key:
  `select value from app_config where key='owner_admin_token';` — then add yourself a
  personal code and use that. Managers can't touch prices, refunds, members, team or Stripe.
- **Stripe:** Settings → Stripe payments → *Finish setup* (or paste a secret key) registers
  the webhook, makes each tier's product/price/join link, and turns on the Billing Portal
  so members upgrade, downgrade, update cards and cancel themselves in the app.
- Old `confirm` / `owner-members` links now redirect to the dashboard (Supabase serves
  HTML from functions as plain text, so those pages never rendered in a browser).

Verified live by `scripts/e2e-admin.mjs`.

## Membership mode (Round 2)

Members get a **code**, not a login. On the app Home screen they tap "Brotherhood
member? Enter your code," type it once, and their dashboard opens on every launch
after: washes left this month, dollars saved since joining, a stamp punch-card
with redeemable rewards, plan + upgrade, book-with-credit, and history.

- **Plans** (example prices, all in `catalog.config.plans` — change with SQL):
  Bronze $79/mo = 2 outside · Silver $99/mo = 2 inside · Gold $199/mo = 2 full.
- **Rewards:** 1 stamp per completed wash → 3 free tire shine · 5 interior
  mini-spray · 8 = 25% off · 10 = free wash (costs in `catalog.config.rewards`).
- **Priority booking:** members book 30 days out (non-members 7). Everyone sees
  all slots. A higher-tier member booking a slot a lower-tier/non-member holds
  **bumps** them to the next open time that day (auto-email explains why); equal
  tiers **escalate** to the owner to resolve. Anchored slots are never bumped.
- **$10 Slot Anchor:** a non-member checkout add-on that makes their time
  bump-proof (price in `catalog.config.anchorPrice`).
- **Becoming a member (self-serve, Round 3):** customers buy a tier themselves via a
  Stripe Payment Link (one per tier); a signed Stripe webhook auto-issues the code, first
  credits, and welcome email. See [`docs/STRIPE-SELFSERVE.md`](docs/STRIPE-SELFSERVE.md) —
  **one manual step (set the webhook signing secret) is required before it fulfills.**
- **Owner-issued codes (still available):** Dashboard → Members → *Add a member by hand*
  (name + email + tier → a code is generated and emailed); change tier, deactivate, and
  grant stamps there too. The owner key lives in `app_config` (`key = 'owner_admin_token'`);
  rotate it with
  `update app_config set value = encode(gen_random_bytes(24),'hex') where key='owner_admin_token';`
- **Credits & stamps** live in append-only ledgers with no-negative-balance
  triggers; a declined or auto-refunded member booking gives the credit/reward
  back. `sweep` grants each active membership its monthly credits.

Verified end-to-end against the live project by `scripts/e2e-member.mjs`.

## Status

**Rounds 1, 2, and 3 are built and verified end-to-end.** Round 3 (self-serve Stripe
membership purchase + webhook fulfillment) is live on the `client forge` Stripe account
and needs one manual step to go — set the webhook signing secret
([`docs/STRIPE-SELFSERVE.md`](docs/STRIPE-SELFSERVE.md)). Booking-deposit card capture
still runs on the fake provider (separate migration).

## Before real customers

See [the acceptance checklist](docs/superpowers/specs/2026-07-16-bld-round1-acceptance.md).
Short version:

1. **Payment processor** — Stripe recommended. Swap lives in exactly one file:
   `supabase/functions/_shared/payments/provider.ts`. Everything today runs on a
   fake provider so the whole flow is testable without real money.
2. **Resend account** (free) for email — set `RESEND_API_KEY`, `OWNER_EMAIL`,
   `MAIL_FROM`, `PUBLIC_FUNCTIONS_URL` as Supabase function secrets. Without the
   key, emails log instead of send and everything else still works.
3. **Final prices** — services, extras, **and membership plans/rewards/anchor**
   all live in the `catalog` table, not in code. Change them with one SQL update
   and both the app and the marketing website pick it up immediately — no
   app-store release, no HTML edit. (The website reads the catalog live via the
   public anon key; static numbers in the HTML are only a fetch-failure fallback.)
4. **Store accounts** — Apple Developer ($99/yr), Google Play ($25 once).

## Running it

```bash
cd bld-app
npm install
npx expo start     # scan the QR with Expo Go
npx jest           # unit tests
npx tsc --noEmit   # typecheck
```

`bld-app/.env` holds the Supabase URL and anon key. It is **not** committed —
copy it from the Supabase dashboard (Project Settings → API).

## Notes

- No SMS anywhere. Login is a 6-digit code by email; all notifications are email.
- Prices are computed server-side and frozen onto each booking, so changing the
  catalog later never rewrites what someone was already quoted.
- This project uses its own Supabase project (`brotherly-love-detailing`),
  completely separate from any other business database.
