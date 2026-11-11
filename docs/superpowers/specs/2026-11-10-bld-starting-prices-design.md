# Starting-price booking: five services, vehicle pricing, flat deposit, inspection invoice

Date: 2026-11-10. Status: DRAFT, waiting for owner approval. Nothing built.

## Intent

Brotherly Love Detailing travels to customers in Delaware and the Philadelphia area. Today the
website shows a visual-only cart and three "package" cards at old prices, while the real pricing
lives in the Supabase `catalog` row (3 services x size multiplier, 25% deposit) and is used by
the Expo app and the `book` function.

The owner wants customers to see simple "Starting at" prices, pick a package, describe their
vehicle, choose a time, and pay a small flat deposit that is credited to the final bill. The
real price is set in person after the owner inspects the vehicle. The owner needs a way to
finish that job in the dashboard: adjust the price, add extras the customer approves, apply the
deposit, and mark the invoice paid.

## Goals

1. One price table (5 services x 3 vehicle types) and one deposit table (3 vehicle types), stored
   once in the `catalog` row, read by the website, the booking function and the dashboard.
2. Website: five pricing cards (Exterior Wash $40, Interior Refresh $80, Interior Deep Clean $150,
   Full Detail $175 "Most Popular", Premium Full Detail $260) with a short inclusion list, a
   duration estimate and Book Now.
3. A step flow: Package, Vehicle, Address, Appointment, Review, Deposit, Confirmation.
4. Server computes every number. The browser only displays what the server agrees with.
5. Owner dashboard: review booking and photos, set final price, add approved extras, record
   customer approval, apply deposit credit, see balance, mark paid.
6. Update README.md and CODEX-PROMPT.md so they describe the new pricing and flow.

## Non-goals (decided with the owner on 2026-11-10)

- **No travel fees and no distance lookup.** No maps API, no business start address setting.
  The owner said not to worry about distance pricing. The ZIP is collected and stored only.
- **Expo app and memberships are untouched.** Bronze/Silver/Gold, stamps, rewards, slot anchor,
  wallet, and the app's `book`/`price` functions keep the old catalog keys and keep working.
- **No real card charges.** Deposit payment is a labelled demo flow. Real Stripe is a later task.
- No multi-vehicle booking in one checkout (one vehicle per booking).
- No automatic surcharge from interior condition or pet hair. Both are saved for the owner only.

## Anti-goals

- A deposit ever shown as "paid" without a confirmed payment. Demo deposits are stored as
  `demo` and labelled "Demo, no money taken" everywhere, including the owner dashboard.
- Two different prices for the same thing on different screens.
- Charging more than the customer approved.

## Constraints

- Code and installs live on /Volumes/AgentDrive. Supabase project is the detailing one
  (`fiaadogbkvjcddehnymj`). Never touch another business's project or Stripe account.
- Reuse what exists: `catalog` table, `day_states` / `booked_slots` calendar, `time_slot` column,
  guest customer upsert by email, Resend/notify emails, admin dashboard shell (`admin/app.js`),
  the website's brand tokens (obsidian + violet, League Spartan / Hanken Grotesk).
- Website is one static file, `Brotherly Love Detailing.dc.html`, plus Vercel. Deploy with
  `vercel deploy --prod`. The Supabase migration and function deploy are live writes and need
  the owner's go.
- No new npm dependencies.

## Design

### Pricing config (single source of truth)

Add one key to `catalog.config`: `detailPricing`. Old keys stay for the app.

```
detailPricing: {
  vehicleTypes: { sedan: "Sedan", suv: "SUV / Truck", large: "Large SUV / 3-Row" },
  deposits:     { sedan: 25, suv: 35, large: 45 },
  services: {
    exterior: { name, blurb, includes[], duration, popular:false, prices:{sedan:40, suv:50,  large:60}  },
    refresh:  { ... prices:{sedan:80,  suv:95,  large:110} },
    deep:     { ... prices:{sedan:150, suv:175, large:200} },
    full:     { ... popular:true, prices:{sedan:175, suv:205, large:235} },
    premium:  { ... prices:{sedan:260, suv:295, large:335} }
  }
}
```

Inclusion lists and durations are the builder's first draft (marked in the file as "owner to
confirm"). The owner edits them and prices in the dashboard Pricing tab.

A pure module `supabase/functions/_shared/detail_pricing.ts` exports
`startingPrice(cfg, service, vehicle)`, `depositFor(cfg, service, vehicle)` (= min(deposit,
starting price)) and `quoteDetail(...)` returning `{ startingPrice, deposit, balance }` in
dollars as integers. The website reads the same config from the public `catalog` read; it never
hardcodes a price. Jest tests import the module the same way `pricing.test.ts` does.

### Data

Migration `0015_detail_booking.sql`:

- `catalog.config` gets `detailPricing` (jsonb merge, old keys untouched).
- `bookings` gets `detail jsonb` (full name, phone, vehicle year/make/model, vehicle type,
  service, interior condition, pet hair, water, power, ZIP, special instructions, photo paths),
  `deposit_status text` (`pending` | `demo` | `paid` | `refunded`, default `pending`), and
  `flow text` (`detail_v2` for new rows, so the app's rows are never mixed up).
- New table `booking_invoices`: `booking_id` (unique), `service_price`, `extras jsonb`
  (name, price), `customer_approved_at`, `approved_note`, `deposit_credit`, `total`, `balance`,
  `status` (`draft` | `approved` | `paid`), `paid_at`, `paid_method` (`cash` | `card`).
  RLS on, no public policies. Only the service role (edge functions) touches it.
- Storage bucket `booking-photos`, private. Customer uploads through short-lived signed upload
  URLs issued by the function: max 4 images, 5 MB each, jpeg/png/heic.

### Edge functions

New function `detail` (the app's `book` and `price` are not changed):

- `quote` (no side effects): validates service + vehicle, returns startingPrice, deposit,
  balance. The website calls this on every change so the number shown is the server's.
- `availability`: wraps existing `day_states` + `booked_slots` for the date picker.
- `reserve`: validates every field, re-computes price and deposit, checks the day is open and
  not full and the slot is free (same checks `book` makes), inserts the booking with status
  `pending_payment` and `flow='detail_v2'`, returns photo upload URLs.
- `pay-demo`: only works while `app_config.payments_mode = 'demo'`. Sets `deposit_status='demo'`,
  status `requested`, sends the owner email and the customer confirmation. Never writes `paid`.
  The real provider path later writes `paid` only from a confirmed Stripe webhook/settle.
- Existing sweep job: unpaid `pending_payment` detail bookings expire and free the slot.

The `admin` function gains actions: `detail_booking_get` (booking + signed photo URLs + invoice),
`invoice_save` (service price, extras), `invoice_approve` (records customer approval, note and
time), `invoice_pay` (requires approval; one database transaction, `detail_invoice_pay` in migration 0015; sets total, applies
`deposit_credit` only when `deposit_status` is `paid`, computes balance, marks paid with method). The Pricing
tab saves `detailPricing` with validation (whole numbers, positive, every cell present).

Double booking: the slot check plus a unique partial index on
`(preferred_day, time_slot)` for non-declined `detail_v2` rows closes the race that the old
`book` function documents as an accepted risk.

### Website (`Brotherly Love Detailing.dc.html`)

- The `services` section (cart cards) and the one-time package cards inside `packages` are
  replaced by one "Pricing" section with the five cards. The membership block in `packages`
  stays as is. Nav anchors keep working.
- The visual-only cart and checkout panels are replaced by the step flow in a full-screen panel
  on mobile and a two-column layout on desktop. A summary column is sticky on desktop; on phones
  a compact bar with package, vehicle type and "Starting at $X . Deposit $Y" is pinned to the
  bottom. The disclaimer text from the brief appears on the pricing section, the review step,
  and the confirmation.
- Fields and validation follow the brief. Water/power "No" does not block: it shows a plain
  note and is flagged for the owner (builder's call).
- Demo payment screen carries a visible "Demo payment, no card is charged" label and a button
  named for what it does.
- Brand: existing tokens only, no new fonts, no emoji.

### Dashboard (`admin/`)

- Booking detail for `detail_v2` rows gets an "Inspection and invoice" panel under the existing
  details: customer's choices (condition, pet hair, water, power, notes), photo grid, then
  final service price, extras list, "Customer approved" checkbox with note, deposit credit,
  balance, and a Mark paid button that stays disabled until approval is recorded.
- Pricing tab gets a "Detail pricing" editor for the 5 x 3 table, the deposit row, and the
  inclusion/duration text.
- Bookings list shows a "Demo deposit" badge for demo rows.

### Left to the builder

Exact copy for inclusion lists, card layout details, empty/error states, email wording
(humanizer pass before the owner sees any customer-facing text), test fixtures.

## Testing

- Jest: all 15 price cells, all 3 deposits, deposit cap (service cheaper than deposit), balance
  maths, bad service/vehicle input rejected.
- Live E2E `scripts/e2e-detail.mjs` against the detailing Supabase project: quote for every
  cell, reserve + pay-demo, slot clash returns 409, closed day returns 409, tampered price is
  ignored, invoice cannot be paid before approval, deposit credit and balance are correct, no
  booking ever reaches `deposit_status='paid'` in demo mode.
- Browser check of the website at 390 px and 1280 px: cards, each step, sticky summary,
  error messages, keyboard order.
- Existing app tests (`npx jest`) and typecheck must still pass untouched.

## How detail bookings fit the existing code (builder check, 2026-11-10)

A fresh reader checked this doc against the repo. Fixes and decisions:

- **Demo switch.** `app_config.payments_mode` did not exist. Migration 0015 seeds it as `'demo'`.
  `pay-demo` fails closed: it runs only when the value is exactly `'demo'`, otherwise 503.
  A Stripe key being present does not turn on real charges; the owner flips this row later.
- **Existing NOT NULL columns.** A `detail_v2` row sets `items = [{service, vehicle}]`,
  `quote = {total, deposit, remainder}` (starting price until the invoice is saved, then the
  final numbers, so every existing dashboard view shows the same price as the invoice),
  `address` = street + ZIP, `time_window` derived from the slot (before noon = morning, else
  afternoon), `remainder_method = 'cash'` as a placeholder that `invoice_pay` overwrites with
  the real method. `invoice_save` and `invoice_pay` write the final numbers back into `quote`.
- **Phone and name.** No phone column exists (`customers` is keyed by email). Phone and the
  name typed on this booking live in `bookings.detail`; an existing `customers` row is never
  renamed (anyone can type any email), a new row gets the name. The dashboard shows
  `detail.name` for these bookings. Owner email and dashboard read `detail.phone`.
- **Sweep.** `detail_v2` rows are skipped by the 24h reminder and the 48h auto-refund (a demo
  deposit has nothing to refund and the owner confirms these by hand). Unpaid `pending_payment`
  detail rows get their own branch: declined after 45 minutes through the existing
  `declinePending`, which frees the slot. Edits to `sweep` are limited to those two branches.
- **Status flow.** `pay-demo` sets `requested`. Owner confirms a time and marks done with the
  existing actions. `invoice_pay` requires a recorded approval and a status of `confirmed` or
  `done`, then sets `paid`.
- **Double booking.** The unique partial index covers `detail_v2` rows not in
  (`declined`, `refunded`). `reserve` also checks `booked_slots` against every row, app rows
  included. Detail rows already count toward `day_states` capacity because it counts all
  bookings. No member rank or bump logic applies to detail rows.
- **Booking window.** Detail flow allows 14 days ahead, stored as
  `detailPricing.bookingWindowDays` (builder's call; the app's 7-day public window is unchanged).
- **Pricing save.** `validateCatalog` in `_shared/admin_rules.ts` only handles listed keys and
  copies the rest. A separate `detail_pricing_save` admin action validates `detailPricing`
  (whole numbers, all 15 cells, 3 deposits) and does not call `syncPlanPrices`.
- **Test location.** Jest tests live in `bld-app/__tests__/` and import the shared module by
  relative path, as `pricing.test.ts` does.

## Security review changes (2026-11-11)

An automated review of the first `detail` function flagged three issues; all fixed before any deploy:

- Existing customer names can't be overwritten by a new booking (see above).
- Abuse caps: 5 requests per email and 10 per IP per rolling hour, counting every status,
  enforced atomically in the same insert trigger as capacity. The IP comes only from
  `cf-connecting-ip`; if that header is ever absent the IP cap is skipped (to verify at
  go-live: stored `ipHash` values must differ between callers). The
  public endpoint sends no email to the customer; only the owner is emailed, and the customer
  is emailed when the owner confirms a time. Email verification / captcha is not built.
- Capacity is enforced atomically by a `bookings` insert trigger (advisory lock per day) in
  migration 0015, behind the function's friendlier pre-checks. App bookings (`book`) don't take
  that lock, so an app booking racing a website booking for the last opening is still possible.

## Independent review changes (2026-11-11)

A fresh Opus review of the whole branch found no blockers in the SQL. Fixed before any deploy:

- **A demo deposit is not credited.** No money was taken, so the owner collects the full total;
  crediting it would under-collect $25-$45 on every booking made in demo mode. The deposit is
  credited only when `deposit_status = 'paid'` (reversible: one line in `detail_invoice_pay` and
  `depositCreditOf`). If a deposit ever exceeds the final total the dashboard shows `refundDue`.
- **Paying an invoice is atomic.** `detail_invoice_pay` locks the booking and invoice rows, writes the
  invoice, payment and booking status in one transaction, and a trigger makes a paid invoice read-only.
- **App members can't bump website bookings.** Detail rows are inserted `anchored = true`, which the
  existing bump rules already treat as unbumpable (no change to `book`).
- **No booking a time that has passed:** today's start times need a 2-hour lead (Eastern).
- Photo upload URLs stay aligned with the files; closing the dialog on the deposit step releases the
  hold (`release` action); the IP in the abuse-cap hash is keyed (HMAC); the calendar shows the name
  typed on the booking.

**Known limit, must be solved before the site is public in demo mode:** a bot can fill the calendar.
The per-email and per-IP caps slow it, but random emails and a few IPs can still hold most slots, and
`pay-demo` needs no real payment (it also emails the owner each time). Real Stripe deposits fix this
by construction; until then add Turnstile/captcha or email verification on `reserve`, or keep the
booking flow off the public site.

## Calls made without the owner (check these)

1. The brief's $100 minimum for Exterior Wash under $80 sits inside the travel-fee section, so
   it is skipped with travel fees. One config number and one check to add back.
2. One vehicle per booking.
3. Water/power "No" warns and flags, does not block.
4. Inclusions and durations are drafts.
5. Photos: 4 max, 5 MB each, private bucket.
6. "Customer approval" is recorded by the owner in the dashboard (name/note + timestamp), not
   by the customer clicking a link.

## Owner answers (2026-11-11) — design APPROVED

1. Instant-quote section ("Your price in seconds"): keep the section and its lead capture,
   re-price it from the new table (service x vehicle type, shown as "Starting at"), and
   **drop the first-wash percent discount**. Old size multipliers go away on the website.
2. The $100 Exterior Wash minimum is dropped for now, with travel fees.

## Known mismatch after this ships

The Expo app and members still use the old prices (Outside $45, Inside $60, Full $120 x size
multiplier). Website and app will show different prices until the app is moved over.
