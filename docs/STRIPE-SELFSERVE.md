# Stripe Self-Serve Membership (Round 3)

Customers buy a membership themselves via a Stripe Payment Link. Stripe collects the
money and the recurring subscription; a signed webhook provisions the member (code +
first credits + welcome email) automatically. No owner action per sale.

**Live account:** `client forge` (`acct_1TcvWGJufaAXGxeJ`) — **LIVE mode, real money.**

---

## ⚠️ ONE manual step before this works — set the webhook signing secret

The webhook is deployed but **fails closed** until you give it the signing secret. Until
then a real payment charges the card + creates the Stripe subscription but **no member
code is issued** (the webhook rejects unsigned/unverified calls). So do this before
sharing the links publicly:

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://fiaadogbkvjcddehnymj.supabase.co/functions/v1/stripe-webhook`
3. Events to send: **`checkout.session.completed`** and **`customer.subscription.deleted`**.
4. Create it, then copy the **Signing secret** (`whsec_…`).
5. Store it in the DB (service-role only — never in git):
   ```sql
   update app_config set value = '<whsec_...>' where key = 'stripe_webhook_secret';
   ```
6. In the dashboard, use **Send test webhook** (checkout.session.completed) → the endpoint
   should return 200. Or do a real $1-tier test purchase and confirm a code arrives.

Until step 5 is done, consider the payment links **unpublished**. (They are live and will
take money; a buyer just won't be auto-provisioned a code until the secret is set — you'd
have to issue their code manually from the owner page.)

---

## What was created in Stripe (live)

| Tier | Price (monthly) | Price ID | Payment Link |
|---|---|---|---|
| Bronze | $79 | `price_1Tu2kCJufaAXGxeJF6DcoPUP` | https://buy.stripe.com/00w4gAgbJ2pm4WF5MBgjC00 |
| Silver | $99 | `price_1Tu2kDJufaAXGxeJ5IMnVNRB` | https://buy.stripe.com/bJe9AU0cL2pm74N6QFgjC01 |
| Gold | $199 | `price_1Tu2kEJufaAXGxeJTD6C0Vg8` | https://buy.stripe.com/eVqdRa4t10he1Kta2RgjC02 |

Each link stamps `metadata.tier`, which Stripe copies onto the checkout session so the
webhook knows which tier to grant. The same link URLs live in `catalog.config.stripe.links`
so the app + website read them (change once in the DB, both update — no redeploy).

## How fulfillment works

- **`checkout.session.completed`** → `provisionMember()`: create/reuse the customer (by
  email), insert a membership with a unique code + the Stripe subscription id, grant the
  first month's credits, email the code.
- **`customer.subscription.deleted`** (cancel / non-payment) → sets `memberships.active=false`.
- **Renewals**: monthly credits keep coming from the existing `sweep` cron (it grants every
  active membership), NOT from the webhook — this avoids double-granting.

## Idempotency / safety (verified against the live endpoint)

- Signature verified on every call against `app_config.stripe_webhook_secret`; bad/missing
  signature → 400, empty secret → 500, no fulfillment before verification.
- The Stripe subscription id is partial-unique in the DB, so a replayed/racing delivery
  resolves to the same membership — no duplicate members, no double credits.
- The first-period grant is idempotent (partial-unique index `credit_ledger_initial_grant_once`)
  and re-attempted on retry, so a partial failure self-heals.
- Permanent bad data (unknown tier, missing subscription id, unpaid session) is **acked (200)**
  so Stripe stops retrying and never auto-disables the endpoint; only transient DB faults 500.

## Limitations / follow-ups

- **Upgrades of an existing member are still owner-handled.** A payment link creates a NEW
  subscription; using one to "upgrade" would mint a second membership. The app's Upgrade
  button emails the owner (adjust tier + Stripe subscription manually). Real self-serve
  upgrade = a Stripe subscription-update flow (future).
- **The $10 slot anchor stays an in-app booking add-on** (it attaches to a specific booking,
  so a standalone link doesn't fit).
- **Booking deposits still use the fake payment provider** (`_shared/payments/provider.ts`).
  Converting in-app card entry to Stripe is a separate job.
- **Price sync gap:** changing a plan price in `catalog` updates the app + website, but NOT
  the Stripe Price. To change a membership price you must also create a new Stripe Price and
  point the Payment Link at it (then update `catalog.config.stripe`). Automating this is a
  follow-up.
