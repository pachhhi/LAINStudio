-- migrate:up
ALTER TABLE orders ADD COLUMN public_order_id uuid;

UPDATE orders SET public_order_id = gen_random_uuid();

ALTER TABLE orders
  ALTER COLUMN public_order_id SET NOT NULL,
  ADD CONSTRAINT orders_public_order_id_unique UNIQUE (public_order_id);

-- migrate:down
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_public_order_id_unique,
  DROP COLUMN IF EXISTS public_order_id;
