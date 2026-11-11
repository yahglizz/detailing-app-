# App Sync Build Log

Spec: `docs/superpowers/specs/2026-11-11-bld-app-sync-design.md`
Plan: `docs/superpowers/plans/2026-11-11-bld-app-sync.md`
Branch: `app-sync`

Owner instruction (2026-11-11): build fully working end to end; Sonnet agents for small tasks, Opus agents for big ones; test while building; Codex CLI review loop until no errors; then commit, push and deploy live everywhere.

| # | Task | Agent | Status | Tests |
|---|------|-------|--------|-------|
| 1 | Pricing core | Opus | done `51c7148` | jest 132/132 (3 files 170/170), tsc clean |
| 2 | Reserve validation | Sonnet | done `754f7ab` | jest 26/26 |
| 3 | Migration 0017 | Opus | running | |
| 4 | `detail` function | Opus | pending | |
| 5 | Plan readers + retire `book` | Sonnet | running | |
| 6 | Dashboard | Opus | pending | |
| 7 | Website multi-car | Opus | pending | |
| 8 | App | Opus | pending | |
| 9 | Codex review loop | Codex CLI + Opus | pending | |
| 10 | Deploy live + live E2E + cleanup | main | pending | |

## Notes
- Invoice line = `{price, covered, credit?}`; payable = covered ? 0 : max(0, price - credit). Partial (bigger car) lines carry credit = plan-size price; free-wash lines are covered. (Decided after Task 1.)
- `validateDetailPricing` fills the four new tier fields from defaults when missing, so the live config keeps working before 0017.
- Live DB: Postgres 17.6; check names are the defaults (`booking_invoices_paid_method_check`, `bookings_remainder_method_check`); `memberships_credits_per_period_check` is `> 0` (all new plans have >= 2 visits).
- After Task 3: invoice gets `reward_percent` (25% reward survives to the job); member discount rounded once on the total in quote and invoice (no $1 drift).
- `detail/index.ts` does not type-check between Task 2 and Task 4. Do not deploy `detail` before Task 4.
