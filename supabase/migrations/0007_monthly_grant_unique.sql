-- Idempotency backstop for sweep's monthly credit grants. The sweep function
-- keys each grant by a per-period reason ('monthly grant→YYYY-MM-DD') and
-- checks for an existing row before inserting, but that check + insert is not
-- atomic. This partial unique index makes a duplicate insert fail at the DB
-- level (sweep catches the error and moves on), so overlapping invocations can
-- never double-grant. Scoped to monthly-grant rows only — all other ledger
-- reasons ('wash', 'initial grant', 'wash_rollback', …) are unaffected.
create unique index if not exists credit_ledger_monthly_grant_once
  on credit_ledger (membership_id, reason)
  where reason like 'monthly grant→%';
