-- 0009_initial_grant_once.sql
-- Make the first-period credit grant idempotent at the DB level. Provisioning is not
-- transactional (membership insert, credit grant, email are separate writes), so a
-- membership could commit while its credit grant fails transiently — leaving a paying
-- member with a code but zero credits. This partial-unique index lets provisionMember
-- safely RE-ATTEMPT the initial grant on any retry (insert-if-not-exists): exactly one
-- 'initial grant' row per membership, ever, so a partial failure self-heals.
create unique index if not exists credit_ledger_initial_grant_once
  on credit_ledger (membership_id)
  where reason = 'initial grant';
