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
| `assets/`, `uploads/` | Logos, hero video, image exports |

## The booking flow

Customer taps **GET MY DETAIL** → picks cars, sizes (sedan/SUV/truck), and
service (outside/inside/full) with extras → live price updates at the bottom →
picks a day + morning/afternoon window and address → pays a percentage deposit
by card → the owner gets an email with a confirm link and sets the exact time.
The rest is paid cash or card at the job.

Requests the owner ignores get a reminder at 24 hours and auto-refund at 48.

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
- **Becoming a member:** the owner issues codes from a signed link — no self-serve
  purchase yet (that's Round 3, when Stripe lands). Open
  `…/functions/v1/owner-members?token=<OWNER_ADMIN_TOKEN>` to add a member (name +
  email + tier → a code is generated and emailed), change tier, deactivate, grant
  stamps, and mark jobs done (which grants stamps). The token lives in the
  `app_config` table (`key = 'owner_admin_token'`); rotate it with
  `update app_config set value = encode(gen_random_bytes(24),'hex') where key='owner_admin_token';`
- **Credits & stamps** live in append-only ledgers with no-negative-balance
  triggers; a declined or auto-refunded member booking gives the credit/reward
  back. `sweep` grants each active membership its monthly credits.

Verified end-to-end against the live project by `scripts/e2e-member.mjs`.

## Status

**Round 1 and Round 2 (memberships) are both built and verified end-to-end.**
Round 3 — self-serve membership purchase and auto-renew billing — waits on the
payment-processor decision.

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
