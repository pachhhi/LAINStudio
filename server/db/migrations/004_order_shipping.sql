-- migrate:up
ALTER TABLE orders
  ADD COLUMN shipping jsonb,
  ADD COLUMN shipping_status varchar(20),
  ADD COLUMN delivery_address jsonb,
  ADD CONSTRAINT orders_shipping_status_check CHECK (shipping_status IS NULL OR shipping_status IN ('selected')),
  ADD CONSTRAINT orders_shipping_complete_check CHECK (
    (shipping IS NULL AND shipping_status IS NULL AND delivery_address IS NULL)
    OR (shipping IS NOT NULL AND shipping_status = 'selected' AND delivery_address IS NOT NULL)
  );

-- migrate:down
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_shipping_complete_check,
  DROP CONSTRAINT IF EXISTS orders_shipping_status_check,
  DROP COLUMN IF EXISTS delivery_address,
  DROP COLUMN IF EXISTS shipping_status,
  DROP COLUMN IF EXISTS shipping;
