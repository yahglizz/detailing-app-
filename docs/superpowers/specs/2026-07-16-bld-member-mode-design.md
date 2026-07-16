# Brotherly Love Detailing — Member Mode (Round 2) Design

**Date:** 2026-07-16
**Status:** Approved by owner (this document reflects decisions made in brainstorming)
**Scope:** Round 2 — membership codes, member dashboard, credit washes, stamps/rewards, priority booking with rank-based bumping, $10 slot anchor for non-members, website price sync. Stripe self-serve membership purchase is explicitly out of scope (Round 3).

---

## 1. What this is

Members get a code instead of a login. Typing the code once in the app unlocks a member dashboard: washes remaining this month, plan + upgrade path, a running savings counter, a stamp punch card with redeemable rewards, and priority booking that can bump non-member (and lower-tier member) appointments. Non-members can pay a $10 add-on to anchor their slot against bumping. All prices — services, extras, and membership plans — live in the Supabase `catalog` table so a single change updates the app and the website simultaneously with no code edits.

**Success criteria:** a member goes from code entry to a booked credit wash in under a minute; a bumped customer is always automatically rescheduled to the very next open slot the same day and told why; no credit or stamp balance can drift or double-spend; a price change made once in the catalog appears in the app and on the website with no deploy.

## 2. Decisions locked during brainstorming

| Decision | Choice |
|---|---|
| Member identity | Unique code per member (e.g. `BLD-X7K2M9`). Code = identity: washes, stamps, savings all keyed to it. Entered once, stored on device, dashboard auto-opens on later launches. |
| Plans | 3 tiers, each N washes/month of a specific service. Example numbers (tunable in catalog config, no release needed): Bronze $79/mo = 2 Outside · Silver $99/mo = 2 Inside · Gold $199/mo = 2 Full. |
| Tier rank | Gold 3 > Silver 2 > Bronze 1 > non-member 0. Rank drives bump priority. |
| Becoming a member | Owner-issued now (customer pays owner directly; owner enters name + email + tier on a signed-link "Add Member" page; code generated and handed to the customer). Stripe self-serve purchase later (Round 3). |
| Rewards | Stamps: 1 stamp per completed wash. Menu (example, tunable): 3 = free tire shine · 5 = free interior mini-spray · 8 = 25% off next detail · 10 = free wash. |
| Priority booking | Members book 30 days out; non-members 7. Everyone sees all slots. Higher rank bumps lower rank; bumped booking moves to the very next open slot the same day with an automatic explanatory email. Equal top-rank conflicts escalate to the owner for manual resolution. |
| Slot anchor | $10 add-on at checkout for non-members. Anchored bookings are bump-proof; members see them as hard-taken. |
| Price sync | `catalog` table is the single source of truth. App already reads it; the website (`Brotherly Love Detailing.dc.html`) will fetch it via the Supabase anon key on page load. One change propagates everywhere instantly. |

## 3. Data model (migrations on existing schema)

- **`catalog.config`** gains a `plans` object: `{ bronze: { price: 79, credits: 2, service: "outside", rank: 1 }, silver: { price: 99, credits: 2, service: "inside", rank: 2 }, gold: { price: 199, credits: 2, service: "full", rank: 3 } }` and a `rewards` menu: `{ tireShine: 3, miniSpray: 5, percent25: 8, freeWash: 10 }` and `anchorPrice: 10`.
- **`memberships`** gains: `code text unique not null` (generated server-side, unguessable), `tier text not null check (tier in ('bronze','silver','gold'))`. Existing columns (`credits_per_period`, `period_start`, `active`) keep their meaning. Monthly credit grants are rows in `credit_ledger` (append-only, existing non-negative trigger).
- **`reward_ledger`** (new, mirrors `credit_ledger`): `membership_id`, `delta int` (+1 earn per completed wash, −N on redemption), `reason text`, `booking_id`, `created_at`. Same non-negative-balance trigger pattern.
- **`redemptions`** (new): `membership_id`, `reward text`, `stamps_spent int`, `status ('issued','applied')`, `booking_id nullable` — an issued reward voucher auto-attaches to the member's next booking.
- **`bookings`** gains: `membership_id uuid nullable references memberships(id)`, `anchored boolean not null default false`, `bumped_from text nullable` (original `time_slot` if this row was bumped), `rank int not null default 0` (frozen at booking time from the booker's tier).
- **Savings** is computed, not stored: retail value of credit washes used + retail value of redeemed rewards − membership fees paid to date (fees derived from `period_start`, tier price history frozen per period in `credit_ledger.reason` metadata).

## 4. Server logic (edge functions)

- **`member` (new).** `POST { code }` → member profile: name, tier, credits balance, stamps balance, savings total, issued rewards, booking history. The code is the bearer credential; responses never include other customers' data. Invalid-code attempts are rate-limited per IP.
- **`book` (extended).**
  - Accepts optional member code. A wash matching the plan's service spends 1 credit (ledger row) — no deposit; extras are still charged normally.
  - **Bump engine** (server-side only, transactional):
    | Booker | Slot holder | Result |
    |---|---|---|
    | Higher rank | Lower rank (incl. non-member, rank 0) | Bump. Holder's booking moves to the very next open slot the same day; `bumped_from` recorded; automatic email: "A VIP member reserved this window — members never get bumped. Upgrade →" |
    | Any rank | Anchored booking | No bump. Slot is hard-taken. |
    | Equal top rank | Equal rank member | No auto-bump. Owner emailed a signed resolution link; new booking held in `requested` with a conflict flag. |
    | Bump needed but no open slot remains that day | — | Owner emailed a signed resolution link (rare). |
  - Booking window enforced server-side: members ≤ 30 days ahead, non-members ≤ 7.
  - $10 anchor add-on added to the quote before deposit math.
- **`owner-members` (new).** Signed-link owner page (same pattern as the confirm page): add member (name + email + tier → code generated and displayed), deactivate, change tier, grant manual stamps. Upgrade requests from the app land here as an email to the owner.
- **Stamp earn.** When a booking transitions to `done`, +1 stamp row per completed wash for the attached membership.
- **`sweep` (extended).** Monthly credit grant per active membership at each period rollover.

## 5. App UI (Expo)

- **Home:** "I'm a member" entry → code input → stored in AsyncStorage → member dashboard auto-opens on subsequent launches. Wrong/deactivated code clears storage with a friendly message.
- **Member Dashboard (new screen, dark VIP styling, tier-colored accents — bronze/silver/gold):**
  - Washes left this month + plan contents
  - Savings counter ("Saved $X since joining")
  - Plan card with Upgrade button → notifies owner (manual tier change now; Stripe later)
  - Stamp punch card (visual stamps) + rewards menu with Redeem buttons; issued rewards show as "will apply to your next booking"
  - Book Now (enters existing booking flow with member context)
  - Booking history
- **Booking flow (member context):** credit application shown in the price bar (wash = 1 credit, $0); slot grid shows all slots; a lower-rank taken slot is selectable by a higher-rank member with an inline note "Booking this bumps the current appointment — VIP perk."
- **Pay screen (non-members):** "$10 Slot Anchor — lock your time, bump-proof" toggle; anchored state reflected in the quote.
- **Booked screen:** members see credit spend + stamp earned preview.

## 6. Website price sync

`Brotherly Love Detailing.dc.html` gets a small script: fetch `catalog.config` from Supabase via the public anon key on page load, render service prices, extras, and the three membership tiers (prices + what's included). Static fallback values remain in the HTML in case the fetch fails. **Price-change workflow forever:** owner (or Claude on request) updates the catalog row once → app and website reflect it immediately; no app-store release, no HTML edit.

## 7. Error handling

- **Invalid / deactivated code:** clear message, member mode exits, stored code wiped. No data leak on guessing (rate-limited, codes unguessable).
- **Bump email fails:** booking move still commits; failure logged for owner follow-up (money and slots never depend on email delivery).
- **Redemption double-spend:** append-only ledger + non-negative trigger makes over-redeeming impossible; a redemption is atomic (stamp deduction + voucher issue in one transaction).
- **Credit exhausted:** Book Now falls back to normal paid booking with a "0 washes left — renews <date> or upgrade" banner.
- **Equal-rank or no-slot bump conflicts:** never auto-resolved; always owner escalation via signed link.
- **Catalog fetch fails on website:** static fallback prices render; a stale-price banner is not shown (fallbacks kept current at each price change as a courtesy edit).

## 8. Testing

- **Unit:** full bump matrix (every rank pairing × anchored × equal-rank × no-slot-left), booking-window enforcement, stamp earn/redeem ledger invariants (never negative, no double-spend), savings math, credit spend + exhausted-credit fallback, anchor price in quote math.
- **E2E (fake-payment mode):** member enters code → dashboard → books credit wash → owner marks done → stamp appears → redeems reward → reward attaches to next booking. Non-member books with anchor → member attempts bump → blocked. Member bumps non-member → bumped booking lands on next slot + email recorded.
- **Owner acceptance:** owner adds a real member from the owner page, member books on a real phone, owner triggers a bump and an equal-rank conflict, verifies both emails and the manual resolution link.

## 9. Explicitly out of scope (future rounds)

- Stripe self-serve membership purchase + auto-renewing billing (Round 3; owner-issued codes are the only signup path until then)
- Push notifications (email remains the channel)
- Owner app beyond signed-link pages
- Referral programs, gifting memberships, pausing memberships

## 10. Open items to settle before launch (config, not design)

- Real tier prices and credit counts (example numbers shipped in catalog config; change anytime)
- Real reward menu costs (example numbers shipped; change anytime)
- Anchor price final value (example $10)
- Bump marketing copy in the email and app notes
