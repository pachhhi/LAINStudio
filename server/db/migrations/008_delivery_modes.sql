-- migrate:up
ALTER TABLE orders DROP CONSTRAINT orders_shipping_complete_check;
ALTER TABLE orders DROP CONSTRAINT orders_shipping_status_check;

ALTER TABLE orders ADD COLUMN delivery_mode varchar(30);
UPDATE orders SET delivery_mode = CASE WHEN shipping IS NULL THEN 'coordinate' ELSE 'home_delivery' END;
UPDATE orders SET shipping_status = 'coordination_pending' WHERE delivery_mode = 'coordinate';
ALTER TABLE orders ALTER COLUMN delivery_mode SET NOT NULL;

ALTER TABLE orders
  ADD CONSTRAINT orders_delivery_mode_check CHECK (delivery_mode IN ('home_delivery','coordinate')),
  ADD CONSTRAINT orders_shipping_status_check CHECK (shipping_status IN ('selected','coordination_pending')),
  ADD CONSTRAINT orders_shipping_complete_check CHECK (
    (delivery_mode = 'home_delivery' AND shipping IS NOT NULL AND shipping_status = 'selected' AND delivery_address IS NOT NULL)
    OR (delivery_mode = 'coordinate' AND shipping IS NULL AND shipping_status = 'coordination_pending' AND delivery_address IS NULL)
  );

-- migrate:down
ALTER TABLE orders
  DROP CONSTRAINT orders_shipping_complete_check,
  DROP CONSTRAINT orders_shipping_status_check,
  DROP CONSTRAINT orders_delivery_mode_check;
UPDATE orders SET shipping_status = NULL WHERE delivery_mode = 'coordinate';
ALTER TABLE orders DROP COLUMN delivery_mode;
ALTER TABLE orders
  ADD CONSTRAINT orders_shipping_status_check CHECK (shipping_status IS NULL OR shipping_status IN ('selected')),
  ADD CONSTRAINT orders_shipping_complete_check CHECK (
    (shipping IS NULL AND shipping_status IS NULL AND delivery_address IS NULL)
    OR (shipping IS NOT NULL AND shipping_status = 'selected' AND delivery_address IS NOT NULL)
  );
