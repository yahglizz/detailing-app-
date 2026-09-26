# Brotherly Love Detailing — Prepaid Balance + Tier Perks Design

**Date:** 2026-09-25
**Status:** Approved by owner in brainstorming ("yes build everything out"). Built and tested locally; migrations 0011 + 0012 and the function deploys wait on the owner's go-ahead.
**Scope:** a prepaid account balance anyone can load and spend at checkout; tier perks that grow with the membership tier; member prices everywhere a price is shown; savings promoted at every checkout; a test-account switch for reviewing each tier's screens. Builds on the Stripe Checkout round (`2026-09-25-bld-stripe-checkout-my-cars-design.md`).

---

## 1. What this is

Customers load money onto their account through Stripe Checkout and spend it at checkout, where it pays first. Members get their own price on every detail, and the higher the tier, the better every perk: a bigger member discount, a bigger bonus on each top-up, and more reward stamps per car. Every checkout shows a member what the membership saved them; everyone else sees what the best tier would have charged.

**Success criteria:** the balance never goes negative and is never spent or credited twice, whatever order the app, the webhook and the sweep arrive in; a declined or refunded booking gives the balance back; a refunded top-up takes back what it added; the price the app shows is the price the server charges; the owner can flip one test account between NON-MEMBER / BRONZE / SILVER / GOLD to review every screen.

## 2. Decisions (owner)

| Decision | Choice |
|---|---|
| Perks | Member price (% off), top-up bonus (% extra), bonus stamps per car. |
| Loading | In the app, any whole-dollar amount (catalog range, default $10–$500). |
| Who | Everyone. Non-members get an account code (emailed) to see and spend their balance. |
| Promotion | Members see their price and "YOU'RE SAVING $X WITH TIER"; non-members see an upsell card with the best tier's price for this exact order. |
| Test account | The owner's test member switches tiers in-app; its bookings are flagged TEST to the owner. |

## 3. Tier perks (catalog, set by migration 0012)

| Tier | Member price | Top-up bonus | Stamps per car |
|---|---|---|---|
| Bronze ($79/mo) | 10% off | +5% | 1 |
| Silver ($99/mo) | 15% off | +10% | 2 |
| Gold ($199/mo) | 20% off | +15% | 3 |

Numbers live in `catalog.config.plans.<tier>` (`discountPercent`, `topupBonusPercent`, `stampsPerCar`) and `catalog.config.topup {min, max}`; change them there, no deploy needed.

## 4. Pricing (one pipeline, app and server)

All amounts are whole dollars; Stripe amounts are dollars × 100.

1. `memberPrice` (`_shared/membership.ts`): monthly credits cover their service → an issued reward applies (only if something is still payable) → the tier's discount on what is left. Returns `payable`, `memberDiscount` and `savings` (retail total − payable).
2. The slot anchor (+$10, bump-proof) is offered to non-members only.
3. `splitPayment` (`_shared/payments/checkout.ts`): the balance pays first, then the 25% deposit or the full rest goes on the card, and the remainder is paid at the detail.
4. `bestPlanFor` picks the tier a non-member would pay least with for this order (ties go to the cheaper plan); the upsell shows only when it beats what they pay now.

## 5. Data — migration `0012_balance_perks.sql` (apply after 0011)

- Catalog perks and top-up range (above).
- `wallet_ledger`: signed `delta`, `reason`, unique `ref` (every write is idempotent), optional `booking_id` / `topup_id`. A trigger rejects any insert that would make a customer's balance negative, serialized per customer with `pg_advisory_xact_lock`. The same per-customer lock was added to the existing credit and stamp triggers, which closes the same race there.
- `topups`: `amount`, `bonus`, `status` pending | paid | cancelled, unique `stripe_session_id` and `payment_ref`.
- `customers.code`: the account code for non-members (members keep `memberships.code`).
- `memberships.is_test`: true for `@bld.local` emails.
- `code_attempts`: failed code lookups, for rate limiting.
- RLS on for every new table, no policies (service role only).

## 6. Money lifecycles

**Booking with a balance.** `book` reserves the balance with a ledger row `{delta: −walletUsed, ref: book:<bookingId>}` before any card money moves; a conflict (the balance changed) returns 409 `balance_conflict` and the app re-reads and asks again. Nothing left to pay → booked at once. Otherwise the Stripe Checkout lifecycle from the previous round runs unchanged.

**Balance given back.** Every path that declines or refunds a booking (customer backs out, session expires, sweep, owner declines, 48h auto-refund) calls `restoreMemberBalances`, which returns the booking's balance first (ref `void:<bookingId>`, so a second call is a no-op), then credits and rewards. Emails say the balance was returned. The booking is already voided by then, so nothing would retry a failed give-back: if the balance or credit insert fails, the owner gets an "Action needed" email with the booking and amount.

**Top-up.** `topup` validates the amount, creates a `pending` row and a Checkout Session (`metadata.topup_id`). Paid → `fulfillTopup` (webhook or the app's `settle`, whichever is first) writes the ledger rows `topup:<paymentIntent>` and `topup:<paymentIntent>:bonus`, mints or finds the login code, claims pending → paid (or cancelled → paid, when the money arrived after the checkout expired), then emails the receipt with the login code. Not paid → `cancelTopup`. `sweep` settles top-ups still pending after 45 minutes.

**Top-up refunded** (from the Stripe dashboard) → the `charge.refunded` webhook takes back the refunded share of amount + bonus (from Stripe's cumulative `amount_refunded`, minus what earlier refunds already took), capped at the current balance; if the customer already spent it, the owner is emailed the shortfall. Each take-back's ref is `topup_refund:<id>:<dollars taken so far>`, so two refund events processed at the same moment collide and the second is retried by Stripe instead of taking the same share twice.

## 7. Backend files

| File | Change |
|---|---|
| `_shared/membership.ts` | `memberPrice`, `bestPlanFor`, `topupBonus`; plan perk fields; crypto-random `generateCode`. |
| `_shared/payments/checkout.ts` | `splitPayment`, `APP_LINK`. |
| `_shared/codes.ts` (new) | `resolveCode` (member or account code, rate limited), `freshCode`, `loginCode`, `clientIp`. |
| `_shared/wallet.ts` (new) | `walletBalance`, `fulfillTopup`, `cancelTopup`, `settleTopup`, `takeBackRefund`. |
| `_shared/booking_payment.ts` | Frozen quote carries `walletUsed`, `savings`, `test`; emails show balance used and savings; shared `settleCheckout`. |
| `_shared/member_refund.ts` | Restores the balance before credits and rewards. |
| `_shared/payments/provider.ts` | `createCheckout({kind: 'booking' \| 'topup', …})`. |
| `book` | Codes via `resolveCode`; member price; balance reservation; TEST flag. |
| `topup` (new) | Create a top-up checkout; `action: 'settle'`. |
| `member` | Rewritten: profile for members and balance accounts (`wallet`, `isTest`); `redeem` / `upgrade` members only; `test_tier` / `test_balance` for test accounts only. |
| `stripe-webhook` | Routes `metadata.topup_id`; handles `charge.refunded`. |
| `owner-members` | Stamps = cars × `stampsPerCar`; a `done` claim stops double-granting. |
| `confirm`, `sweep`, `e2e-setup`, `member_provision` | Balance in pages and emails; stale top-ups; test cleanup; "Log in with your code". |

## 8. App

- **Account screen** (`MemberDashboard.tsx`) for anyone with a code. Members: washes, savings, stamps (N per car), BALANCE card with ADD MONEY and their bonus %, rewards, plan card listing every perk, and the next tier's perks by the upgrade button. Non-members: BALANCE card plus JOIN THE BROTHERHOOD tier tiles. The footer shows washes left or the balance.
- **Add money** (`TopUp.tsx`): $25 / $50 / $100 / $200 or any amount; the member bonus is previewed; guests type name + email ("the code is emailed there"). Stripe Checkout → settle → "+$X ADDED".
- **Checkout** (`Build.tsx`): member prices on every service tile and extra (retail struck through; covered services read INCLUDED); summary with regular price, "Your TIER price", discount, "From your balance −$W", due today, and a SAVING badge; footer "SAVING $S"; upsell card for non-members; "PAY WITH BALANCE" when the balance covers it; members book 30 days out.
- **Home / log-in**: MEMBERS & BALANCE entry, ADD MONEY TO A BALANCE link, tier tiles with perks (`JoinTiers.tsx`).
- **Booked**: "Paid from your balance.", "You saved $S with your membership.", stamps earned.

## 9. Test account (`TestTierSwitch.tsx`)

Shown only when the server says `isTest`. Chips NON-MEMBER / BRONZE / SILVER / GOLD call `member {action: 'test_tier'}`, which updates only a membership with `is_test = true`; "+$50 TEST BALANCE" writes a ledger row. Real accounts get 403 `not_test`. Bookings from a test account are tagged `test: true` in the quote, and the owner's email subject starts "TEST ACCOUNT —".

## 10. Security notes and known limits

- Codes are `BLD-` + 6 crypto-random characters. Lookups are limited to 10 failures per IP per 15 minutes plus 300 failures across all IPs per 15 minutes; a flood of bad codes therefore pauses code logins for everyone for up to 15 minutes. The IP comes from `cf-connecting-ip`, then `x-forwarded-for`, then `x-real-ip`; Supabase does not document which one is trustworthy.
- A guest top-up never reveals a code in the app; the code only goes to the email typed. Typing someone else's email just gifts them money.
- The balance cannot be cashed out or transferred in the app; refunds go through the owner's Stripe dashboard.
- The test code `BLD-7QHMVZ` is public. It can add play money and switch tiers, but it cannot pay anyone, and every booking it makes is flagged TEST to the owner.
- Balance never expires in code. Whether to promise that to customers is a business and legal call, so the app doesn't claim it.

## 11. Stripe setup (owner)

On the existing webhook endpoint (`…/functions/v1/stripe-webhook`), add the event **`charge.refunded`** (keep `checkout.session.completed` and `checkout.session.expired`). No new keys.

## 12. Deploy order

1. Apply migration 0011, then 0012.
2. Deploy `book`, `member`, `topup` (new, default JWT verification), `confirm`, `sweep`, `owner-members`, `e2e-setup`; deploy `stripe-webhook` and `checkout-return` with verify_jwt=false.
3. Add `charge.refunded` to the Stripe webhook.
4. Do steps 1–2 in one sitting. The new screens need the new functions: the live `book` knows neither the checkout nor the balance contract. And once 0012's perks are in the catalog, the app shows member prices that only the new `book` charges.

## 13. Testing

- **Automated:** jest 48/48 across 8 suites (adds `memberPrice`, `bestPlanFor`, `topupBonus`, `splitPayment`). `tsc` is clean, and `deno check` + `deno lint` are clean on every changed function.
- **Simulator** (iOS). Run against a scratchpad-only mock of the new `member` response and the 0012 catalog, because nothing is deployed yet. All verified:
  - Every tier view: dashboard, plan perks, balance card, and JOIN tiles for non-members.
  - Checkout: Silver prices ($120 → $102, INCLUDED inside detail, struck retail on extras); summary −$20 balance → $21 deposit, $61 at the detail, "SAVING $18"; non-member upsell ("GOLD MEMBERS PAY $0 FOR THIS").
  - Top-up: Silver +10% preview ($50 → $55); guest form and its validation.
- **After deploy** (Stripe test mode, card 4242…):
  - Top up as a member and as a guest; check the receipt and code emails.
  - Book with a partial and with a full balance.
  - Back out of checkout and confirm the balance comes back.
  - Refund a top-up in Stripe and confirm the balance is taken back.
