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
| 8 | App | Opus | running | |
| - | Live E2E script | Sonnet | done `a199971` | node --check |
| 9 | Codex review loop | Codex CLI + Opus | pending | |
| 10 | Deploy live + live E2E + cleanup | main | pending | |

## Notes
- Invoice line = `{price, covered, credit?}`; payable = covered ? 0 : max(0, price - credit). Partial (bigger car) lines carry credit = plan-size price; free-wash lines are covered. (Decided after Task 1.)
- `validateDetailPricing` fills the four new tier fields from defaults when missing, so the live config keeps working before 0017.
- Live DB: Postgres 17.6; check names are the defaults (`booking_invoices_paid_method_check`, `bookings_remainder_method_check`); `memberships_credits_per_period_check` is `> 0` (all new plans have >= 2 visits).
- After Task 3: invoice gets `reward_percent` (25% reward survives to the job); member discount rounded once on the total in quote and invoice (no $1 drift).
- `detail/index.ts` does not type-check between Task 2 and Task 4. Do not deploy `detail` before Task 4.

## Codex pass 1 (backend, website, dashboard)
7 findings. Fixed: visit race (lock in detail_reserve), reward+flip atomic (detail_pay_demo), stamps in the pay transaction, Eastern billing-month boundary, mirrorQuote after paid. Not a bug: "round at each step" — single rounding is deliberate (quote = invoice); spec/plan updated. Test gap (concurrent bump) added to e2e.
Security review (plugin): balance only for code-made bookings (`viaCode`), bump email without customer-typed name, clientIp trusts only cf-connecting-ip.
