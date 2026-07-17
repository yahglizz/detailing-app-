# Test Fixtures — BLD

Reusable test data against the **live** Supabase project (`fiaadogbkvjcddehnymj`).
These are **test rows**, not real customers. Safe to keep for repeated testing.

## Test member code (reuse this every time)

| Field | Value |
|---|---|
| **Member code** | `BLD-7QHMVZ` |
| Tier | Gold (rank 3 — highest; exercises bump/priority) |
| Email | `test-gold@bld.local` |
| Starting credits | 2 (Gold monthly grant) |
| Stamps | 0 |

**How to use it**
- **App:** Home → "Brotherhood member? Enter your code" → type `BLD-7QHMVZ` → dashboard opens.
- **Member API:** `POST …/functions/v1/member` with `{ "code": "BLD-7QHMVZ", "action": "profile" }`.
- Redeem / upgrade / book-with-credit all key off this code.

## Owner admin token — NOT stored here

The owner admin token is a real secret and is deliberately **not** written to any
committed file. It lives in the DB: `select value from app_config where key='owner_admin_token';`
Owner page: `…/functions/v1/owner-members?token=<that value>`.

## Resetting / cleaning up test data

Test rows use the `test-` email prefix, so the E2E cleanup catches them:
`POST …/functions/v1/e2e-setup` with `{ "token": "<owner_admin_token>", "action": "cleanup", "emailLike": "test-" }`.

To re-grant this member's monthly credits after spending them, run `sweep`, or via SQL
insert a `credit_ledger` row (see `docs/CODEX-REVIEW-HANDOFF.md` for the ledger rules).
