-- migrate:up
ALTER TABLE payment_attempts
  ADD COLUMN reconciliation_failures integer NOT NULL DEFAULT 0 CHECK (reconciliation_failures >= 0),
  ADD COLUMN reconciliation_next_at timestamptz,
  ADD COLUMN reconciliation_locked_until timestamptz,
  ADD COLUMN reconciliation_lock_id uuid,
  ADD COLUMN reconciliation_last_error varchar(120),
  ADD COLUMN reconciliation_needs_review boolean NOT NULL DEFAULT false;

CREATE INDEX payment_attempts_reconciliation_due_idx
  ON payment_attempts(reconciliation_next_at, updated_at)
  WHERE status IN ('created','processing','pending') AND reconciliation_needs_review = false;

-- migrate:down
DROP INDEX IF EXISTS payment_attempts_reconciliation_due_idx;
ALTER TABLE payment_attempts
  DROP COLUMN IF EXISTS reconciliation_needs_review,
  DROP COLUMN IF EXISTS reconciliation_last_error,
  DROP COLUMN IF EXISTS reconciliation_lock_id,
  DROP COLUMN IF EXISTS reconciliation_locked_until,
  DROP COLUMN IF EXISTS reconciliation_next_at,
  DROP COLUMN IF EXISTS reconciliation_failures;
