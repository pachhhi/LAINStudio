-- migrate:up
ALTER TABLE payment_attempts
  ADD COLUMN provider_idempotency_key varchar(64);

UPDATE payment_attempts SET provider_idempotency_key = id::text;

ALTER TABLE payment_attempts
  ALTER COLUMN provider_idempotency_key SET NOT NULL,
  ADD CONSTRAINT payment_attempts_provider_idempotency_unique UNIQUE(provider, provider_idempotency_key);

-- migrate:down
ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_provider_idempotency_unique,
  DROP COLUMN IF EXISTS provider_idempotency_key;
