# Brotherly Love Detailing — Booking App (Round 1) Design

**Date:** 2026-07-16
**Status:** Approved by owner (this document reflects decisions made in brainstorming)
**Scope:** Round 1 — customer books a mobile detail and pays a deposit; owner confirms via text link. Membership UI, owner app, routes, photos, and reviews are explicitly out of scope and will each get their own spec.

---

## 1. What this is

A mobile app (iPhone + Android, one Expo/React Native codebase) for Brotherly Love Ministry Detailing, a mobile car-detailing business in Philadelphia. A customer opens the app, taps one button, builds their detail (cars, sizes, services, extras), sees a live price, pays a percentage deposit by card, and requests a day + time window. The owner gets a text with a signed link to a plain mobile web page and taps Confirm, Propose new time, or Decline & refund. The customer is texted the outcome.

**Success criteria:** a stranger can go from app open to paid booking in under two minutes with no account created beforehand; the owner never has to call anyone to take a booking; no booking exists without its deposit state being known; the daycare Supabase project is never touched.

## 2. Decisions locked during brainstorming

| Decision | Choice |
|---|---|
| Platform | Expo / React Native, ships to App Store and Google Play from one codebase |
| Scheduling | Customer requests preferred day + window (Morning / Afternoon / Either); owner confirms or counters. No live calendar. |
| Catalog | Outside $45 / Inside $60 / Full $120 per car, plus extras: Ceramic $199, Headlight restoration $40, Engine bay $35, Pet hair/odor treatment |
| Vehicle sizing | Sedan / SUV / Truck-Van price tiers per car (multipliers stored in catalog; exact numbers set in config before launch) |
| Deposit | Percentage of total (percent value configurable in catalog config), always paid by card in-app. Remainder paid cash or card at the job. |
| Accounts | No signup to browse. Phone number + 6-digit SMS code at checkout only. Phone number is the customer identity. |
| Membership | Credits model ($/mo buys N details, tracked in an append-only ledger). **Round 1 builds the tables only — no membership UI.** Pricing numbers deferred. |
| Owner ops | SMS notification + signed-link mobile web confirm page. No owner app in round 1. |
| Backend | Supabase — a **new, separate project** (`brotherly-love-detailing`). The existing `blessings-daycare` project is never referenced, shared, or modified. Second project confirmed $0/month on current plan. |
| Payment processor | Deferred. All processor calls go through one payment-provider interface (charge deposit / refund / charge remainder). Stripe or Square chosen before launch; swapping never touches the app. |
| SMS | Twilio (owner notifications, customer confirmations, login codes) |

## 3. Customer screens

Five screens, linear flow:

1. **Home.** Logo, tagline, one dominant GET MY DETAIL button. Small member-login link at bottom (inert until round 2).
2. **Build your detail.** Single scrolling screen (no wizard): car count stepper (1/2/3+); per car a size picker (Sedan / SUV / Truck-Van) and service picker (Outside / Inside / Full); optional extras per car. A price bar is pinned to the bottom of the screen and updates live with every tap.
3. **When & where.** Address with autocomplete, preferred day picker, window picker (Morning / Afternoon / Either), free-text notes.
4. **Pay.** Line items, total, deposit amount (percentage), remainder "due at the detail" with a cash-or-card choice for the remainder. Phone number entry → 6-digit SMS code → card entry → pay deposit.
5. **Booked.** Confirmation, "We'll text you to lock in your time," summary, add-to-calendar.

Design language matches the existing website: near-black `#0E0D11` background, purple gradient `#7028C9 → #A855F7` primary actions, League Spartan for headings, existing BLD logo assets from the website folder.

## 4. Architecture

Three units, one job each:

**App (Expo/React Native).** Renders screens, builds the order object, shows client-side price estimates for responsiveness. Talks only to Supabase (database + edge functions). Never talks to the payment processor directly.

**Supabase project `brotherly-love-detailing` (new, dedicated).**
Tables:
- `customers` — id, phone (unique, the identity), name, saved addresses.
- `bookings` — customer id, line items (cars with size, service, extras) **with prices frozen as quoted at booking time**, address, preferred day + window, notes, deposit percent + amount, remainder payment preference (cash/card), status.
- `catalog` — services, extras, size multipliers, deposit percentage. Prices live here, not in app code, so price changes need no app-store release.
- `memberships`, `credit_ledger` — schema built and tested in round 1, no UI. Ledger is append-only (every grant or spend is a row; balance is the sum) so credits cannot drift or double-spend.

Booking status flow: `pending_payment → requested → confirmed → done → paid`, with `declined` and `refunded` as terminal branches.

**Edge functions (server-trusted logic).**
- `price` — computes the authoritative total from `catalog`. The app's displayed price is an estimate; the server price is charged. On mismatch the customer sees the updated price before any charge.
- `payments` — single module exposing charge-deposit / refund / charge-remainder. The only place processor SDK code lives.
- `notify` — Twilio SMS: owner on new request, customer on confirm/decline/refund, login codes (via Supabase phone auth).
- `confirm-page` — serves the owner's mobile web page at a signed, single-booking URL with three actions: Confirm, Propose new time, Decline & refund. No owner login.

**Data flow:** app builds order → `price` computes total → booking row created as `pending_payment` → deposit charged → processor webhook flips booking to `requested` → `notify` texts owner → owner taps link, chooses action → booking updated → customer texted.

## 5. Error handling

- **Deposit card declines:** booking stays `pending_payment`, clear retry message; abandoned `pending_payment` rows are cleaned up after 24h. No half-bookings visible to the owner.
- **App crashes after payment, before confirmation screen:** booking exists server-side before the charge; webhook still flips it to `requested`. Money is never taken without a booking record.
- **Owner declines:** deposit auto-refunded through the payments module; customer texted automatically.
- **Owner silent 24h:** reminder text to owner. **48h:** apology text to customer + automatic refund. Silence never keeps someone's money.
- **SMS code problems:** resend with 60-second cooldown; codes expire after 10 minutes.
- **Stale catalog in app:** server price is authoritative; any difference is shown to the customer before charging. No surprise charges, ever.

## 6. Testing

- **Unit tests** on money paths: `price` across every size × service × extras combination; deposit percentage math; `credit_ledger` invariants (never negative, no double-spend) even though the UI ships later.
- **Fake-payment mode:** the payment-provider interface ships with a test implementation so the entire flow — booking, webhook, owner text, confirm page, refund — runs end-to-end with test cards before a processor is even chosen.
- **Owner acceptance test:** app installed on the owner's phone via Expo; owner books a fake detail, receives the real SMS, confirms via the link. Store submission only after this passes.

## 7. Explicitly out of scope (future specs)

- Membership signup, recurring billing, credit-spending UI (round 2 — tables already exist)
- Owner app / jobs dashboard beyond the confirm page
- Live calendar slots, route planning, drive-time logic
- Before/after photos, reviews, referrals, push-notification marketing
- Payment processor selection (decision gate before launch; interface already isolates it)

## 8. Open items to settle before launch (config, not design)

- Deposit percentage value
- SUV and Truck-Van price multipliers
- Membership pricing (round 2)
- Payment processor choice (Stripe recommended: strongest card-on-file + subscriptions)
