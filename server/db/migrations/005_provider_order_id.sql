-- migrate:up
ALTER TABLE orders ADD COLUMN provider_order_id varchar(200);
ALTER TABLE payment_attempts ADD COLUMN provider_order_id varchar(200);

CREATE UNIQUE INDEX orders_provider_order_unique
  ON orders(payment_provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE UNIQUE INDEX payment_attempts_provider_order_unique
  ON payment_attempts(provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS payment_attempts_provider_order_unique;
DROP INDEX IF EXISTS orders_provider_order_unique;
ALTER TABLE payment_attempts DROP COLUMN IF EXISTS provider_order_id;
ALTER TABLE orders DROP COLUMN IF EXISTS provider_order_id;
