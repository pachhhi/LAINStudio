import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ConflictError, NotFoundError } from '../errors.js';
import { OrderRepository } from './order-repository-contract.js';

function safeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${field} is outside JavaScript's safe integer range.`);
  return number;
}

function mapOrder(row, items = []) {
  return {
    id: row.id,
    publicOrderId: row.public_order_id,
    items: items.map(item => ({
      productId: item.product_id, name: item.product_name, quantity: item.quantity,
      unitPrice: safeInteger(item.unit_price, 'unit_price'), lineTotal: safeInteger(item.line_total, 'line_total'),
      ...(item.variant_id ? { variantId: item.variant_id } : {}), ...(item.color ? { color: item.color } : {})
    })),
    subtotal: safeInteger(row.subtotal, 'subtotal'), total: safeInteger(row.total, 'total'), currency: row.currency,
    customer: { name: row.customer_name, email: row.customer_email, phone: row.customer_phone },
    ...(row.shipping ? { shipping: row.shipping, shippingStatus: row.shipping_status, deliveryAddress: row.delivery_address } : {}),
    status: row.status, paymentProvider: row.payment_provider, paymentId: row.payment_id,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), version: row.version
  };
}

export class PostgresOrderRepository extends OrderRepository {
  constructor({ pool }) { super(); this.pool = pool; }
  static fromConnectionString(connectionString) {
    if (!connectionString) throw new Error('DATABASE_URL is required.');
    return new PostgresOrderRepository({ pool: new pg.Pool({ connectionString }) });
  }
  async healthCheck() { await this.pool.query('SELECT 1'); }
  async close() { await this.pool.end(); }

  async #transaction(work) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async #findById(client, id) {
    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!orderResult.rowCount) return null;
    const itemResult = await client.query(`SELECT product_id, product_name, variant_id, color, quantity, unit_price, line_total
      FROM order_items WHERE order_id = $1 ORDER BY id`, [id]);
    return mapOrder(orderResult.rows[0], itemResult.rows);
  }

  async findById(id) { return this.#findById(this.pool, id); }

  async findByPublicOrderId(publicOrderId) {
    const orderResult = await this.pool.query('SELECT * FROM orders WHERE public_order_id = $1', [publicOrderId]);
    if (!orderResult.rowCount) return null;
    const itemResult = await this.pool.query(`SELECT product_id, product_name, variant_id, color, quantity, unit_price, line_total
      FROM order_items WHERE order_id = $1 ORDER BY id`, [orderResult.rows[0].id]);
    return mapOrder(orderResult.rows[0], itemResult.rows);
  }

  async listRecent({ limit = 100 } = {}) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    const result = await this.pool.query('SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT $1', [safeLimit]);
    return result.rows.map(row => mapOrder(row));
  }

  async #insertOrder(client, order) {
    await client.query(`INSERT INTO orders(id,public_order_id,status,subtotal,total,currency,customer_name,customer_email,customer_phone,payment_provider,payment_id,shipping,shipping_status,delivery_address,created_at,updated_at,version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [order.id, order.publicOrderId, order.status, order.subtotal, order.total, order.currency,
      order.customer.name, order.customer.email, order.customer.phone, order.paymentProvider, order.paymentId,
      order.shipping || null, order.shippingStatus || null, order.deliveryAddress || null, order.createdAt, order.updatedAt, order.version]);
    for (const item of order.items) {
      await client.query(`INSERT INTO order_items(order_id,product_id,product_name,variant_id,color,quantity,unit_price,line_total)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [order.id, item.productId, item.name, item.variantId || null, item.color || null, item.quantity, item.unitPrice, item.lineTotal]);
    }
  }

  async save(order) {
    return this.#transaction(async client => { await this.#insertOrder(client, order); return structuredClone(order); });
  }

  async createWithIdempotency(order, { key, fingerprint }) {
    return this.#transaction(async client => {
      const claimed = await client.query(`INSERT INTO idempotency_keys(key, operation, request_fingerprint, status)
        VALUES ($1, 'checkout', $2, 'in_progress') ON CONFLICT (key) DO NOTHING RETURNING key`, [key, fingerprint]);
      if (!claimed.rowCount) {
        const existing = await client.query('SELECT request_fingerprint, resource_id, status FROM idempotency_keys WHERE key = $1 FOR UPDATE', [key]);
        const record = existing.rows[0];
        if (record.request_fingerprint !== fingerprint) throw new ConflictError('Idempotency key was already used with a different payload.');
        if (!record.resource_id || record.status !== 'completed') throw new ConflictError('The original request is still in progress.');
        return { order: await this.#findById(client, record.resource_id), created: false };
      }

      await this.#insertOrder(client, order);
      await client.query(`UPDATE idempotency_keys SET resource_id=$2,status='completed',updated_at=now() WHERE key=$1`, [key, order.id]);
      return { order: { ...structuredClone(order), version: order.version }, created: true };
    });
  }

  async update(id, expectedVersion, updater) {
    return this.#transaction(async client => {
      const current = await this.#findById(client, id);
      if (!current) return null;
      if (current.version !== expectedVersion) throw new ConflictError('Order was modified concurrently.');
      const next = updater(structuredClone(current));
      const result = await client.query(`UPDATE orders SET status=$3,payment_provider=$4,payment_id=$5,updated_at=$6,version=version+1
        WHERE id=$1 AND version=$2 RETURNING version`, [id, expectedVersion, next.status, next.paymentProvider, next.paymentId, next.updatedAt]);
      if (!result.rowCount) throw new ConflictError('Order was modified concurrently.');
      return { ...next, version: result.rows[0].version };
    });
  }

  async beginPayment({ orderId, key, fingerprint, provider }) {
    return this.#transaction(async client => {
      const claimed = await client.query(`INSERT INTO idempotency_keys(key,operation,request_fingerprint,status)
        VALUES($1,'payment',$2,'in_progress') ON CONFLICT(key) DO NOTHING RETURNING key`, [key, fingerprint]);
      if (!claimed.rowCount) {
        const existing = (await client.query('SELECT * FROM idempotency_keys WHERE key=$1 FOR UPDATE', [key])).rows[0];
        if (existing.request_fingerprint !== fingerprint) throw new ConflictError('Idempotency key was already used for another payment.');
        const order = await this.#findById(client, existing.resource_id);
        return { created: false, completed: existing.status === 'completed', order };
      }
      const locked = await client.query('SELECT version,status FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
      if (!locked.rowCount) throw new NotFoundError('Order not found.');
      if (!['pending', 'failed'].includes(locked.rows[0].status)) throw new ConflictError(`Cannot start payment from ${locked.rows[0].status}.`);
      const attemptId = randomUUID();
      await client.query('UPDATE idempotency_keys SET resource_id=$2,updated_at=now() WHERE key=$1', [key, orderId]);
      await client.query(`INSERT INTO payment_attempts(id,order_id,provider,idempotency_key,provider_idempotency_key,status,request_fingerprint)
        VALUES($1,$2,$3,$4,$5,'created',$6)`, [attemptId, orderId, provider, key, attemptId, fingerprint]);
      await client.query(`UPDATE orders SET status='awaiting_payment',updated_at=now(),version=version+1 WHERE id=$1`, [orderId]);
      return { created: true, attemptId, providerIdempotencyKey: attemptId, order: await this.#findById(client, orderId) };
    });
  }

  async completePayment({ attemptId, orderId, status, orderStatus, providerPaymentId, provider }) {
    return this.#transaction(async client => {
      const current = await client.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
      if (!current.rowCount) throw new NotFoundError('Order not found.');
      if (current.rows[0].status !== 'awaiting_payment') throw new ConflictError(`Cannot complete payment from ${current.rows[0].status}.`);
      await client.query(`UPDATE payment_attempts SET status=$2,provider_payment_id=$3,updated_at=now() WHERE id=$1`, [attemptId, status, providerPaymentId]);
      await client.query(`UPDATE orders SET status=$2,payment_provider=$3,payment_id=$4,updated_at=now(),version=version+1 WHERE id=$1`, [orderId, orderStatus, provider, providerPaymentId]);
      await client.query(`UPDATE idempotency_keys SET status='completed',updated_at=now() WHERE key=(SELECT idempotency_key FROM payment_attempts WHERE id=$1)`, [attemptId]);
      return this.#findById(client, orderId);
    });
  }

  async failPayment({ attemptId, orderId }) {
    return this.#transaction(async client => {
      await client.query(`UPDATE payment_attempts SET status='failed',updated_at=now() WHERE id=$1`, [attemptId]);
      await client.query(`UPDATE orders SET status='failed',updated_at=now(),version=version+1 WHERE id=$1 AND status='awaiting_payment'`, [orderId]);
      await client.query(`UPDATE idempotency_keys SET status='failed',updated_at=now() WHERE key=(SELECT idempotency_key FROM payment_attempts WHERE id=$1)`, [attemptId]);
      return this.#findById(client, orderId);
    });
  }

  async markPaymentProcessing({ attemptId, orderId }) {
    return this.#transaction(async client => {
      await client.query(`UPDATE payment_attempts SET status='processing',updated_at=now() WHERE id=$1`, [attemptId]);
      await client.query(`UPDATE orders SET status='processing',updated_at=now(),version=version+1 WHERE id=$1 AND status='awaiting_payment'`, [orderId]);
      return this.#findById(client, orderId);
    });
  }

  async findPaymentAttempt({ provider, providerPaymentId, externalReference }) {
    const safeExternalReference = typeof externalReference === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(externalReference)
      ? externalReference : null;
    const result = await this.pool.query(`SELECT * FROM payment_attempts WHERE provider=$1
      AND (($2::text IS NOT NULL AND provider_payment_id=$2) OR ($3::uuid IS NOT NULL AND id=$3::uuid)) LIMIT 1`,
      [provider, providerPaymentId || null, safeExternalReference]);
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return { id: row.id, orderId: row.order_id, provider: row.provider, providerPaymentId: row.provider_payment_id,
      providerIdempotencyKey: row.provider_idempotency_key, status: row.status, idempotencyKey: row.idempotency_key,
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), order: await this.findById(row.order_id) };
  }

  async reconcilePayment({ attemptId, expectedOrderVersion, expectedOrderStatus, providerPaymentId, paymentStatus, orderStatus }) {
    return this.#transaction(async client => {
      const attempt = await client.query('SELECT order_id,provider,idempotency_key FROM payment_attempts WHERE id=$1 FOR UPDATE', [attemptId]);
      if (!attempt.rowCount) return null;
      const updated = await client.query(`UPDATE orders SET status=$4,payment_provider=$5,payment_id=$6,updated_at=now(),version=version+1
        WHERE id=$1 AND version=$2 AND status=$3 RETURNING id`, [attempt.rows[0].order_id, expectedOrderVersion, expectedOrderStatus, orderStatus, attempt.rows[0].provider, providerPaymentId]);
      if (!updated.rowCount) throw new ConflictError('Order was modified concurrently.');
      await client.query(`UPDATE payment_attempts SET status=$2,provider_payment_id=$3,updated_at=now() WHERE id=$1`, [attemptId, paymentStatus, providerPaymentId]);
      await client.query(`UPDATE idempotency_keys SET status='completed',updated_at=now() WHERE key=$1`, [attempt.rows[0].idempotency_key]);
      return this.#findById(client, attempt.rows[0].order_id);
    });
  }
}
