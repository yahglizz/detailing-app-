# Codex Review Prompt — App Sync, Multi-Car, Re-priced Memberships

You are reviewing branch `app-sync` of the Brotherly Love Detailing repo (mobile car detailing: website, Supabase backend, owner dashboard, Expo app). Review only; do not edit files.

## Read first
- Spec: `docs/superpowers/specs/2026-11-11-bld-app-sync-design.md` (the "Corrections after the builder check" section overrides earlier sections).
- Plan: `docs/superpowers/plans/2026-11-11-bld-app-sync.md` (Global Constraints are binding).
- Diff to review: `git diff starting-prices...app-sync`.

## What to check (in this order)
1. **Money correctness.** Every price, deposit, member discount, included visit, reward and invoice total is computed server-side in `supabase/functions/_shared/detail_pricing.ts` or SQL, in whole dollars, matching the spec. Client values are never trusted. A demo deposit is never treated as paid. Balance debits go through `wallet_ledger` in the same transaction.
2. **Atomicity and races.** `detail_reserve` and `detail_invoice_pay` in `supabase/migrations/0017_app_sync.sql`: lock order (day lock first, same keys as `enforce_detail_capacity`), no path where the unique slot index `bookings_detail_slot_once` throws to the user, a bump only moves `pending_payment|requested` non-anchored holders, a paid invoice is immutable.
3. **Security.** Service-role-only functions (`revoke ... from public, anon, authenticated`), `search_path` pinned, member codes rate-limited via `resolveCode`, no PII or payKey leaks in public responses (`availability.holders` exposes ranks only), dashboard owner-only actions listed in `_shared/admin_rules.ts`.
4. **Compatibility.** The live website keeps working during the deploy window: `availability.taken` is still a string array; the old single-car reserve body is accepted; `expectedTotal` optional.
5. **App.** `bld-app/src/**`: no price maths beyond display of server answers; correct `supabase.functions.invoke('detail', …)` error handling; types pass `tsc --noEmit`.
6. **Tests.** Missing tests for the Review Focus items in the plan.

## How to run checks (read-only)
- `cd bld-app && npx jest __tests__/detail_pricing.test.ts __tests__/detail_booking.test.ts __tests__/admin.test.ts __tests__/membership.test.ts __tests__/order.test.ts`
- `cd bld-app && npx tsc --noEmit`
- From repo root: `deno check supabase/functions/detail/index.ts supabase/functions/admin/index.ts supabase/functions/member/index.ts supabase/functions/topup/index.ts supabase/functions/book/index.ts`

## Output format
Return ONLY a findings list, most severe first. One finding per line:

`SEVERITY | path:line | problem | concrete failure scenario | fix`

SEVERITY is one of `BLOCKER` (wrong money, data loss, security hole, broken live site), `MAJOR` (feature doesn't work as spec says), `MINOR` (edge case, missing test). Skip style nits. If there are no findings, output exactly `NO FINDINGS`.
