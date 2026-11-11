# App Sync Build Log

Spec: `docs/superpowers/specs/2026-11-11-bld-app-sync-design.md`
Plan: `docs/superpowers/plans/2026-11-11-bld-app-sync.md`
Branch: `app-sync`

Owner instruction (2026-11-11): build fully working end to end; Sonnet agents for small tasks, Opus agents for big ones; test while building; Codex CLI review loop until no errors; then commit, push and deploy live everywhere.

| # | Task | Agent | Status | Tests |
|---|------|-------|--------|-------|
| 1 | Pricing core | Opus | done `51c7148` | jest 132/132 (3 files 170/170), tsc clean |
| 2 | Reserve validation | Sonnet | done `754f7ab` | jest 26/26 |
| 3 | Migration 0017 | Opus | done `fc96480` | jest 191/191; PGlite chain 0001-0017 29/29 |
| 4 | `detail` function | Opus + Sonnet fixes | done `bf47ebc`, `f0a3af3` | deno check + lint clean |
| 5 | Plan readers + retire `book` | Sonnet | done `14c5ec4` | jest 18/18; deno check clean |
| 6 | Dashboard | Opus + main | done `f0a3af3` | jest 17/17 admin; deno check; app.js parses |
| 7 | Website multi-car | Opus | done `5445601` | local Playwright 23/23, no console errors |
| 8 | App | Opus | done `6b97277` | jest 225/225 (6 suites), tsc clean, expo export ios OK |
| - | Live E2E script | Sonnet | done `a199971` | node --check |
| 9 | Codex review loop | Codex CLI + Opus | done (passes 1-13; 12 clean, 13 fixed `9100282`) | jest 233/233, tsc 0, deno check 8, SQL 51/51 |
| 10 | Deploy live + live E2E + cleanup | main | in progress (see Live deploy) | |

## Notes
- Invoice line = `{price, covered, credit?}`; payable = covered ? 0 : max(0, price - credit). Partial (bigger car) lines carry credit = plan-size price; free-wash lines are covered. (Decided after Task 1.)
- `validateDetailPricing` fills the four new tier fields from defaults when missing, so the live config keeps working before 0017.
- Live DB: Postgres 17.6; check names are the defaults (`booking_invoices_paid_method_check`, `bookings_remainder_method_check`); `memberships_credits_per_period_check` is `> 0` (all new plans have >= 2 visits).
- After Task 3: invoice gets `reward_percent` (25% reward survives to the job); member discount rounded once on the total in quote and invoice (no $1 drift).
- `detail/index.ts` does not type-check between Task 2 and Task 4. Do not deploy `detail` before Task 4.

## Codex pass 1 (backend, website, dashboard)
7 findings. Fixed: visit race (lock in detail_reserve), reward+flip atomic (detail_pay_demo), stamps in the pay transaction, Eastern billing-month boundary, mirrorQuote after paid. Not a bug: "round at each step" — single rounding is deliberate (quote = invoice); spec/plan updated. Test gap (concurrent bump) added to e2e.
Security review (plugin): balance only for code-made bookings (`viaCode`), bump email without customer-typed name, clientIp trusts only cf-connecting-ip.
- Incident: during Task 8 cleanup the app agent ran `rm -f probe*` in `/Volumes/AgentDrive/claude/_tmp` and deleted a `probe.txt` it did not create. Contents and owner unknown; not recoverable.
- Codex pass 1 fixes verified: SQL harness 43/43 (mutation check: 5 new cases fail when the fixes are removed), jest 215/215, deno check 7 functions — commit `4c6f408`.

## Codex passes 2-13
Passes 2-11: every finding fixed and committed (see git log `fix: Codex pass N`). Pass 12: NO FINDINGS at `17904da`. Pass 13 (delta `17904da..HEAD`): savings clamp OK, client auth headers OK; 1 finding (e2e app half left the test member's bookings/ledgers behind) fixed by `e2e-setup` action `member-reset` (`9100282`).

## Live deploy (2026-11-11)
- Supabase `fiaadogbkvjcddehnymj`: migration 0017 applied. Functions: detail v2, admin v6, member v7, topup v2, book v9 (410 `app_update_required`), sweep v10, e2e-setup v12. Not redeployed: confirm (unchanged), stripe-webhook (only new Stripe member provisioning; not in use). Each probed after deploy.
- Live E2E (`scripts/e2e-detail.mjs`): steps 1-15b PASS against production. Steps 16-20 blocked by the 10 bookings/hour IP cap (one full run books more than 10); script now has `E2E_PART=core|app` and `E2E_ONLY=16,17,...`.
- The script's own cleanup needs the real owner key (`owner_admin_token`); without it, test rows are removed by SQL (needs owner approval in the Supabase prompt).
- Website: preview deploy `6k32kkl74` (behind Vercel login). Production still `nqpt6buxh` (rollback target).
- iOS simulator: blocked. Mac disk had 1.5 GB free; booting the iPhone 17 Pro sim dropped it to ~280 MB and simctl screenshots failed (read-only file system). Sim shut down. Needs ~2 GB freed on the Mac.
- 22:52 UTC: live E2E steps 16-20 PASS (`E2E_PART=app E2E_ONLY=16,...,20`): confirmed not bumpable; release frees visit (2 -> 1 -> 2); $25 deposit from balance; invoice 183 paid by balance, job done; +3 stamps (Gold, 1 car). With runs 2-3, all steps 1-20 have passed against production.
- Website (committed files served locally with Vercel's two rewrites, calling the LIVE functions and LIVE dashboard): Playwright 23/23 PASS, no console errors: 2-car $510/$70, 6-car cap, dashboard "2 cars" -> confirm -> Cash $510 -> Done, single car $95/$35, phone 390px no horizontal scroll. Production site still `nqpt6buxh` (old front end); the backend still accepts its single-car request shape (`detail_booking.ts:73`).
- iOS simulator (iPhone 17 Pro, Expo Go 57, Maestro with a portable JDK on AgentDrive): app bundles (1097 modules) and loads live data: Gold test member, Exterior 2/2, Full 0/1, resets Nov 17; booking review prices Full Detail sedan $175 -> GOLD $140 (20%), deposit $25, matching the server. NOT done: the app booking itself. Maestro's day pick missed ("Nov 18" not found) and the Exterior Wash tap did not change the package (unverified whether that is the flow or the app). Stopped at 258 MB free on the Mac.
