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

## Status

**Round 1 is built and verified end-to-end.** Round 2 (memberships) is designed
but not built — the credit tables and their no-negative-balance guard already
exist and are tested; only the UI and billing are pending.

## Before real customers

See [the acceptance checklist](docs/superpowers/specs/2026-07-16-bld-round1-acceptance.md).
Short version:

1. **Payment processor** — Stripe recommended. Swap lives in exactly one file:
   `supabase/functions/_shared/payments/provider.ts`. Everything today runs on a
   fake provider so the whole flow is testable without real money.
2. **Resend account** (free) for email — set `RESEND_API_KEY`, `OWNER_EMAIL`,
   `MAIL_FROM`, `PUBLIC_FUNCTIONS_URL` as Supabase function secrets. Without the
   key, emails log instead of send and everything else still works.
3. **Final prices** — they live in the `catalog` table, not in code. Change them
   with SQL; no app-store release needed.
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
