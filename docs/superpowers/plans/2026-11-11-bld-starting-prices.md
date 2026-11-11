# Starting-Price Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five "starting at" services priced by vehicle type, a flat vehicle-based deposit (demo payment only), and an owner inspection-invoice flow, on the website, the Supabase backend and the admin dashboard.

**Architecture:** One config key `catalog.config.detailPricing` is the only price source. A pure TS module (`_shared/detail_pricing.ts`) computes every number; a new edge function `detail` (quote / availability / reserve / pay-demo) and new `admin` actions call it. The website and dashboard only render what those return. Old app/membership code is not touched.

**Tech Stack:** Supabase (Postgres, Deno edge functions, storage), Jest (in `bld-app/__tests__`), static HTML website (`Brotherly Love Detailing.dc.html`), Preact+htm admin (`admin/app.js`), Vercel.

**Spec:** `docs/superpowers/specs/2026-11-10-bld-starting-prices-design.md` (approved 2026-11-11). Read it first, including "How detail bookings fit the existing code".

## Global Constraints

- All paths under `/Volumes/AgentDrive/claude/brotherly-love-detailing/`. Temp/caches: `TMPDIR=/Volumes/AgentDrive/claude/_tmp`. Never write to the Mac disk.
- Supabase project `fiaadogbkvjcddehnymj` only. No other business's DB or Stripe account. Never print `bld-app/.env` or any key.
- Prices (dollars): Exterior Wash 40/50/60; Interior Refresh 80/95/110; Interior Deep Clean 150/175/200; Full Detail 175/205/235 (Most Popular); Premium Full Detail 260/295/335 (columns sedan / suv / large). Deposits 25 / 35 / 45. Deposit = min(deposit, starting price). Balance = starting price minus deposit.
- Vehicle labels: "Sedan", "SUV / Truck", "Large SUV / 3-Row". Service ids: `exterior`, `refresh`, `deep`, `full`, `premium`. Vehicle ids: `sedan`, `suv`, `large`.
- Disclaimer, verbatim, on pricing section, review step and confirmation: "Prices shown are starting estimates. Final pricing is confirmed after an in-person vehicle inspection. Your booking deposit is applied toward your final service total. Any additional charges must be approved before work begins."
- NOT built: travel fees, distance lookup, $100 exterior minimum, first-wash discount, multi-vehicle checkout, real card charges. Do not touch `bld-app/src`, `supabase/functions/book`, `price`, or membership code.
- Demo deposits are stored `deposit_status='demo'` and labelled "Demo, no money taken". Nothing but a future confirmed Stripe settle may write `'paid'`.
- Service area copy: "Delaware & Philadelphia area". Existing brand tokens only; no new fonts or dependencies; no emoji.
- Whole-dollar integers everywhere on the server. Customer-facing email/copy goes through the `humanizer` skill before the owner sees it.
- Live writes (migration apply, function deploy, `vercel deploy --prod`) happen only in Task 9 after the owner says go.

## Review Focus

1. Client sends its own price/deposit/total in `reserve` or `pay-demo` → ignored; server recomputes (Task 3 test).
2. Two requests for the same day+slot, or a closed/full/past/too-far day → second gets `slot_taken` / `day_closed` / `day_full` / `bad_day` (Tasks 1, 3).
3. `pay-demo` called twice, or on a booking not `pending_payment` → one transition, one email set, second call returns `not_pending` (Task 3).
4. Invoice edge numbers: extras with negative/NaN/huge price, service price 0, deposit credit larger than total → balance never negative, credit capped (Task 1 `invoiceTotals`, Task 5).
5. Service/vehicle ids like `__proto__`, `constructor`, empty string, wrong case → rejected, never priced (Task 1).

---

### Task 1: Pricing and validation core (pure TS)

**Files:**
- Create: `supabase/functions/_shared/detail_pricing.ts`, `supabase/functions/_shared/detail_booking.ts`
- Test: `bld-app/__tests__/detail_pricing.test.ts`, `bld-app/__tests__/detail_booking.test.ts`

**Interfaces:**
- Produces (`detail_pricing.ts`):
  - `type DetailService = 'exterior'|'refresh'|'deep'|'full'|'premium'`; `type VehicleType = 'sedan'|'suv'|'large'`
  - `interface DetailPricing { vehicleTypes: Record<VehicleType,string>; deposits: Record<VehicleType,number>; bookingWindowDays: number; services: Record<DetailService,{ name:string; blurb:string; includes:string[]; duration:string; popular:boolean; prices:Record<VehicleType,number> }> }`
  - `const DEFAULT_DETAIL_PRICING: DetailPricing` (prices above; `bookingWindowDays: 14`; includes/duration are drafts, each service has 4-5 `includes` and a duration string like "1 to 1.5 hours")
  - `isService(x: unknown): x is DetailService`, `isVehicle(x: unknown): x is VehicleType` (own-property check, so `__proto__` fails)
  - `startingPrice(cfg, s, v): number`, `depositFor(cfg, s, v): number`, `quoteDetail(cfg, s, v): { startingPrice:number; deposit:number; balance:number }`
  - `validateDetailPricing(next: unknown): { ok:true; value:DetailPricing } | { ok:false; error:string }` (all 15 prices and 3 deposits whole numbers 1-10000, exactly one `popular`, `bookingWindowDays` 1-60, non-empty strings, `includes` 1-8 items)
  - `invoiceTotals(i: { servicePrice:number; extras:{name:string;price:number}[]; depositCredit:number }): { total:number; credit:number; balance:number }` (credit = min(depositCredit, total); extras price whole 0-10000; throws `Error('bad_invoice')` on invalid numbers)
- Produces (`detail_booking.ts`):
  - `interface ReserveInput { name:string; phone:string; email:string; vehicle:{year:string;make:string;model:string}; vehicleType:VehicleType; service:DetailService; condition:'light'|'moderate'|'heavy'; petHair:boolean; day:string; slot:string; street:string; zip:string; water:boolean; power:boolean; notes:string; photoExts:string[] }`
  - `validateReserve(body: unknown, cfg: DetailPricing, today: string): { ok:true; value:ReserveInput } | { ok:false; error:string }`. Error codes: `missing_fields`, `bad_email`, `bad_phone`, `bad_service`, `bad_vehicle_type`, `bad_condition`, `bad_day` (not ISO, in the past, or beyond `today + bookingWindowDays`), `bad_slot` (not in `ALL_SLOTS` from `_shared/bump.ts`), `bad_zip` (5 digits), `bad_photos` (more than 4 or ext not in jpg/jpeg/png/heic/webp). Trims, caps name 60, notes 500, street 120. Ignores any price/deposit/total fields.
- Consumes: `ALL_SLOTS` from `_shared/bump.ts`.

- [ ] **Step 1: Write `detail_pricing.test.ts`.** Tests: every one of the 15 `startingPrice` cells equals the table above (loop over a literal expected matrix); `depositFor` returns 25/35/45 for `full` per vehicle; deposit cap: with a cfg whose `exterior.prices.sedan` is 20, `depositFor` is 20; `quoteDetail(full, sedan)` = `{175,25,150}`, `quoteDetail(full, large)` = `{235,45,190}`; `isService('__proto__')`, `('constructor')`, `('')`, `('FULL')` all false; `validateDetailPricing` rejects 0, 1.5, NaN, a missing cell, two `popular`; `invoiceTotals({servicePrice:200, extras:[{name:'Pet hair',price:30}], depositCredit:25})` = `{230,25,205}`; credit 500 on total 230 → credit 230, balance 0; negative extra price and NaN throw `bad_invoice`; the JSON between the `-- detailPricing:begin` and `-- detailPricing:end` markers in `supabase/migrations/0015_detail_booking.sql` (read with `fs`) deep-equals `DEFAULT_DETAIL_PRICING` (this test stays red until Task 2 — run it then).
- [ ] **Step 2: Write `detail_booking.test.ts`.** Tests: a fully valid body passes; each missing required field gives `missing_fields`; `"a@b"` gives `bad_email`; day yesterday, day 15 days out, `"2026-13-40"` give `bad_day`; slot `"08:00"` gives `bad_slot`; zip `"1234"` gives `bad_zip`; 5 photos gives `bad_photos`; body containing `price:1, deposit:1, total:1` yields a value with none of those keys.
- [ ] **Step 3: Run both; confirm they fail.** Run: `cd bld-app && npx jest __tests__/detail_pricing.test.ts __tests__/detail_booking.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 4: Implement `detail_pricing.ts` and `detail_booking.ts`** with the signatures above. Money is integer dollars; use `Object.hasOwn` for id checks.
- [ ] **Step 5: Run again.** Expected: all pass except the migration-marker test.
- [ ] **Step 6: Commit** `feat: detail pricing and booking validation core`.

### Task 2: Migration 0015

**Files:**
- Create: `supabase/migrations/0015_detail_booking.sql`

**Interfaces:**
- Produces: `bookings.flow text`, `bookings.detail jsonb`, `bookings.deposit_status text not null default 'pending' check in ('pending','demo','paid','refunded')`; table `booking_invoices(booking_id uuid primary key references bookings, service_price int not null default 0, extras jsonb not null default '[]', customer_approved_at timestamptz, approved_note text, deposit_credit int not null default 0, total int not null default 0, balance int not null default 0, status text not null default 'draft' check in ('draft','approved','paid'), paid_at timestamptz, paid_method text check in ('cash','card'), updated_at timestamptz not null default now())` with RLS on and no policies; unique partial index `bookings_detail_slot_once` on `(preferred_day, time_slot)` where `flow='detail_v2' and time_slot is not null and status not in ('declined','refunded')`; private bucket `booking-photos` (10 MB, jpeg/png/webp/heic/heif); `app_config` row `payments_mode='demo'` (`on conflict do nothing`); `catalog.config = config || jsonb_build_object('detailPricing', <json>)` where the JSON sits between `-- detailPricing:begin` and `-- detailPricing:end` comment lines and equals `DEFAULT_DETAIL_PRICING`.
- Consumes: `DEFAULT_DETAIL_PRICING` (Task 1) — print it with a throwaway script to paste the JSON.

- [ ] **Step 1: Write the migration** (idempotent: `if not exists`, `on conflict`). Header comment says it is applied to project `fiaadogbkvjcddehnymj` via MCP `apply_migration` once the owner approves.
- [ ] **Step 2: Re-run `detail_pricing.test.ts`.** Expected: the marker test now passes.
- [ ] **Step 3: Do NOT apply it.** Applying is Task 9.
- [ ] **Step 4: Commit** `feat: migration 0015 detail booking schema`.

### Task 3: `detail` edge function

**Files:**
- Create: `supabase/functions/detail/index.ts`, `scripts/e2e-detail.mjs` (written here, run in Task 9)

**Interfaces:**
- Produces: `POST /functions/v1/detail` JSON `{ action, ... }`, public (anon key like `book`). Responses `{ ...data }` or `{ error: <code> }` with status 400/409/503.
  - `quote { service, vehicleType }` → `{ startingPrice, deposit, balance }`
  - `availability { from, to }` → `{ days: day_states rows, slots: ALL_SLOTS, windowDays }`; `availability { day }` additionally `{ taken: string[] }` from `booked_slots`
  - `reserve { ...ReserveInput fields }` → `{ bookingId, quote:{startingPrice,deposit,balance}, uploads:[{path,signedUrl}] }`
  - `pay-demo { bookingId }` → `{ ok:true, demo:true }`; errors `payments_not_demo` (503), `not_pending` (409), `not_found` (404)
- Consumes: `validateReserve`, `quoteDetail` (Task 1); `declinePending` is not used here; `sendEmail`, `ownerEmail`, `adminLink`, `button`, `esc` from `_shared/notify.ts`; RPCs `day_states`, `booked_slots`.

- [ ] **Step 1: Write `scripts/e2e-detail.mjs`** (plain node, `fetch`, reads `SUPABASE_URL` and the anon key from `bld-app/.env` without printing them). Cases: quote for all 15 cells matches the matrix; `quote` with `service:'__proto__'` → 400; reserve a booking 3 days out at a free slot, with a body that also carries `price:1,deposit:1`; response quote is `{175,25,150}` for sedan full; a second reserve same day+slot → 409 `slot_taken`; reserve on a closed day → 409 `day_closed` (skip with a printed note if no closed day exists in the next 14 days); `pay-demo` → ok; second `pay-demo` → 409 `not_pending`; DB check through the `admin` function (`booking` action) that `deposit_status` is `demo`, never `paid`, and `quote.total` is 175. Output one PASS/FAIL line per case; exit non-zero on any FAIL. Tag test rows with `detail.notes = 'E2E TEST'` and have the script decline them at the end through `admin` action `decline`.
- [ ] **Step 2: Implement `detail/index.ts`.** `reserve` order: validate → read `catalog.config.detailPricing` (fall back to `DEFAULT_DETAIL_PRICING`) → `day_states` open and not full → `booked_slots` taken check (all rows) → upsert customer by email, set `customers.name` → insert booking: `flow:'detail_v2'`, `status:'pending_payment'`, `deposit_status:'pending'`, `items:[{service,vehicle:vehicleType}]`, `quote:{total,deposit,remainder:balance,balanceDue:balance,paidOnline:0}`, `address:"<street>, <zip>"`, `time_slot:slot`, `time_window` (before 12:00 = morning, else afternoon), `remainder_method:'cash'`, `confirm_token` as `book` generates it, `detail` jsonb (name, phone, vehicle, vehicleType, service, condition, petHair, water, power, zip, notes, photos: paths) → map the unique-index violation (`23505`) to 409 `slot_taken` → create signed upload URLs in `booking-photos` at `<bookingId>/<uuid>.<ext>`. `pay-demo`: read `app_config.payments_mode`, require exactly `'demo'`; conditional update `pending_payment → requested` with `deposit_status='demo'` (zero rows updated → `not_pending`); then email owner (subject starts "New detail request", body lists service, vehicle, time, address, water/power flags, condition, pet hair, "Demo deposit, no money taken", dashboard link) and customer (time requested, starting price, deposit credited toward final, the disclaimer; owner confirms the exact time).
- [ ] **Step 3: Typecheck** with `deno check supabase/functions/detail/index.ts` if deno exists; otherwise note it was not run and rely on Task 9 E2E.
- [ ] **Step 4: Commit** `feat: detail edge function and e2e script`.

### Task 4: Sweep branch

**Files:**
- Modify: `supabase/functions/sweep/index.ts` (pending query ~line 20, stale query ~line 44)

**Interfaces:**
- Consumes: `declinePending(db, id)` from `_shared/booking_payment.ts`.

- [ ] **Step 1:** Add `.or('flow.is.null,flow.neq.detail_v2')` to the `pending_payment` select and to the stale `requested` select so detail rows skip Stripe settle, the 24h reminder and the 48h auto-refund.
- [ ] **Step 2:** After that block, select `detail_v2` rows with `status='pending_payment'` and `created_at < now-45min` and call `declinePending` on each (try/catch with `console.error`, count into `settled`).
- [ ] **Step 3:** Re-read the diff: app rows (flow null) take exactly the old path. Commit `fix: sweep leaves detail bookings out of refund path, expires abandoned ones`.

### Task 5: Admin actions

**Files:**
- Modify: `supabase/functions/_shared/admin_rules.ts` (EVERYONE / OWNER_ONLY lists), `supabase/functions/admin/index.ts` (`BOOKING_COLS`, `shape`, `handlers`)
- Test: `bld-app/__tests__/admin.test.ts` (existing `ownerOnly` list at ~line 30)

**Interfaces:**
- Produces new actions: EVERYONE: `detail_get`, `invoice_save`, `invoice_approve`, `invoice_pay`; OWNER_ONLY: `detail_pricing_get`, `detail_pricing_save`.
  - `detail_get { id }` → `{ detail, depositStatus, photos:[signedUrl], invoice }` (invoice = row or a draft built from starting price)
  - `invoice_save { id, servicePrice, extras }` → invoice; resets `approved` back to `draft` and clears `customer_approved_at` when numbers change; mirrors `total` into `bookings.quote`
  - `invoice_approve { id, note }` → invoice with `customer_approved_at=now()`, `status='approved'`; `note` required, max 200
  - `invoice_pay { id, method }` (`cash|card`) → requires status `approved`, booking status `confirmed` or `done`, else `not_approved` / `not_open`; computes `invoiceTotals` with `depositCredit` = quote deposit when `deposit_status` in (`paid`,`demo`) else 0; inserts `payments` row (`kind:'remainder'`, `amount_cents=balance*100`, `provider:'manual'`, `status:'succeeded'`) when balance > 0; sets invoice `paid`, booking `status='paid'`, `quote.total`, `quote.balanceDue`
  - `detail_pricing_get` → `{ detailPricing }`; `detail_pricing_save { detailPricing }` → runs `validateDetailPricing`, merges into `catalog.config` via `saveCatalog`, no `syncPlanPrices`
- `shape` adds `flow` and `depositStatus`; `BOOKING_COLS` adds `flow, deposit_status, detail`.
- Consumes: `invoiceTotals`, `validateDetailPricing` (Task 1).

- [ ] **Step 1: Extend `admin.test.ts`:** `can('manager', 'invoice_pay')` true; `can('manager', 'detail_pricing_save')` false and the two pricing actions added to the `ownerOnly` array used by the existing loop. Run — Expected: FAIL.
- [ ] **Step 2: Add the action names** to `admin_rules.ts`; re-run — Expected: PASS.
- [ ] **Step 3: Implement the handlers** in `admin/index.ts` using the existing `db`, `json`, `bad`, `UUID`, `catalog()`, `saveCatalog()` helpers. Reject non-`detail_v2` rows with `bad('not_detail')`. Photo URLs: `createSignedUrl(path, 300)` per path, dropping errors. Extras: max 10, name 1-60 chars.
- [ ] **Step 4:** Add to `scripts/e2e-detail.mjs` (after the pay-demo cases): confirm the booking via `confirm`, `invoice_pay` before approval → `not_approved`; `invoice_save` price 200 + extra 30; `invoice_approve`; `invoice_pay cash` → balance 205 for sedan full (230 total minus 25 credit); `invoice_save` with extra price -5 → error; credit cap case via a service price of 20 (balance 0, credit 20).
- [ ] **Step 5: Commit** `feat: admin invoice and detail pricing actions`.

### Task 6: Dashboard UI

**Files:**
- Modify: `admin/app.js` (`SERVICE`/`carLine`/`itemsSummary` near lines 121-137; `BookingDrawer` ~454-545; `Pricing` ~905; `BookingRow` ~439), `admin/app.css` (only if a new class is unavoidable)

**Interfaces:**
- Consumes: actions from Task 5 via the existing `api(action, payload)` helper; existing `ActionButton`, `Icon`, `money`, `toast`, `toastErr`.

- [ ] **Step 1:** `carLine` / `itemsSummary` handle `{service, vehicle}` items: names from a new `DETAIL_SERVICE` map (Exterior Wash, Interior Refresh, Interior Deep Clean, Full Detail, Premium Full Detail) and `DETAIL_VEHICLE` map (Sedan, SUV / Truck, Large SUV / 3-Row).
- [ ] **Step 2:** In `BookingDrawer`, when `b.flow === 'detail_v2'` render an "Inspection and invoice" section after "Money": fetch `detail_get`; show phone, vehicle year/make/model, condition, pet hair, water, power, notes, photo grid (`<img>` from signed URLs, click opens full size); inputs for final service price (prefilled starting price) and an extras list (name + price, add/remove); read-only deposit credit line; total and balance computed with the same arithmetic as `invoiceTotals` for display only; "Save price" button; "Customer approved" with required note and "Record approval" button; "Mark paid" with Cash/Card select, disabled until approved, and the confirm text "Collect $X from the customer?". A "Demo deposit, no money taken" tag shows when `depositStatus === 'demo'`.
- [ ] **Step 3:** `BookingRow` shows the same tag for demo rows.
- [ ] **Step 4:** `Pricing`: add a "Detail pricing" card (owner only) with a 5 x 3 grid of number inputs, a deposits row, and per-service text for name, blurb, includes (one per line), duration, plus a "Most popular" radio and `bookingWindowDays`; Save calls `detail_pricing_save` and toasts the server's `bad_value` errors in plain words.
- [ ] **Step 5: Manual check** after Task 9 deploy: open `/admin`, find an E2E booking, walk Save → Approve → Mark paid. Commit `feat: dashboard inspection invoice and detail pricing editor`.

### Task 7: Website

**Files:**
- Modify: `Brotherly Love Detailing.dc.html` — replace `#services` (lines ~376-396) with a Pricing section; remove the `.pk-toggle` and `.pk-grid` blocks in `#packages` and retitle that section "Membership" (keep `.card.mb` and tiers untouched); replace the visual cart/checkout panels and their `<script>` (lines ~598-700) with the step flow; re-point the `#quote` section (lines ~491-535) and its JS (`IQ_*`, `iqPrice`, `iqInsert`, accept/decline handlers, `bldOff` uses in that code); service-area tag and the lede line

**Interfaces:**
- Consumes: public `catalog` read (`window.__BLD_CFG.detailPricing`, already loaded by the existing fetch near line 828 and announced by the `bld:cfg` event) and `POST /functions/v1/detail` (Task 3). A hardcoded fallback copy of `DEFAULT_DETAIL_PRICING` is used only until the catalog loads and is labelled as such in a comment.
- Produces: element ids kept stable for anchors: `#services` (nav still points here).

- [ ] **Step 1: Pricing section.** Five cards rendered from `detailPricing.services` into `#services`: name, large "Starting at $X" (sedan price), blurb, `includes` list, duration, "Most Popular" tag on the `popular` one, "Book Now" button (`data-service`). Disclaimer text under the grid. Reuse `.card`, `.btn`, `.tag`, `.feats` classes and the existing `assets/services/*.jpg` images (exterior, interior, full for the first three/four; no new images). Stack to one column at phone width.
- [ ] **Step 2: Step flow panel** (full screen on phones, two columns on desktop). Steps: Package → Vehicle (year, make, model, vehicle type, interior condition, pet hair yes/no) → Address (street, ZIP, water yes/no, power yes/no, optional special instructions, optional up to 4 photos) → Appointment (date from `availability`, slot buttons, taken slots disabled) → Review (all choices, starting price, deposit, balance, disclaimer; contact fields name/phone/email live here or on the Vehicle step — builder's call) → Deposit (demo screen with the visible label "Demo payment, no card is charged" and button "Reserve with demo deposit") → Confirmation (booking reference, summary, disclaimer, "the owner will confirm your exact time by email"). Every price/deposit/balance figure shown comes from a `quote` call made on each change of service or vehicle type; show the previous value dimmed with `aria-busy` while loading; on error show the server message in a `role="alert"` region. Water or power "No" shows an inline note and does not block. Sticky summary column on desktop; compact fixed bottom bar on phones with package, vehicle type, "Starting at $X · Deposit $Y". Focus moves to the step heading on each step; Escape and a Close button exit; fields have labels and `aria-describedby` errors. Photo flow: after `reserve`, `PUT` each file to its `signedUrl` before calling `pay-demo`; a failed upload shows a warning but does not block.
- [ ] **Step 3: Instant-quote section.** Chips become the five services plus Membership; size group becomes the three vehicle types; result shows "Starting at $X" (no strike-through, no percent-off text); remove the "New customers save 10%" lede; the accept/decline copy drops the first-wash sentence and says final price is confirmed in person; `quote_leads` insert sends `quoted_price = discounted_price = price`, `service` = service id, `size` = vehicle id. Leave the membership branch and the 15-second promo popup alone (promo popup copy is out of scope; flag it to the owner).
- [ ] **Step 4: Copy.** Replace the "PA · NJ · DE" tag with "Delaware & Philadelphia area". Leave the placeholder phone number alone and flag it to the owner (it reads like a fake number: (215) 555-0123).
- [ ] **Step 5: Verify in a browser** (Claude_Browser pane, read `anthropic-skills:built-in-browser` first) at 390 px and 1280 px against a local static server run from the repo root: cards, every step, sticky bars, error states, keyboard-only pass through the flow. Screenshots go under `docs/mockups/`. Full live booking is exercised in Task 9.
- [ ] **Step 6: Commit** `feat: website pricing cards and starting-price booking flow`.

### Task 8: Docs

**Files:**
- Modify: `README.md` (booking flow section, owner dashboard section, add "Starting-price booking" section), `CODEX-PROMPT.md` ("How it works" bullets, status), `docs/superpowers/specs/2026-11-10-bld-starting-prices-design.md` (status line → shipped, once Task 9 passes)

- [ ] **Step 1:** README: replace the "booking flow" paragraph for the website with the new seven-step flow and the price/deposit tables; document `detailPricing`, `payments_mode`, the invoice flow in the dashboard, the website-vs-app price mismatch warning, and how to turn real payments on later (flip `payments_mode` only after a Stripe path exists). Add the new `detail` function and migration 0015 to the layout tables.
- [ ] **Step 2:** CODEX-PROMPT.md: same facts, shorter; note "Philadelphia" becomes "Delaware and the Philadelphia area".
- [ ] **Step 3: Commit** `docs: describe starting-price booking`.

### Task 9: Go-live and end-to-end (owner gate)

**Files:** none new.

- [ ] **Step 1: Readiness check to the owner** (CLAUDE.md §5): prerequisites (project ref, `bld-app/.env` present, clean tree, rollback = `drop` of new objects and `update catalog set config = config - 'detailPricing'`), test plan (Jest, `scripts/e2e-detail.mjs`, browser pass), and end with "Sir, we are ready to build." only if all true. Wait for go.
- [ ] **Step 2:** Run `cd bld-app && npx jest && npx tsc --noEmit` — Expected: all existing tests plus new ones pass.
- [ ] **Step 3 (after go):** apply migration 0015 (MCP `apply_migration`; if Supabase MCP is unauthenticated, say so and use the Supabase CLI). Verify with a read: `detailPricing` present, `payments_mode='demo'`.
- [ ] **Step 4:** deploy functions `detail`, `admin`, `sweep` with the CLI (MCP deploy is flaky); prove each by behaviour (`quote` call, `detail_pricing_get`, sweep returns JSON).
- [ ] **Step 5:** run `node scripts/e2e-detail.mjs` — Expected: every line PASS. Fix and re-run until green; show the output.
- [ ] **Step 6:** `vercel deploy --prod` from the repo root (only after Steps 3-5 are green); open the live site and complete one booking end to end with an `E2E TEST` note, then decline it in the dashboard. Read Vercel runtime logs and Supabase function logs for errors.
- [ ] **Step 7:** Report: what changed, what was tested (with counts), what still needs configuration (real Stripe path and flipping `payments_mode`, real phone number, promo popup copy, app price alignment, Resend sender if emails did not arrive).
