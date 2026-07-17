# Codex Review Handoff — BLD Member Mode (Round 2)

**Purpose:** hand an independent, adversarial code + database review of the Round 2
membership feature to OpenAI Codex. Everything here was built and reviewed by
Claude with per-task + whole-branch review passes and a live end-to-end script;
your job is a fresh second-model pass to catch what those missed. Assume nothing
is correct just because it shipped.

Branch: `bld-member-mode` (24 commits over baseline `5f49f79`). Working tree clean
at HEAD `dd1db9b`. Do NOT push or merge — review only.

---

## 1. What the feature is

Members get a **code**, not a login (the code is a bearer identity). Typing it once
opens a dashboard: washes left, dollars saved, a stamp punch-card with redeemable
rewards, plan + upgrade, book-with-credit, history. Owner issues codes from a
signed-link admin page. Non-members can buy a **$10 slot anchor** to be bump-proof.
Rank-based **priority booking**: a higher-tier member booking a held slot bumps the
holder to the next open time that day; equal tiers escalate to the owner. `sweep`
grants monthly credits. The marketing website reads live prices from the DB.

Spec: [`docs/superpowers/specs/2026-07-16-bld-member-mode-design.md`](superpowers/specs/2026-07-16-bld-member-mode-design.md)
Plan: [`docs/superpowers/plans/2026-07-16-bld-member-mode.md`](superpowers/plans/2026-07-16-bld-member-mode.md)

---

## 2. Where everything lives

**Database (migrations, applied to live project `fiaadogbkvjcddehnymj`):**
- `supabase/migrations/0005_member_mode.sql` — `catalog.config` gains `plans`/`rewards`/`rewardValues`/`anchorPrice`; `memberships.code`+`.tier`; `reward_ledger`, `redemptions`; `bookings` gains `membership_id`/`anchored`/`bumped_from`/`rank`/`paid_with_credit`; `slot_states(day)` RPC.
- `supabase/migrations/0006_app_config.sql` — `app_config` service-role-only table; owner admin token generated server-side (no secret in git).
- `supabase/migrations/0007_monthly_grant_unique.sql` — partial unique index backstopping sweep double-grant.
- Pre-existing: `0001_init.sql` (customers/catalog/bookings/payments/memberships/credit_ledger + no-negative-credit trigger), `0003_email_identity.sql` (customers keyed by email, unique), `0004_time_slots.sql`.

**Edge functions (Deno, `supabase/functions/`):**
- `book/index.ts` — the money path: membership lookup, booking-window enforcement (member 30d / non-member 7d), bump engine, credits → reward → anchor pricing, charge, then credit-debit + reward-flip with conflict reconciliation. **Highest-risk file.**
- `member/index.ts` — profile / redeem / upgrade, keyed by code (bearer).
- `owner-members/index.ts` — owner HTML admin page (token-gated), add/manage members, mark jobs done.
- `sweep/index.ts` — hourly cron: stale-booking reminders/refunds + monthly credit grants + member void-restore.
- `confirm/index.ts` — owner confirm/decline page; decline restores member credit/reward.
- `e2e-setup/index.ts` — TEST-ONLY, token-gated: create-user / booking-token / cleanup.
- `_shared/` — `pricing.ts`, `membership.ts` (pure, jest-tested), `bump.ts` (pure, jest-tested), `member_refund.ts` (void-restore), `notify.ts` (Resend, dry-run without key), `payments/` (FakeProvider behind `getProvider()`).

**App (Expo/React Native, `bld-app/`):**
- `src/state/member.tsx` (MemberProvider/useMember), `src/screens/MemberCode.tsx`, `src/screens/MemberDashboard.tsx`, and member context spliced into `src/screens/Schedule.tsx` (priority slots), `Pay.tsx` (credits/anchor/zero-deposit), `Booked.tsx`, `src/state/order.tsx` (anchor field), `App.tsx`.

**Website:** `Brotherly Love Detailing.dc.html` — fetches `catalog?id=eq.1` via the public anon key, renders service + tier prices, static fallback on failure.

**E2E proof:** `scripts/e2e-member.mjs` — 28 assertions, ran GREEN & deterministic against the live project.

---

## 3. How to inspect

- **Live DB:** Supabase MCP, project ref `fiaadogbkvjcddehnymj`. Use `list_tables`, `execute_sql` (read), `get_logs`, `get_advisors`. Do NOT mutate live data except your own throwaway test rows (clean them up).
- **Unit tests:** `cd bld-app && npx jest` (37 tests) and `npx tsc --noEmit`.
- **E2E:** reads at top of `scripts/e2e-member.mjs` — needs the ANON key (public, in `bld-app/.env`) and the owner admin token. The owner token is NOT in git; it lives in `app_config.value where key='owner_admin_token'` (read it via `execute_sql`). Run: `node scripts/e2e-member.mjs`.
- **Deploy for testing:** `deploy_edge_function` MCP against the same project. Note there is **no** Supabase CLI / access token on this machine — all deploys go through the MCP tool, and function env secrets can't be set (that's why the owner token lives in `app_config`, read at runtime).

---

## 4. Already reviewed + fixed — do NOT re-litigate (but flag if worse than believed)

Each was found by review and fixed; verified by test/E2E:
- `book` concurrent credit/reward double-spend → reconciled (refund + void on conflict). Commit `92be3cd`.
- `member` redeem non-atomic → rollback on voucher-insert failure. `bf7616d`.
- `owner-members` stored-XSS (customer name→token theft) → `esc()` all customer strings; token generated server-side, not committed. `bbb2df8`.
- `sweep` day-of-month drift + unchecked writes → anchor from immutable `created_at`, clamped threshold, idempotent per-period key + `0007` unique index. `582f36e`.
- App network-failure throw/hang → `callMember` degrades to `'network'`. `b585b67`.
- Pay hardcoded `$10` anchor + reward-order display mismatch → gated on catalog load; member issued-rewards ordered by `created_at`. `d869638`.
- **Identity seam (E2E-caught):** owner-issued member's placeholder customer row (random id, unique email) collided with `book`'s upsert-by-auth-uid → every member's first booking 500'd. Fixed: member bookings use `membership.customer_id`; guest bookings resolve customer by email. `07d0441`, `7d7ce9c`.
- **Void-restore (whole-branch-review-caught):** decline/auto-refund of a member booking didn't return the spent credit/reward. Fixed via `_shared/member_refund.ts` in `confirm` + `sweep`. `7d7ce9c`. E2E steps 15e/15i prove it.

**Accepted design decisions (not bugs):**
- Member code = bearer identity: any authed user holding a code acts as that member. Chosen model.
- No DB unique index on `(preferred_day, time_slot)`: a naive one breaks the bump flow (bumping booking + holder briefly share a slot). Slot TOCTOU race accepted at single-operator scale.

**Deferred Minors (confirmed low-severity):** `member` 405 returns plain text; `cat!.config` non-null assert (500 if catalog row absent); dead `customer_id` in a memberships select; `refundDeposit` best-effort (real-provider `!ok` not surfaced — fake provider always ok); bumped/escalated new-booking `time_window` cosmetic; MemberCode `ActivityIndicator` hardcoded `#fff`; dashboard redeem Alert only special-cases `not_enough_stamps`; Pay.tsx `ctx.json()` same network-throw pattern (pre-existing round-1); escalate slot still tagged "VIP — TAKE IT"; `Booked` shows "Deposit paid" for $0 credit washes + dead `memberStampPreview` param; confirming an escalated booking never assigns `time_slot` (owner works off `scheduled_note`).

---

## 5. Where to point your review (fresh-eyes targets)

These are the areas most worth an independent pass — not because a bug is known,
but because they're subtle, cross-cutting, or money/security-adjacent:

**Database:**
1. **RLS completeness.** Confirm `memberships`, `credit_ledger`, `reward_ledger`, `redemptions`, `app_config` truly return zero rows to the `anon` and `authenticated` roles (no stray policy). Confirm `slot_states` / `booked_slots` (SECURITY DEFINER) leak no PII. Try to read member data with only the anon key.
2. **Ledger integrity under the triggers.** `credit_ledger` has a no-negative trigger; `reward_ledger` too. Trace every writer (book, member, owner-members, sweep, member_refund) — can any sequence leave a balance wrong, or a `void refund` / `wash_rollback` compensating row double-applied?
3. **`redemptions` state machine.** issued → applied (book) → issued (void-restore). Any path that strands a voucher `applied` with a refunded booking, or lets one voucher discount two washes?
4. **Idempotency of `sweep` monthly grants** across the `0007` partial index + reason key + `created_at` anchor. Trace leap years, Feb-29 signup, timezone edges.

**Code:**
5. **`book/index.ts` money math end to end.** Deposit computed on payable after credits+reward+anchor; the conflict-reconciliation branches (`credit_conflict`, `reward_conflict`) — is there any early-return that leaves a charged card with no booking, or consumes a balance without a booking?
6. **Bump engine correctness** (`_shared/bump.ts` + its use in `book`): the holder is moved (not the booker); `nextOpenSlot` gets the right taken-set; no-open-slot escalates without double-booking; escalated bookings (`time_slot=null`) are handled sanely everywhere they're read (confirm, sweep, member, app).
7. **Client price display vs server charge** in `Pay.tsx` — the server is authoritative, but any user-visible mismatch (credits, reward, anchor, price_changed handling) is a UX bug worth flagging.
8. **`e2e-setup` exposure.** It's token-gated but runs with the service role and can create/delete users + data. Confirm the gate is airtight and consider whether it should be removed from the deployed project before launch (it's test-only).

---

## 6. Deliverable

Produce a findings report grouped **Critical / Important / Minor**, each with:
- `file:line` (or migration + object name for DB findings),
- a concrete failure scenario (inputs → wrong result),
- suggested fix direction.

Verify findings before reporting — prefer a reproduction (a SQL query against the
live project, or a focused test) over a hunch. If a finding contradicts an accepted
decision in §4, say so and argue why it should be reconsidered rather than assuming
it's an oversight. Do not fix anything without sign-off; this is a review pass.
