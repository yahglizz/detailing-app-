# Brotherly Love Detailing — Stripe Checkout + My Info / My Cars Design

**Date:** 2026-09-25
**Status:** Approved by owner in brainstorming. Built and tested locally; migration 0011 and the function deploys wait on the owner's go-ahead.
**Scope:** real booking payments through Stripe Checkout; a member Settings screen (My Info, My Cars); checkout autofill for members. Membership purchase (Round 3 Payment Links) and upgrades are unchanged.

---

## 1. What this is

A booking's money now goes through a Stripe-hosted checkout page built for exactly what the customer is buying (service, size and extras per car, day and time, address, member perks). The app opens it in an in-app browser sheet and never sees card data. Members save their name, service address and cars (name + size) in Settings; checkout fills them in and shows saved cars as one-tap chips.

**Success criteria:** a member with a saved car books and pays without typing anything but the day and time; a customer can pay a deposit or the full amount; no path charges a card without a booking, keeps money for a declined booking, or loses a member's credit or reward; no card data or Stripe secret touches the app or the repo.

## 2. Decisions (owner)

| Decision | Choice |
|---|---|
| Amount | Customer picks: 25% deposit now (rest at the detail, cash or card) or the full amount now. |
| Identity | No sign-in. Members are identified by their code; guests type name + email. |
| Saved cars | Name + size (Sedan / SUV / Truck/Van), up to 6 per member. |
| Checkout | Stripe Checkout (hosted page) opened with `expo-web-browser`; back to the app by deep link. |

## 3. Data — migration `0011_stripe_checkout_my_cars.sql`

- `customers.address text` and `customers.cars jsonb` (`[{name, size}]`): member settings.
- `bookings.stripe_session_id` (partial unique) and `bookings.pay_mode` (`deposit` | `full`).
- `payments.kind` allows `full`; partial unique index on `payments(provider_ref) where provider = 'stripe'`, so the webhook and the app's return record a payment once.
- `app_config` rows `stripe_secret_key` and `stripe_webhook_secret_test`, seeded empty. Empty key = online payments off (`book` answers 503 `payments_not_configured`).

## 4. Payment lifecycle

1. **`book`** validates the order (cars checked against the catalog, price, slot, booking window), inserts the booking as `pending_payment` (this holds the slot), and reserves the member's credits and reward before any money moves. A conflict returns 409 and nothing is charged.
2. Nothing due (credit covers it): fulfilled at once. Otherwise `book` creates a Checkout Session: card only, one line item describing the order, `customer_email` prefilled, `metadata.booking_id`, expiring in 35 min (Stripe's minimum is 30). Success and cancel URLs go through `checkout-return`, which redirects to the app.
3. **Paid** → `fulfillBooking`, run by whichever arrives first: the `checkout.session.completed` webhook or the app's `settle` call. An atomic `pending_payment → requested` claim makes it run once. It records the payment, re-decides the slot (bump, or escalate to the owner, since up to 35 minutes have passed), and emails owner and customer.
4. **Not paid** → `declinePending`: booking declined, slot freed, credits and reward handed back. Triggers: the customer backs out (settle expires the open session, then re-reads it in case they paid in that moment); the session expires (webhook); or 45 minutes pass with no answer (sweep).
5. **Owner declines, or the 48h unconfirmed auto-refund fires** → atomic `requested → refunded` claim, then a Stripe refund with idempotency key `refund_<payment_intent>`. If the refund fails, the status is reverted and nobody is told "refunded".
6. Money that arrives for an already-declined booking is refunded automatically.

## 5. Backend files

| File | Change |
|---|---|
| `_shared/payments/checkout.ts` (new, pure) | `amountDue`, `cleanItems`, `formatWhen`, `checkoutLine`, `SIZE_NAMES`. Shared with the app and jest. |
| `_shared/payments/provider.ts` | Stripe (`npm:stripe@17`, fetch client): create, get and expire sessions; refund. Key read from `app_config`. Replaces the fake processor. |
| `_shared/booking_payment.ts` (new) | `fulfillBooking`, `declinePending`, `settleBooking`, `refundBooking`. |
| `book` | Rewritten as above; `action: 'settle'` requires the booking id plus its session id. |
| `checkout-return` (new) | Redirects only to `exp://`, `exps://` and `bld://` links, so it can't be used as an open redirect. |
| `stripe-webhook` | Sends sessions carrying `metadata.booking_id` into the booking lifecycle; membership branch unchanged; accepts the live or test signing secret. |
| `confirm`, `sweep` | Real refunds via `refundBooking`; sweep also settles stale `pending_payment` bookings. |
| `member` | Profile includes `address` and `cars`; new `save_settings` action, validated by `cleanSettings`. |
| `_shared/notify.ts` | `esc()`: customer text in emails and on the owner confirm page is HTML-escaped. |
| `_shared/member_refund.ts` | Credits restored from the booking's own ledger rows, so calling it twice is safe. |

## 6. App

- **Settings** (`MemberSettings.tsx`, via a SETTINGS pill on the dashboard). Tab MY INFO: name, read-only email, service address, appearance, log out. Tab MY CARS: list, remove, and add (name + size). "Saved" appears only when the server confirms with `{ok}`.
- **Checkout** (`Build.tsx`):
  - On an untouched order, fills in the member's name, address and first saved car.
  - Each car shows YOUR CARS chips; the member's email is read-only.
  - HOW DO YOU WANT TO PAY? offers DEPOSIT $X / IN FULL $Y. The cash/card choice for the rest appears only while a balance remains.
  - The button reads CONTINUE TO PAYMENT, BOOK WITH CREDIT or CONFIRM BOOKING.
- **Pay flow:** `book` → `openAuthSessionAsync(checkoutUrl, returnUrl)` → `book {action: 'settle'}` → Booked screen ("Deposit paid." / "Paid in full." / "Booked with your membership.").
- Removed: the old Schedule and Pay screens, which held the in-app card form and had been unreachable since checkout became one page.
- `app.json` scheme `bld`; new dependencies `expo-web-browser` and `expo-linking`.

## 7. Security notes and known limits

- No card data in the app. Stripe keys live only in `app_config` (service role). The repo is public: never commit keys.
- `settle` requires the session id, which only the app that opened the checkout has.
- Known limit: booking needs no sign-in, so anyone can hold a slot for up to ~35 minutes by starting a checkout and walking away. Acceptable for now; add a per-IP or per-email rate limit if it's abused.
- Known limit: on Android, closing the browser while a payment is still processing makes the app settle at once, which expires the session. If the payment went through anyway, it is refunded automatically and the customer is shown "not booked".
- A guest who types a member's email books under that member's customer row, without membership perks. Guests never overwrite the name on an existing row.

## 8. Stripe setup (owner)

1. Start in test mode: put a test secret key (`sk_test_…`) in `app_config.stripe_secret_key`.
2. Stripe test mode → Developers → Webhooks → add endpoint `https://fiaadogbkvjcddehnymj.supabase.co/functions/v1/stripe-webhook` with events `checkout.session.completed` and `checkout.session.expired`. Store its signing secret in `app_config.stripe_webhook_secret_test`.
3. Going live: swap in a live key (ideally a restricted key with write access to Checkout Sessions and Refunds), and add `checkout.session.expired` to the existing live endpoint.

## 9. Deploy order

1. Apply migration 0011 first. The new functions read its columns, and `member` fails without them.
2. Deploy `book`, `member`, `confirm` and `sweep`; deploy `stripe-webhook` and `checkout-return` with verify_jwt=false.
3. `sweep` must be redeployed with the rest, or the old fake refund stays live. Its first run declines any stale `pending_payment` bookings left by the old flow.
4. Until step 2, Settings reports "Couldn't save", because the deployed `member` function doesn't know `save_settings`.

## 10. Testing

- **Automated:** jest 44/44 across 8 suites (checkout helpers, `cleanSettings`, order reducer, checkout screen deposit vs. full). `tsc` is clean, and `deno check` + `deno lint` are clean on every changed function.
- **Simulator** (iOS, Gold test member), all verified:
  - Settings: add and remove a car.
  - Checkout: autofill with the saved-car chip.
  - Deposit and in-full choices (screen only; no payment runs until deploy).
  - Light and dark modes.
- **After deploy** (test mode):
  - Pay a deposit with card 4242 4242 4242 4242: the booking becomes `requested`, a payment row is written, and both emails arrive.
  - Pay in full.
  - Back out: the booking is declined and the credit returned.
  - Owner declines: Stripe refunds the payment.
- **Follow-up:** `scripts/e2e-member.mjs` still uses the old signed-in, raw-card `book` contract and must be updated before its next run.
