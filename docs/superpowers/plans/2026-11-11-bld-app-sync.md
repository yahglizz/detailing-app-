# BLD App Sync, Multi-Car and Re-priced Memberships — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Expo app books and prices exactly like the website through the `detail` function. Both the app and the website book 1–6 cars per visit. Bronze/Silver/Gold members keep visits, % off, stamps, balance and VIP bumping on the new prices.

**Architecture:**
- All money maths stays in pure TS modules under `supabase/functions/_shared/`, shared by Jest (in `bld-app/__tests__`) and the Deno functions.
- The DB does the parts that must be atomic, each in one security-definer function:
  - `detail_reserve`: bump, insert and balance debit together.
  - `detail_invoice_pay`: invoice lines, member % and balance payment.
- The app and the website render server answers only.

**Tech Stack:**
- Supabase Postgres + Deno edge functions.
- Expo SDK 57 / React Native 0.86 (`bld-app`).
- Vanilla JS website (`assets/booking.js`) and Preact+htm dashboard (`admin/app.js`).
- Jest (jest-expo), `deno check`, `tsc --noEmit`, Playwright (`channel='chrome'`), iOS simulator (iPhone 17 Pro).

**Spec:** `docs/superpowers/specs/2026-11-11-bld-app-sync-design.md`. Its section "Corrections after the builder check" overrides the earlier sections.

## Global Constraints

- **Project:** Supabase project `fiaadogbkvjcddehnymj` only. Never touch `eqblpbeqothkpyqiafzs`.
- **Money:** whole dollars; member % and reward % rounded once on the total, same formula in quote and invoice (see spec). The client never sends a price that is trusted.
- **Cars:** 1–6 per booking. One time slot per booking. Deposit = sum of `depositFor` per car.
- **Vehicle order:** `sedan < suv < large`. Saved-car `truck` reads as `suv`.
- **Plan config** lives only in `detailPricing.membership.<tier>` with fields:
  - `rank`: bronze 1, silver 2, gold 3
  - `stampsPerCar`: 1 / 2 / 3
  - `topupBonusPercent`: 5 / 10 / 15
  - `discountPercent`: 10 / 15 / 20
- **Visits:**
  - Used = bookings with status in `pending_payment|requested|confirmed|done`, created in the current billing month (monthly anniversary of `period_start`).
  - They expire at the anniversary.
- **Bumping:**
  - Only holders with status `pending_payment|requested` and `anchored=false` can be moved.
  - New `detail_v2` rows are stored with `anchored=false`.
- **Rewards:** marked `applied` only when the deposit step completes (`pay-demo`, or a balance-paid reserve).
- **Payments:** stay demo (`payments_mode='demo'`). A demo deposit is never `paid`. Balance debits use `wallet_ledger` (non-negative trigger).
- **Photos:** max 4 per booking (`MAX_PHOTOS`). Booking window: 14 days for everyone.
- **Live safety:** every live write needs the owner's yes, plus the build gate. That covers migrations, function deploys, Vercel deploys and data cleanup. Use explicit file lists in `git add`. Never stage the owner's untracked dirs.
- **Website compatibility:**
  - `availability.taken` stays a string array.
  - Old single-car reserve body stays valid.
  - `expectedTotal` is optional.

## Review Focus

1. **Member books 2 cars of the plan's service with 1 visit left.**
   - Expect: the most expensive eligible car is covered, the other gets % off.
   - Test: `memberQuote covers most expensive first`, in Task 1.
2. **Large SUV on a sedan plan.**
   - Expect: pays the sedan→large difference, then % off on that difference.
   - Test: `memberQuote bigger car pays difference`, in Task 1.
3. **Two people reserve the same slot at once, one a gold member, holder unconfirmed.**
   - Expect: exactly one ends up in the slot, the other moved or escalated, never a 23505 error to the user.
   - Test: live E2E step `bump race`, in Task 9.
4. **Owner raises a covered car's price at the job.**
   - Expect: covered line stays $0. Extras on it get % off.
   - Test: `invoice lines covered stays zero`, in Task 1, plus SQL check in Task 3.
5. **Abandoned member hold (closed on the deposit step).**
   - Expect: visits come back after release/sweep, reward still `issued`.
   - Test: live E2E step `release frees visit`, in Task 9.

---

### Task 1: Pricing core (multi-car quote, member quote, per-car invoice)

**Files:**
- Modify: `supabase/functions/_shared/detail_pricing.ts`
- Test: `bld-app/__tests__/detail_pricing.test.ts`

**Interfaces:**
- Produces:
  - `MembershipTierConfig` gains `rank: number; stampsPerCar: number; topupBonusPercent: number; discountPercent: number`.
    - Defaults are as in Global Constraints. `validateDetailPricing` checks:
      - `rank` 1–3, unique per tier
      - `stampsPerCar` 1–10
      - `topupBonusPercent` 0–50
      - `discountPercent` 0–50
  - `membershipView` adds `discountPercent, stampsPerCar, topupBonusPercent, rank` per tier.
  - `type CarLine = { service: DetailService; vehicleType: VehicleType }`.
  - `quoteCars(cfg, cars: CarLine[]): { lines: {service, vehicleType, startingPrice, deposit}[]; subtotal: number; deposit: number }`.
    - Throws `bad_cars` when the length is outside 1–6.
  - `vehicleRank(v: VehicleType): 0|1|2`.
  - `type MemberCtx = { tier: MemberTier; planVehicle: VehicleType; visitsLeft: Partial<Record<DetailService, number>>; reward: 'tireShine'|'miniSpray'|'percent25'|'freeWash'|null }`.
  - `memberQuote(cfg, cars: CarLine[], m: MemberCtx)` returns:
    - `lines` with `covered: boolean; payable: number`
    - `subtotal`, `payable`
    - `visitsUsed: Partial<Record<DetailService, number>>`
    - `rewardUsed: boolean`, `memberDiscount: number`, `savings: number`
    - `deposit: number`: sum of `depositFor` over lines with `payable > 0`, capped at `payable`.
  - `billingMonthStart(periodStart: string, today: string): string`: ISO day of the current anniversary.
  - `invoiceTotalsLines({ lines: {price: number; covered: boolean}[]; extras: InvoiceExtra[]; memberPercent: number; depositCredit: number })` returns `{ total, credit, balance, refundDue }`.
    - Formula: `total = round((sum of uncovered prices + sum of extras) * (1 - memberPercent/100))`.
    - Throws `bad_invoice` on bad numbers.
    - The existing `invoiceTotals` stays and is used for one-line, non-member invoices.

- [ ] **Step 1: Write failing tests:**
  - `quoteCars sums prices and deposits`: sedan full + large premium → subtotal 175+335=510, deposit 25+45=70.
  - `quoteCars rejects 0 and 7 cars`.
  - `memberQuote covers most expensive first`: gold, sedan plan, visitsLeft {full:1}, cars [sedan full, sedan full] → one covered, other payable `175 - round(175*0.2)=140`.
  - `memberQuote bigger car pays difference`: gold, planVehicle sedan, visitsLeft {full:1}, car large full → payable `(235-175)=60` then 20% off → 48.
  - `memberQuote reward percent25 then tier %`.
  - `memberQuote freeWash frees cheapest uncovered car`.
  - `memberQuote all covered → payable 0, deposit 0`.
  - `billingMonthStart` cases: 2026-01-31 period start, today 2026-03-01 → 2026-02-28.
  - `invoice lines covered stays zero`: lines [{price:300,covered:true},{price:200,covered:false}], extras [{name:'Heavy',price:50}], memberPercent 20, credit 0 → total `round(250*0.8)=200`.
  - `validateDetailPricing rejects duplicate rank`.
- [ ] **Step 2:** Run `cd bld-app && npx jest __tests__/detail_pricing.test.ts`. Expected: FAIL (functions not defined).
- [ ] **Step 3:** Implement the interfaces above in `detail_pricing.ts`.
  - Most-expensive-first: sort eligible line indexes by `startingPrice` descending.
  - A line is eligible for a visit of its service when `vehicleRank(line) <= vehicleRank(planVehicle)`, or bigger and then partially covered: payable = `price(line) - price(service, planVehicle)`.
- [ ] **Step 4:** Run the jest file again. Expected: PASS.
- [ ] **Step 5:** Commit: `git add supabase/functions/_shared/detail_pricing.ts bld-app/__tests__/detail_pricing.test.ts && git commit -m "feat: multi-car and member pricing core"`.

### Task 2: Reserve validation for cars[], member code, balance

**Files:**
- Modify: `supabase/functions/_shared/detail_booking.ts`
- Test: `bld-app/__tests__/detail_booking.test.ts`

**Interfaces:**
- Consumes: `CarLine`, `isService`, `isVehicle` (Task 1).
- Produces: `ReserveInput` replaces `vehicle/vehicleType/service/condition/petHair` with:
  - `cars: { year: string; make: string; vehicleType; service; condition; petHair: boolean }[]` (1–6)
  - plus `memberCode: string | null` (trimmed, uppercased, ≤ 20)
  - `useBalance: boolean`
  - `expectedTotal: number | null`
- Old single-car body (top-level `vehicle`, `vehicleType`, `service`, `condition`, `petHair`) maps to `cars` of length 1.
- Errors: `bad_cars` for an empty or >6 list; per-car errors keep the existing codes.

- [ ] **Step 1: Write failing tests:**
  - `accepts cars array of 2`
  - `legacy single-car body maps to cars[0]`
  - `rejects 7 cars with bad_cars`
  - `bad condition in car 2 → bad_condition`
  - `memberCode uppercased`
  - `useBalance defaults false`
  - `expectedTotal optional`
- [ ] **Step 2:** Run `npx jest __tests__/detail_booking.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement in `validateReserve`.
- [ ] **Step 4:** Run the jest file. Expected: PASS.
- [ ] **Step 5:** Commit: `git add` both files, then `git commit -m "feat: reserve accepts several cars, member code and balance"`.

### Task 3: Migration 0017 (atomic reserve with bump + balance, per-car invoice pay)

**Files:**
- Create: `supabase/migrations/0017_app_sync.sql`, `scripts/rollback-0017.sql` (0015's `detail_invoice_pay` body)
- Modify: `bld-app/__tests__/detail_pricing.test.ts` (the marker test now reads the newest migration with a `-- detailPricing:begin` block)

**Interfaces:**
- **`memberships.vehicle_type`:** `text not null default 'sedan' check in ('sedan','suv','large')`.
- **`booking_invoices`:** add `lines jsonb not null default '[]'`, `member_percent int not null default 0 check 0..50`. Widen `paid_method` check to `cash|card|balance`.
- **`detail_reserve(p_row jsonb, p_rank int, p_wallet_debit int) returns jsonb`**, security definer, `search_path=public`, granted to service_role only.
  - Locking:
    - Takes the day advisory lock (`'detail-day:'||day`, same key the trigger uses; re-entrant in one transaction).
    - Selects the slot holder (non-declined/refunded, `anchored desc, rank desc`) `for update`.
  - Decision:
    - No holder → open.
    - Holder anchored, or status not in `pending_payment|requested` → raise `slot_taken`.
    - `p_rank > holder.rank` → bump.
    - Equal and >0 → escalate (insert with `time_slot null`).
    - Otherwise → raise `slot_taken`.
  - Bump: holder moves to the first `ALL_SLOTS` value after the slot that is not in `booked_slots(day)`, or to `null`. Holder `detail = detail || {bumpedFrom, bumpedAt}`. Holder `bumped_from` = the old slot.
  - Insert: the row is inserted from `jsonb_populate_record(null::bookings, p_row)`.
  - Balance: if `p_wallet_debit > 0`:
    - Insert `wallet_ledger(customer_id, delta = -p_wallet_debit, reason 'deposit', booking_id)`. The non-negative trigger raises `insufficient_balance`.
    - Set `deposit_status='paid'`, `status='requested'`.
  - Returns `{escalated, bumpedId, movedTo}`.
- **`detail_invoice_pay(p_booking uuid, p_method text)`** replaced:
  - Accepts `balance`.
  - When no invoice exists, builds `lines` from `b.quote->'lines'` (fallback: one line of `startingPrice`) and `member_percent` from `b.quote->>'memberPercent'`.
  - Total per the `invoiceTotalsLines` formula.
  - For `balance`: inserts `wallet_ledger(-v_balance, 'job payment', booking_id)` in the same transaction. The trigger raises → `insufficient_balance`.
  - Records payments `provider 'balance'` for balance.
  - Everything else is unchanged.
- **`detailPricing.membership` merge:** a `-- detailPricing:begin/end` block equal to the new `DEFAULT_DETAIL_PRICING`. The SQL adds only the four new keys per tier where missing (`jsonb` `||` with the existing tier object on the right, so owner edits win).
- **Data fix:** `customers.cars` elements with `size='truck'` → `'suv'`.

- [ ] **Step 1:** Update the marker test to find the newest migration containing the block. Run it. Expected: FAIL (0017 doesn't exist).
- [ ] **Step 2:** Write `0017_app_sync.sql`.
- [ ] **Step 3:** Run the jest marker test. Expected: PASS.
- [ ] **Step 4: Check the SQL.**
  - Owner yes first; nothing persists: `execute_sql` with `begin; <0017 contents>; rollback;` on `fiaadogbkvjcddehnymj`.
  - Proves `detail_reserve` and `detail_invoice_pay` compile against the real schema.
  - Expected: no error.
- [ ] **Step 5:** Commit: `git add` the migration and the test, then `git commit -m "feat: migration 0017 atomic reserve with bump and balance, per-car invoices"`.

### Task 4: `detail` function

**Files:**
- Modify: `supabase/functions/detail/index.ts`

**Interfaces:**
- Consumes:
  - `quoteCars`, `memberQuote`, `billingMonthStart` (Task 1)
  - `validateReserve` (Task 2)
  - `detail_reserve` (Task 3)
  - `resolveCode`, `clientIp` (`_shared/codes.ts`)
  - `walletBalance` (`_shared/wallet.ts`)
- Produces (HTTP actions):
  - **`quote { cars[], memberCode? }`:** returns `quoteCars` result. With a valid member code it adds `member: memberQuote result + {tier, planVehicle, visitsLeft}`. Old `{service, vehicleType}` still returns the single-car shape.
  - **`availability`:** unchanged, plus `holders: {[slot]: rank}` from `slot_states(day)` when `day` is given.
  - **`reserve`:**
    - Multi-car, optional `memberCode` (invalid → 404 `invalid_code`, rate limited → 429).
    - Member bookings use the member's `customer_id` and set `membership_id`, `rank` and `anchored=false`; `is_test` sets `detail.test=true`.
    - `quote` json stored: `{lines, subtotal, total: payable, payable, deposit, memberPercent, visitsUsed, rewardId, startingPrice: subtotal, remainder, balanceDue, paidOnline}`.
    - `detail.cars[]` holds the per-car data.
    - `expectedTotal` given and ≠ payable → 409 `price_changed` + `quote`.
    - `useBalance` and balance ≥ deposit → `p_wallet_debit = deposit`, then notify the owner immediately.
    - Response adds `{escalated, paidFromBalance}`.
    - DB errors map: `slot_taken` 409, `insufficient_balance` → 409 `balance_changed`, existing mappings kept.
  - **`pay-demo`:** marks `redemptions.status='applied', booking_id` for `quote.rewardId` where status `issued`. If 0 rows, the booking stays pending and returns 409 `price_changed` with the re-priced quote.
  - **`notify`:** lists every car.

- [ ] **Step 1:** Implement. Visits used: select `quote->visitsUsed` of the member's bookings with the statuses from Global Constraints and `created_at >= billingMonthStart`.
- [ ] **Step 2:** Run `deno check supabase/functions/detail/index.ts`. Expected: no errors.
- [ ] **Step 3:** Commit `detail/index.ts` with message `feat: detail books several cars, member pricing, bumping, balance deposits`.

### Task 5: Repoint plan readers; retire old `book` checkout

**Files:**
- Modify:
  - `supabase/functions/topup/index.ts` (bonus from `detailPricing.membership[tier].topupBonusPercent`)
  - `supabase/functions/_shared/owner_actions.ts` (`markDone` stamps)
  - `supabase/functions/member/index.ts`
  - `supabase/functions/_shared/member_provision.ts` (`credits_per_period` = total visits, email text lists included visits)
  - `supabase/functions/_shared/membership.ts` (`SavedCar.size` adds `large`, optional `year`, `make`; `cleanSettings` accepts `sedan|suv|large|truck`, stores `truck` as `suv`)
  - `supabase/functions/book/index.ts`
- Test: `bld-app/__tests__/membership.test.ts` (`cleanSettings` cases)

**Interfaces:**
- Produces: `member` profile response adds:
  - `plan: { tier, vehicleType, monthlyPrice, discountPercent, stampsPerCar, topupBonusPercent, visits, visitsLeft, periodResetsOn } | null`
  - `credits` = total visits left (kept for old screens).
- Also in `member`:
  - Savings use `monthlyPrice`.
  - `test_tier` writes `credits_per_period` = total visits.
- `book` reserve path returns 410 `{error:'app_update_required'}` (the `settle` action is unchanged).
- Stamps are awarded in `admin` `invoice_pay` (Task 6) for `detail_v2` rows, through a new exported `awardStamps(db, bookingId)` in `owner_actions.ts`. `markDone` calls it too.

- [ ] **Step 1:** Failing tests: `cleanSettings maps truck to suv`, `cleanSettings accepts large with year and make`.
- [ ] **Step 2:** Run the jest file. Expected: FAIL.
- [ ] **Step 3:** Implement all files.
- [ ] **Step 4:** Run jest (PASS) and `deno check` on `topup`, `member`, `book`, `admin`. Expected: clean.
- [ ] **Step 5:** Commit the listed files with message `feat: plans read from detailPricing; old book checkout retired`.

### Task 6: Dashboard (per-car job, balance payment, member vehicle)

**Files:**
- Modify:
  - `supabase/functions/admin/index.ts`
  - `admin/app.js`
  - `admin/app.css` (only if new classes are needed)
- Test: `bld-app/__tests__/admin.test.ts`

**Interfaces:**
- **`detail_get`** returns:
  - `cars` (from `detail.cars`, or the legacy single car)
  - `invoice.lines`, `invoice.memberPercent`
  - `wallet` (customer balance)
  - `member` (`{tier, test}` or null)
  - `bump` (`detail.bumpedFrom`) or null
- **`invoice_save { id, lines:[{price}], extras }`:**
  - Covered lines are forced to 0 server-side.
  - Uses `invoiceTotalsLines`.
  - Legacy `{servicePrice}` maps to a single line.
- **`invoice_pay { id, method: 'cash'|'card'|'balance' }`:** after RPC success, calls `awardStamps` when `membership_id` is set.
- **`member_add`** takes `vehicleType`. Add **`member_vehicle { id, vehicleType }`**, owner-only (add to `OWNER_ONLY` in `_shared/admin_rules.ts`).
- **UI (`DetailJob`):**
  - A car list with a price input per uncovered line ("Included visit" badge on covered).
  - TEST badge.
  - "Moved from 10:00 AM by a VIP booking" note.
  - Pay buttons `Cash · $X`, `Card · $X`, and `Balance · $X` only when `wallet >= balance due`.
- **Members table:** a vehicle select per row and in the add form.

- [ ] **Step 1:** Failing admin tests: `member_vehicle is owner only`; `invoice_save forces covered lines to 0` (pure helper `cleanLines(lines, quoteLines)` exported from `admin_rules.ts` or `detail_pricing.ts`).
- [ ] **Step 2:** Run jest. Expected: FAIL.
- [ ] **Step 3:** Implement the server and UI.
- [ ] **Step 4:** Run jest and `deno check supabase/functions/admin/index.ts`. Expected: PASS / clean.
- [ ] **Step 5:** Commit the listed files with message `feat: dashboard per-car jobs, balance payments, member vehicle`.

### Task 7: Website multi-car

**Files:**
- Modify:
  - `assets/booking.js`
  - `assets/booking.css`
  - `Brotherly Love Detailing.dc.html` (plan cards show the new perks from config; no static perk drift)
  - `scripts/local-server.mjs` (mirror the multi-car `quote`/`reserve` and the `holders` field)

**Interfaces:**
- Consumes: `detail` actions from Task 4 (cars body, multi-line quote).
- **Vehicle step:**
  - Car cards: year, brand, vehicle type, package, condition, pet hair, each car's line price.
  - "+ Add another car" (hidden at 6) and "Remove" on cars 2+.
- **Summary, sticky bar and review:** per-car lines, subtotal, deposit sum.
- **Reserve body:** sends `cars[]`.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Start the local backend:
  ```
  rm -rf .local-data && node scripts/local-server.mjs
  ```
  Then run the Playwright script `scratchpad/e2e_multicar.py`. It books 2 cars (sedan full + large premium) and asserts:
  - review shows $510, deposit $70
  - the dashboard lists both cars
  - Cash · $510 marks Done

  Expected: all PASS, no console errors.
- [ ] **Step 3:** Mobile 390px check: no horizontal scroll, sticky bar shows $510.
- [ ] **Step 4:** Commit the listed files with message `feat: website books several cars per visit`.

### Task 8: App

**Files:**
- Modify:
  - `bld-app/src/state/catalog.tsx`: `detail` `config`; context value `{ pricing, membership, slots, today, loaded }`
  - `bld-app/src/state/order.tsx`:
    - Cars: `{year, make, vehicleType, service, condition, petHair}[]`
    - Fields: `street, zip, phone, email`
    - Photos: `photos: {uri, ext}[]`
    - Drop `extras`, `anchor`, `payMode`, `remainderMethod`
  - `bld-app/src/screens/Build.tsx`, rewritten in the same section style:
    - 01 Your cars, 02 Where & when, 03 You, 04 Photos, 05 Review & deposit
    - Server `quote` on change (debounced 300 ms)
    - Member VIP tags from `availability.holders` + `decideBump`
  - `bld-app/src/screens/Booked.tsx`: reference, the exact slot (or "we'll confirm your time" when escalated), calendar event at the slot
  - `bld-app/src/components/JoinTiers.tsx`: new plan cards with a vehicle toggle; "Ask about <plan>" inserts into `quote_leads` (same columns the website uses) and shows a thank-you
  - `bld-app/src/components/PriceBar.tsx`: delete if unused after the rewrite (check `grep -r PriceBar bld-app/src`)
  - `bld-app/src/screens/MemberDashboard.tsx`, `MemberSettings.tsx`, `TopUp.tsx`: read `profile.plan` and `catalog.membership`; saved cars get vehicle type + year/brand
  - `bld-app/package.json`: `npx expo install expo-image-picker`
- Delete:
  - `bld-app/__tests__/pricebar.test.tsx`, `checkout.test.tsx` (old checkout).
  - `member-state.test.tsx` stays if it still compiles; otherwise fix it to the new profile shape.
- Test:
  - `bld-app/__tests__/order.test.ts` (reducer: add/remove car, max 6, saved-car prefill)

**Interfaces:**
- Consumes:
  - `detail` actions `config`, `quote`, `availability`, `reserve`, `pay-demo`, `release` via `supabase.functions.invoke('detail', { body })`
  - the `member` profile from Task 5
- Booking with `memberCode` (from `useMember().code`) and `useBalance` (checkbox shown when `profile.wallet >= quote deposit`).
- Photos upload to the `uploads[i].signedUrl` with `fetch(uri)` → blob → `PUT`.

- [ ] **Step 1:** Failing reducer tests: `ADD_CAR caps at 6`, `REMOVE_CAR keeps at least 1`, `SET_CAR_FIELD updates one car`, `prefill from saved car sets vehicleType/year/make`. Run them. Expected: FAIL.
- [ ] **Step 2:** Implement the reducer. Run jest. Expected: PASS.
- [ ] **Step 3:** Implement the screens. Run `cd bld-app && npx tsc --noEmit`. Expected: clean.
- [ ] **Step 4: Simulator against the local backend.** Point `EXPO_PUBLIC_SUPABASE_URL` at the live project; the local server does not speak supabase-js, so use live `detail` only after Task 9 deploys. Before that, smoke-test the UI only.
  - Run `npx expo start --ios` on iPhone 17 Pro.
  - Expect: screens render, the price updates per car, no red box.
- [ ] **Step 5:** Commit the listed `bld-app` files (explicit list) with message `feat: app books through detail with several cars and new member plans`.

### Task 9: Ship and prove (each live step needs the owner's yes)

**Files:**
- Modify: `scripts/e2e-detail.mjs` (new steps), `README.md` (app section, member rules)

- [ ] **Step 1: Extend the E2E script.** All rows use the email prefix `e2e-detail-`. New steps:
  - `two-car sum`: 510 / 70
  - `member visit covered`: test gold member code, sedan full → payable 0
  - `bump race`: guest holds 10:00 unconfirmed; gold test member reserves 10:00 → guest moved to the next open slot; the dashboard shows the note
  - `confirmed is not bumpable`: owner confirms the guest; gold reserves → `slot_taken`
  - `release frees visit`
  - `balance deposit`: test account +$50 test balance → `deposit_status 'paid'`, `detail.test=true`
  - `invoice pay balance`
  - `stamps awarded on pay`
- [ ] **Step 2 (owner yes):** Apply 0017 via `apply_migration` to `fiaadogbkvjcddehnymj`. Then:
  - `list_migrations` shows 0017.
  - `get_advisors` shows no new security errors.
- [ ] **Step 3 (owner yes):** Deploy `detail`, `admin`, `member`, `topup`, `book` (file-content deploy via MCP with the `_shared` files).
  - Probe: POST `detail` `{action:'config'}` returns `membership.gold.rank === 3`.
  - Run the live E2E: all steps PASS.
  - Read function logs: no errors.
- [ ] **Step 4:** Simulator, live backend: book 2 cars as a guest; log in with the test gold code; book with an included visit; see both in the live dashboard; pay Cash; check stamps went up. Screenshots go to the scratchpad.
- [ ] **Step 5 (owner yes):** Run `vercel deploy --prod` from branch `app-sync`. Then re-run the visible-Chrome live test with the 2-car booking. Expected: PASS.
- [ ] **Step 6 (owner yes):** Delete test rows by email prefix. Reset the test member's stamps and balance to their prior values (record them before step 3). Expected: live counts back to the pre-test values.
- [ ] **Step 7:** Update the memory files `project-bld-starting-prices-live.md` (new state). Commit `README.md` and `scripts/e2e-detail.mjs` with message `docs: app sync launch notes; e2e covers cars, members, bumps`.

**Rollback:**
- Vercel: promote the previous deployment (record its id before step 5).
- Functions: redeploy from branch `starting-prices`.
- 0017 is additive. Its `detail_invoice_pay` replacement is the one non-additive part, so keep 0015's body in `scripts/rollback-0017.sql` (committed in Task 3).
