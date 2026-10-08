-- migrate:up
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'pending','awaiting_payment','processing','paid','failed','cancelled','partially_refunded','refunded','chargeback'
));

ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_status_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_check CHECK (status IN (
  'created','processing','approved','pending','rejected','failed','cancelled','partially_refunded','refunded','chargeback'
));

ALTER TABLE payment_attempts ADD COLUMN reconciliation_monitor_until timestamptz;
UPDATE payment_attempts
  SET reconciliation_monitor_until=updated_at + interval '30 days'
  WHERE status IN ('approved','partially_refunded','chargeback');

DROP INDEX payment_attempts_reconciliation_due_idx;
CREATE INDEX payment_attempts_reconciliation_due_idx
  ON payment_attempts(reconciliation_next_at, updated_at)
  WHERE status IN ('created','processing','pending','approved','partially_refunded','chargeback')
    AND reconciliation_needs_review = false;

-- migrate:down
DROP INDEX IF EXISTS payment_attempts_reconciliation_due_idx;
ALTER TABLE payment_attempts DROP COLUMN IF EXISTS reconciliation_monitor_until;
ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_status_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_check CHECK (status IN (
  'created','processing','approved','pending','rejected','failed','cancelled','refunded'
));
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'pending','awaiting_payment','processing','paid','failed','cancelled','refunded'
));
CREATE INDEX payment_attempts_reconciliation_due_idx
  ON payment_attempts(reconciliation_next_at, updated_at)
  WHERE status IN ('created','processing','pending') AND reconciliation_needs_review = false;
