# Codex brief: Brotherly Love Detailing

You are joining an existing project. Read this, then read the files listed under "Read first" before you change anything.

## What it is
Brotherly Love Detailing is a mobile car detailing business serving Delaware and the Philadelphia area. The repo holds three things:
1. A customer booking app (Expo / React Native, iPhone and Android from one codebase).
2. A marketing website (one static HTML file).
3. A Supabase backend (database migrations and edge functions).

GitHub: https://github.com/yahglizz/detailing-app- (working branch: `bld-admin-dashboard`)

## Where the files are
- Working copy: `/Volumes/AgentDrive/claude/brotherly-love-detailing/`
- Older download copy (do not build here, the Mac disk is full): `~/Downloads/detailing-app--main/`
- Do all installs, builds, caches and temp files on `/Volumes/AgentDrive/claude/`. Run `ls /Volumes/AgentDrive` first. If it is not mounted, stop and tell the owner.

## Layout
| Path | What it is |
|---|---|
| `bld-app/` | Expo app. Start with `App.tsx`, `src/`, `app.json`. Tests in `__tests__/`. |
| `Brotherly Love Detailing.dc.html` | The marketing website. It reads the live catalog from Supabase with the public anon key. |
| `admin/` | Owner admin dashboard (branch `bld-admin-dashboard`). |
| `supabase/` | Migrations and edge functions. Payments swap lives in `supabase/functions/_shared/payments/provider.ts`. |
| `docs/` | Specs, plans, `STRIPE-SELFSERVE.md`, and the owner acceptance checklist under `docs/superpowers/specs/`. |
| `scripts/` | End-to-end checks, for example `scripts/e2e-member.mjs`. |
| `assets/`, `uploads/` | Logos, hero video, image exports. |

## Read first
1. `README.md` (full booking flow, membership rules, status).
2. `bld-app/AGENTS.md`: Expo SDK 57 has changed. Read https://docs.expo.dev/versions/v57.0.0/ before writing any app code.
3. `docs/superpowers/specs/` and `docs/superpowers/plans/`.
4. `docs/STRIPE-SELFSERVE.md`.

## Stack
Expo ~57, React Native 0.86, React 19.2, React Navigation 7, supabase-js 2, Jest and jest-expo, TypeScript 6.

## How it works
- Booking: customer picks cars, sizes (sedan/SUV/truck), service (outside/inside/full) and extras, with live price. Then a day, a morning/afternoon window and an address. Then they pay a percentage deposit. The owner gets an email with a confirm link and sets the exact time.
- Ignored requests get a reminder at 24 hours and an auto-refund at 48.
- Membership: members get a code, not a login. Plans (Bronze $79, Silver $99, Gold $199 per month, example prices), stamps and rewards, priority booking (30 days out vs 7), slot bumping, and a $10 Slot Anchor.
- Prices, plans, rewards and anchor price live in the Supabase `catalog` table (`catalog.config`), not in code. Prices are computed server-side and frozen on each booking.
- Credits and stamps are append-only ledgers with no-negative-balance triggers.
- Login is a 6-digit email code. There is no SMS anywhere. All notifications are email.
- This project has its own Supabase project (`brotherly-love-detailing`). Never touch any other business's database.

## Starting-price booking (website, 2026-11)
- Five services priced by vehicle type (Sedan / SUV-Truck / Large SUV), flat deposits $25/$35/$45 credited to the final bill, owner sets the real price in person. Full tables and rules: README "Starting-price booking" and `docs/superpowers/specs/2026-11-10-bld-starting-prices-design.md`, plan in `docs/superpowers/plans/2026-11-11-bld-starting-prices.md`.
- Prices live in `catalog.config.detailPricing`; maths in `supabase/functions/_shared/detail_pricing.ts` (Jest: `bld-app/__tests__/detail_*.test.ts`). The website (`assets/booking.js`) and dashboard never compute prices.
- Backend: edge function `detail` (quote / availability / reserve / pay-demo), admin actions `detail_get`, `invoice_save`, `invoice_approve`, `invoice_pay`, `detail_pricing_get/save`, migration `0015`. Live proof: `scripts/e2e-detail.mjs`.
- Payments for this flow are a **demo** (`app_config.payments_mode`). Nothing may write `deposit_status = 'paid'` without a confirmed Stripe payment.
- No travel fees, no distance lookup, no $100 minimum, no first-wash discount in the website quote. The Expo app and memberships still use the old catalog.

## Run it
```bash
cd /Volumes/AgentDrive/claude/brotherly-love-detailing/bld-app
npm install        # first time; point npm cache and TMPDIR at /Volumes/AgentDrive/claude/_tmp
npx expo start     # iOS sim: press i. Expo Go also works.
npx jest           # unit tests
npx tsc --noEmit   # typecheck
```
`bld-app/.env` holds the Supabase URL and anon key. It is gitignored. Never print or commit it.

## Status (from the README, not re-verified by me)
Rounds 1, 2 and 3 are built. Round 3 (self-serve Stripe membership purchase) needs one manual step before it fulfills: set the Stripe webhook signing secret. Booking-deposit card capture still uses the fake payment provider.

## Rules for you
- Propose, then wait for the owner's yes, before: deploys, migrations on the live Supabase project, Stripe or email changes, sending anything to customers, deletes.
- Do not change prices in code. Change them in the `catalog` table.
- Do not print, copy or commit any key. Keys come from env files only.
- Test on the iPhone 17 Pro simulator only. Do not boot extra simulators.
- Run `npx jest` and `npx tsc --noEmit` before saying anything is done. Report failures with the output.
- Say "Unknown" when you do not know. Do not guess.
- Keep answers short: lead with the answer, number the steps, end with one next step.

## First task
Do not change code yet. Install deps, run the app in the simulator, run the tests, then report: what works, what fails, and what you would build next.
