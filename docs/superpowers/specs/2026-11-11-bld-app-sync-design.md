# BLD App Sync + Multi-Car + Re-priced Memberships — Design

Date: 2026-11-11. Status: draft, waiting for owner approval.
Builds on: `2026-11-10-bld-starting-prices-design.md` (website starting-price flow, live since 2026-11-11).

## Intent

The website, `detail` edge function and dashboard were rebuilt around starting prices (5 packages x 3 vehicle types, demo deposits, one-tap dashboard). The Expo app (`bld-app/`) still runs the old catalog ($45/$60/$120 x size multipliers), the old `book` checkout and the old $79/$99/$199 plans. The owner wants one business, one set of prices, one booking system: the app must show and book exactly what the website shows and books, keep its member features re-priced onto the new Bronze/Silver/Gold plans, and both app and website must let a customer book several cars in one visit.

## Goals

1. App books through the `detail` function (same as the website): 5 packages, vehicle type, year + brand, condition, pet hair, optional photos, address, contact, day + time, review, demo deposit, confirmation reference. App bookings land in the dashboard's one-tap job view (Confirm time, Cash/Card).
2. Multi-car (1–6 cars per booking) on the app AND the website.
3. App shows the same pricing cards, disclaimer and Bronze/Silver/Gold plan cards (price by vehicle, included visits, worth/save, perks) as the website, read from the same server config.
4. Member features kept and re-priced onto the new plans: code login, included monthly visits, % off, reward stamps + rewards, prepaid balance (+ tier bonus), VIP slot bumping.
5. Owner activates memberships by hand in the dashboard (no card charged for memberships yet).

## Non-goals

- Real Stripe for deposits or membership billing (stays demo / later). Old Stripe join links stay unlinked.
- Member code entry on the website (website stays guest-only; members book in the app).
- Slot Anchor (dropped).
- App Store / TestFlight submission.
- Removing the old `book`, `price`, `checkout-return` functions (the app stops calling them; they stay deployed).

## Anti-goals (failure even if it "works")

- App and website showing different prices or plan details for the same thing.
- A price computed on the device being trusted by the server.
- A bumped customer silently losing their booking with no record in the dashboard.
- Demo money (demo deposit, demo top-up) ever counted as paid or as spendable balance.

## Decisions made by the owner (verbatim intent)

| Topic | Decision |
|---|---|
| App booking path | Same as website (`detail` function) |
| Member extras | Keep, re-priced |
| Cars per booking | Multi-car, and add "add a car" to the website |
| Done means | iPhone simulator + live end-to-end test, no store submission |
| Multi-car calendar | One time slot for all cars |
| Multi-car deposit | Sum of each car's deposit ($25/$35/$45, each capped at that car's price), all credited to the final bill |
| Unused visits | Expire each billing month |
| Joining | Customer taps "Ask about <plan>"; owner agrees price and activates the membership in the dashboard; customer gets a member code |
| Extras kept | Reward stamps, prepaid balance, VIP slot bumping. Slot Anchor dropped |
| Which cars visits cover | Any car up to the plan's vehicle size; a bigger car pays only the price difference; other cars get the member % off |
| What VIP bumping may move | Only bookings not yet confirmed by the owner (`pending_payment`, `requested`), website guests included. Once the owner taps "Confirm this time" the booking is locked |
| Member price at the job | Per car. Owner can change each car's price; a car covered by an included visit stays $0; extras (incl. on covered cars) and every uncovered car get the member % off the final price |

## The how

### Pricing (server, `_shared/detail_pricing.ts`)

- `quoteDetail` grows to take `items: {service, vehicleType}[]` (1–6). Per line: `startingPrice`, `deposit` (existing `depositFor`, capped at line price). Totals: `subtotal` = sum of lines, `deposit` = sum of line deposits.
- Membership plan config (`detailPricing.membership.<tier>`) gains three numbers, editable in the dashboard pricing editor: `rank` (bronze 1, silver 2, gold 3), `stampsPerCar` (1/2/3), `topupBonusPercent` (5/10/15). Also `discountPercent` (10/15/20) as a number instead of only inside the perk text. Seeds are the old plan values, which already match the new % off.
- New pure function `memberQuote(quote, plan, planVehicle, visitsLeft, reward)`:
  1. Included visits: for each service with visits left, cover lines of that service whose vehicle size <= plan vehicle size (sedan < suv < large); a line bigger than the plan size is covered for `price(line size) - price(plan size)` payable. When more lines qualify than visits left, cover the most expensive first.
  2. Issued reward (oldest unused): `percent25` = 25% off what is still payable; `freeWash` = the cheapest uncovered line free; `tireShine`/`miniSpray` = no price change (done at the job).
  3. Tier `discountPercent` off what is still payable.
  4. Returns `{payable, visitsUsed: {service: n}, rewardUsed, memberDiscount, savings}`. Deposit for a member = sum of line deposits of lines still payable, capped at `payable`; 0 when payable is 0.
- Rounding: whole dollars. Member % off and the 25% reward are applied together and rounded ONCE on the total (half up), identically in the quote (`memberQuote`) and the job invoice (`invoiceTotalsLines` / `detail_invoice_pay`), so the price quoted is the price billed (decided during the build; supersedes "round at each step").
- The device never sends a price; the server prices, and `reserve` refuses with `price_changed` (+ new quote) when the client's `expectedTotal` differs (same pattern as old `book`).

### Visits accounting

- `memberships` gains `vehicle_type` (`sedan|suv|large`, default `sedan`). The 2 existing gold rows get `sedan`.
- Billing month = monthly anniversary of `period_start`.
- Visits used this month are derived, not stored: sum of `visitsUsed` recorded on the member's non-declined `detail_v2` bookings whose `created_at` is in the current billing month. Visits left = plan visits - used. Unused visits vanish at the anniversary (owner decision: expire).
- `sweep`'s old monthly credit grant into `credit_ledger` is left alone; nothing in the new path reads `credit_ledger`.

### Booking (`detail` function)

- `reserve` accepts `items[]` (1–6) of `{year, make, vehicleType, service, condition, petHair}` plus the existing address/contact/day/slot/notes/photoExts. A single-car body in the old shape is still accepted (so the live website keeps working between backend and website deploys).
- Optional `memberCode`. When valid and active: member pricing above, `rank` from the plan, visits/reward recorded in `bookings.detail`, issued reward marked used on reserve. Invalid code → `invalid_code`.
- Optional `useBalance: true`: the deposit is paid from the prepaid balance (real money only; see balance) through the existing wallet ledger and its non-negative trigger; `deposit_status='paid'`, method `balance`. Not enough balance → falls back to the demo deposit step.
- Photos: 0–6 per booking total, same signed-upload path.
- Calendar: one slot per booking regardless of car count (owner decision). Day capacity counts bookings, unchanged.

### VIP bumping (`detail` function)

- Existing `decideBump(bookerRank, holder)` is reused. Holder rank comes from the booking's stored `rank` (0 for guests). No anchors anymore.
- `availability` returns per slot `{slot, taken, rank}` so the app can show VIP-takeable slots for a member; the website keeps showing taken slots as unavailable.
- On `reserve` into a taken slot: `bump` → the holder booking moves to the next open slot that day (`nextOpenSlot`); if none, the holder's `time_slot` is cleared and its status note says "bumped, needs a new time". `escalate` (same tier) → the new booking is saved with no slot, "we'll confirm your time". `blocked` → `slot_taken`.
- The move and the insert happen in one DB function (`detail_reserve_bump`) holding the existing day advisory lock, so the unique slot index can never fire mid-move.
- Every bump writes `detail.bumpedBy`/`detail.bumpedFrom` on the moved booking; the dashboard job view shows "Moved from 10:00 AM by a VIP booking". Email to the bumped customer goes through the existing notify path (dry-run until email keys are set).

### Stamps and rewards

- When the dashboard marks a member's job paid (`invoice_pay` → done), the member earns `stampsPerCar x cars` stamps automatically (existing reward ledger). The manual "+1 stamp" button stays.
- Reward menu and costs unchanged (tire shine 3, mini-spray 5, 25% off 8, free wash 10); redeem from the app's member screen as today.

### Prepaid balance

- `topup` function and app TopUp screen unchanged: real Stripe Checkout, tier bonus from `topupBonusPercent`. While Stripe is not configured it answers `payments_not_configured` and the app says "Online payments aren't switched on yet".
- Balance pays the deposit at booking (above) and the rest at the job: the dashboard payment card shows "Balance · $X" next to Cash/Card when the customer's balance covers the remaining total.

### App (`bld-app/`)

- `CatalogProvider` reads `detail` `config` (pricing, membership view, slots, today) instead of the `catalog` table.
- `Build` screen keeps its single-scroll look and sections but follows the website steps: Your cars (1–6; each year, brand, vehicle type, package, condition, pet hair; member saved cars prefill), Where (street, city, zip, "use my location"), When (14-day window and hourly slots from `availability`; VIP tags for members), You (name, phone, email; prefilled for members), Photos (optional, `expo-image-picker`), Review (server quote, member savings, disclaimer), Deposit (demo, or "Pay deposit from balance"), Booked screen with reference.
- Plan cards: vehicle toggle, price/mo, included visits, worth/save, perks; "Ask about <plan>" sends a lead to `quote_leads` (same as the website) and shows a thank-you.
- Member screens (code login, dashboard, settings, top-up, test tier switch) stay; they show visits left by service this month, stamps, rewards, balance, plan vehicle, history from the new `member` response. Saved cars use `sedan|suv|large` + year/brand.
- Removed from the app: old `book` checkout, Slot Anchor UI, old extras (ceramic etc.), old size labels, Stripe join links.

### Website

- Vehicle step: "Add another car" (up to 6), remove car, each car its own year/brand/type/package/condition/pet hair. Summary and sticky bar show per-car lines, total, summed deposit.
- Plan cards' perks text comes from config; owner-edited perks in the dashboard update both app and site.

### Dashboard

- Job view lists every car (year brand · type · package · condition · pet hair) with its line price; member lines show "Included visit" / "Member price"; bumped jobs show the move note.
- Payment card: total = sum of lines + extras - credited deposit; Cash/Card buttons as now, plus "Balance · $X".
- Members page: "Add a member by hand" and each row get a vehicle-type select; existing tier and active controls stay.

### Migration 0017 (additive)

- `memberships.vehicle_type text not null default 'sedan' check (vehicle_type in ('sedan','suv','large'))`.
- `detail_reserve_bump(...)` security-definer function, service_role only.
- `detailPricing.membership` merge adding `rank`, `stampsPerCar`, `topupBonusPercent`, `discountPercent` per tier.

## Corrections after the builder check (these override the sections above)

1. **Plan source of truth = `detailPricing.membership`.** Every reader of the old `catalog.config.plans` is repointed: `topup` bonus, stamps on done (`owner_actions.ts` markDone), member savings (`member/index.ts`), `member_add`/`member_tier`, test tier switch. Old `plans` stays in the config, unread. A member's monthly price = the config price for their plan vehicle size (no price column).
2. **Bumping:** new `detail_v2` bookings are stored `anchored=false` (today they are `true`, `detail/index.ts:147`); bump only touches holders with status `pending_payment|requested` (owner decision). Live DB has 0 bookings, so no existing row changes. Old Slot-Anchor bookings stay protected by the existing `anchored` check.
3. **`availability` stays compatible:** `taken` remains a string array (website `booking.js` uses `indexOf`); a new `holders: {slot: rank}` field is added for the app.
4. **Invoices per car:** migration 0017 adds `booking_invoices.lines jsonb` (`[{car, price, covered}]`) and `member_percent int default 0`. Total = round((sum of uncovered line prices + extras) x (1 - member_percent/100)) - credited deposit. Covered lines are fixed at $0. `invoice_save` edits line prices; `detail_invoice_pay` builds lines from the booking's quote when no invoice exists. Single-line invoices keep working (one line).
5. **Balance as a payment method:** migration widens `booking_invoices.paid_method` to `cash|card|balance`; `detail_invoice_pay(p_booking, 'balance')` debits `wallet_ledger` in the same transaction and raises `insufficient_balance` if short.
6. **Balance-paid deposit:** `reserve` with `useBalance` debits the wallet and the booking goes straight to `requested` (owner notified), skipping the deposit step, all in one DB function. If the balance is short, the booking takes the normal demo-deposit path.
7. **Test money:** `test_balance` already only works on `is_test` accounts. Bookings by `is_test` members are flagged `detail.test=true` and shown as TEST in the dashboard. Real customers' balances can only come from Stripe top-ups.
8. **Visits and rewards on abandoned holds:** visits used count bookings with status `pending_payment|requested|confirmed|done` (not `declined|refunded`), so an expired hold frees its visits automatically. An issued reward is marked used only when the deposit step completes (`pay-demo` or balance), not at `reserve`; if it was used elsewhere meanwhile, the deposit step answers `price_changed` with the new quote.
9. **Saved cars:** `large` added to saved-car sizes; existing `truck` values read as `suv` ("SUV / Truck"). Saved cars gain optional `year` and `make`.
10. **Small:** `expectedTotal` optional (website doesn't send it); photos stay max 4 per booking (`MAX_PHOTOS`); `expo-image-picker` installed with `npx expo install` (included in Expo Go, no custom build).
11. **Old `book` function:** returns `app_update_required` for new bookings so an old app build can never sell old prices; the `settle` action keeps working.

## Testing (how "done" is proven)

1. Jest: multi-car quote and deposit sums; `memberQuote` (visit coverage by size, bigger-car difference, most-expensive-first, expiry by billing month, reward order, % off, rounding); bump decisions incl. no next slot; `validateReserve` multi-car + old single-car shape.
2. `deno check` on every changed function; `tsc --noEmit` in the app.
3. Local stand-in backend (`scripts/local-server.mjs`) updated for multi-car so the website can be clicked through locally.
4. Live E2E script extended: 2-car guest booking (sum check), member booking with included visit, bump of a guest by a gold test member, balance-paid deposit (test account), dashboard pay → stamps added. Test rows removed after.
5. iPhone 17 Pro simulator: book 2 cars as a guest, log in as the test member, book with an included visit, see both in the live dashboard, mark paid; screenshots. Website: 2-car booking in a visible Chrome window against live. Clean up test data.
6. Deploy order: migration → functions (`detail`, `admin`, `member`, `sweep` if touched) → live E2E → website `vercel deploy --prod` → live browser test. Each deploy needs the owner's yes.

## Left to the builder

- Exact component split inside `Build.tsx`; copy and spacing within the existing app look.
- How the app stores the in-progress booking (extend the existing `order` reducer).
- Error copy per server error code, following the existing tone.

## Builder's calls (marked so the owner can check)

- Everyone books 14 days ahead (old app gave members 30). Matches the website.
- Most-expensive-first when visits can cover more cars than remain.
- `freeWash` reward frees the cheapest uncovered car.
- Old single-car request shape stays accepted.
- Member code is app-only.
- `detailPricing.membership` replaces the old `plans` as the only plan config.
- Balance-paid deposits skip the deposit step and go straight to `requested`.
- Old `book` refuses new bookings (`app_update_required`).
- Saved cars marked `truck` read as SUV / Truck.
