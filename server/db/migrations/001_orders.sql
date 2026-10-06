-- migrate:up
CREATE TABLE orders (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('pending','awaiting_payment','processing','paid','failed','cancelled','refunded')),
  subtotal bigint NOT NULL CHECK (subtotal >= 0),
  total bigint NOT NULL CHECK (total >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  customer_name varchar(100) NOT NULL,
  customer_email varchar(254) NOT NULL,
  customer_phone varchar(40) NOT NULL DEFAULT '',
  payment_provider varchar(80),
  payment_id varchar(200),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (payment_provider, payment_id)
);

CREATE TABLE order_items (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id varchar(100) NOT NULL,
  product_name varchar(200) NOT NULL,
  variant_id varchar(100),
  color varchar(100),
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 10),
  unit_price bigint NOT NULL CHECK (unit_price >= 0),
  line_total bigint NOT NULL CHECK (line_total >= 0)
);

CREATE TABLE idempotency_keys (
  key varchar(160) PRIMARY KEY,
  operation varchar(40) NOT NULL CHECK (operation IN ('checkout','payment')),
  request_fingerprint text NOT NULL,
  resource_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL CHECK (status IN ('in_progress','completed','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider varchar(80) NOT NULL,
  provider_payment_id varchar(200),
  idempotency_key varchar(160) NOT NULL UNIQUE REFERENCES idempotency_keys(key),
  status varchar(20) NOT NULL CHECK (status IN ('created','processing','approved','pending','rejected','failed','cancelled','refunded')),
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payment_attempts_provider_payment_unique
  ON payment_attempts(provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE INDEX order_items_order_id_idx ON order_items(order_id);
CREATE INDEX payment_attempts_order_id_idx ON payment_attempts(order_id);

-- migrate:down
DROP TABLE IF EXISTS payment_attempts;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
