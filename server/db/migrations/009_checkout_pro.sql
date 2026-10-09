-- migrate:up
ALTER TABLE payment_attempts
  ADD COLUMN payment_flow varchar(30) NOT NULL DEFAULT 'card'
    CHECK (payment_flow IN ('card','checkout_pro')),
  ADD COLUMN provider_checkout_url text;

ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_checkout_url_flow_check
  CHECK (provider_checkout_url IS NULL OR payment_flow = 'checkout_pro');

-- migrate:down
ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_checkout_url_flow_check;
ALTER TABLE payment_attempts
  DROP COLUMN IF EXISTS provider_checkout_url,
  DROP COLUMN IF EXISTS payment_flow;
