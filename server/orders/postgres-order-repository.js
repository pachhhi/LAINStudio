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
    deliveryMode: row.delivery_mode, shippingStatus: row.shipping_status,
    ...(row.shipping ? { shipping: row.shipping, deliveryAddress: row.delivery_address } : {}),
    status: row.status, paymentProvider: row.payment_provider, paymentId: row.payment_id,
    providerOrderId: row.provider_order_id || null,
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

  async listPaymentAttemptsNeedingReview({ limit = 100 } = {}) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    const result = await this.pool.query(`SELECT p.*,o.public_order_id,o.status AS order_status,o.total,o.currency,o.created_at AS order_created_at
      FROM payment_attempts p JOIN orders o ON o.id=p.order_id
      WHERE p.reconciliation_needs_review=true ORDER BY p.updated_at DESC,p.id DESC LIMIT $1`, [safeLimit]);
    return result.rows.map(row => ({ id: row.id, orderId: row.order_id, publicOrderId: row.public_order_id,
      orderStatus: row.order_status, total: safeInteger(row.total, 'total'), currency: row.currency,
      provider: row.provider, providerOrderId: row.provider_order_id, providerPaymentId: row.provider_payment_id,
      status: row.status, reconciliationFailures: row.reconciliation_failures,
      reconciliationLastError: row.reconciliation_last_error, reconciliationNeedsReview: row.reconciliation_needs_review,
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }));
  }

  async listPaymentAttemptsForOrder(orderId) {
    const result = await this.pool.query(`SELECT * FROM payment_attempts WHERE order_id=$1 ORDER BY created_at DESC,id DESC`, [orderId]);
    return result.rows.map(row => ({ id: row.id, orderId: row.order_id, provider: row.provider,
      providerOrderId: row.provider_order_id, providerPaymentId: row.provider_payment_id, status: row.status,
      reconciliationFailures: row.reconciliation_failures, reconciliationLastError: row.reconciliation_last_error,
      reconciliationNeedsReview: row.reconciliation_needs_review, createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString() }));
  }

  async #insertOrder(client, order) {
    await client.query(`INSERT INTO orders(id,public_order_id,status,subtotal,total,currency,customer_name,customer_email,customer_phone,payment_provider,payment_id,provider_order_id,shipping,shipping_status,delivery_address,delivery_mode,created_at,updated_at,version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, [order.id, order.publicOrderId, order.status, order.subtotal, order.total, order.currency,
      order.customer.name, order.customer.email, order.customer.phone, order.paymentProvider, order.paymentId,
      order.providerOrderId || null, order.shipping || null, order.shippingStatus, order.deliveryAddress || null, order.deliveryMode, order.createdAt, order.updatedAt, order.version]);
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
      const result = await client.query(`UPDATE orders SET status=$3,payment_provider=$4,payment_id=$5,provider_order_id=$6,updated_at=$7,version=version+1
        WHERE id=$1 AND version=$2 RETURNING version`, [id, expectedVersion, next.status, next.paymentProvider, next.paymentId, next.providerOrderId || null, next.updatedAt]);
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

  async completePayment({ attemptId, orderId, status, orderStatus, providerPaymentId, providerOrderId = null, provider }) {
    return this.#transaction(async client => {
      const attempt = await client.query('SELECT status,provider_payment_id,provider_order_id FROM payment_attempts WHERE id=$1 AND order_id=$2 FOR UPDATE', [attemptId, orderId]);
      if (!attempt.rowCount) throw new NotFoundError('Payment attempt not found.');
      const current = await client.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
      if (!current.rowCount) throw new NotFoundError('Order not found.');
      if (current.rows[0].status !== 'awaiting_payment') {
        const settled = ['paid', 'partially_refunded', 'refunded', 'chargeback'].includes(current.rows[0].status)
          && ['approved', 'partially_refunded', 'refunded', 'chargeback'].includes(attempt.rows[0].status)
          && attempt.rows[0].provider_payment_id === providerPaymentId
          && (!attempt.rows[0].provider_order_id || !providerOrderId || attempt.rows[0].provider_order_id === providerOrderId);
        if (settled) return this.#findById(client, orderId);
        throw new ConflictError(`Cannot complete payment from ${current.rows[0].status}.`);
      }
      if (!['created', 'processing'].includes(attempt.rows[0].status)) {
        throw new ConflictError(`Cannot complete payment attempt from ${attempt.rows[0].status}.`);
      }
      await client.query(`UPDATE payment_attempts SET status=$2::text,provider_payment_id=$3,provider_order_id=$4,
        reconciliation_monitor_until=CASE WHEN $2::text='approved' THEN now()+interval '30 days' ELSE reconciliation_monitor_until END,
        reconciliation_next_at=CASE WHEN $2::text='approved' THEN now()+interval '6 hours' ELSE reconciliation_next_at END,
        updated_at=now() WHERE id=$1`, [attemptId, status, providerPaymentId, providerOrderId]);
      await client.query(`UPDATE orders SET status=$2,payment_provider=$3,payment_id=$4,provider_order_id=$5,updated_at=now(),version=version+1 WHERE id=$1`, [orderId, orderStatus, provider, providerPaymentId, providerOrderId]);
      await client.query(`UPDATE idempotency_keys SET status='completed',updated_at=now() WHERE key=(SELECT idempotency_key FROM payment_attempts WHERE id=$1)`, [attemptId]);
      return this.#findById(client, orderId);
    });
  }

  async failPayment({ attemptId, orderId }) {
    return this.#transaction(async client => {
      const changed = await client.query(`UPDATE payment_attempts SET status='failed',updated_at=now()
        WHERE id=$1 AND order_id=$2 AND status='created' RETURNING idempotency_key`, [attemptId, orderId]);
      if (changed.rowCount) {
        await client.query(`UPDATE orders SET status='failed',updated_at=now(),version=version+1 WHERE id=$1 AND status='awaiting_payment'`, [orderId]);
        await client.query(`UPDATE idempotency_keys SET status='failed',updated_at=now() WHERE key=$1`, [changed.rows[0].idempotency_key]);
      }
      return this.#findById(client, orderId);
    });
  }

  async markPaymentProcessing({ attemptId, orderId, providerPaymentId = null, providerOrderId = null }) {
    return this.#transaction(async client => {
      const changed = await client.query(`UPDATE payment_attempts SET status='processing',
        provider_payment_id=COALESCE(provider_payment_id,$3),provider_order_id=COALESCE(provider_order_id,$4),updated_at=now()
        WHERE id=$1 AND order_id=$2 AND status IN ('created','processing')
          AND (provider_payment_id IS NULL OR $3::text IS NULL OR provider_payment_id=$3)
          AND (provider_order_id IS NULL OR $4::text IS NULL OR provider_order_id=$4)
        RETURNING id`, [attemptId, orderId, providerPaymentId, providerOrderId]);
      if (changed.rowCount) await client.query(`UPDATE orders SET status='processing',updated_at=now(),version=version+1 WHERE id=$1 AND status='awaiting_payment'`, [orderId]);
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
    return { id: row.id, orderId: row.order_id, provider: row.provider, providerPaymentId: row.provider_payment_id, providerOrderId: row.provider_order_id,
      providerIdempotencyKey: row.provider_idempotency_key, status: row.status, idempotencyKey: row.idempotency_key,
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), order: await this.findById(row.order_id) };
  }

  async reconcilePayment({ attemptId, expectedOrderVersion, expectedOrderStatus, providerPaymentId, providerOrderId = null, paymentStatus, orderStatus }) {
    return this.#transaction(async client => {
      const attempt = await client.query('SELECT order_id,provider,idempotency_key FROM payment_attempts WHERE id=$1 FOR UPDATE', [attemptId]);
      if (!attempt.rowCount) return null;
      const updated = await client.query(`UPDATE orders SET status=$4,payment_provider=$5,payment_id=$6,provider_order_id=$7,updated_at=now(),version=version+1
        WHERE id=$1 AND version=$2 AND status=$3 RETURNING id`, [attempt.rows[0].order_id, expectedOrderVersion, expectedOrderStatus, orderStatus, attempt.rows[0].provider, providerPaymentId, providerOrderId]);
      if (!updated.rowCount) throw new ConflictError('Order was modified concurrently.');
      await client.query(`UPDATE payment_attempts SET status=$2::text,provider_payment_id=$3,provider_order_id=$4,
        reconciliation_monitor_until=CASE WHEN $2::text IN ('approved','partially_refunded','chargeback')
          THEN COALESCE(reconciliation_monitor_until,now()+interval '30 days') ELSE reconciliation_monitor_until END,
        updated_at=now() WHERE id=$1`, [attemptId, paymentStatus, providerPaymentId, providerOrderId]);
      await client.query(`UPDATE idempotency_keys SET status='completed',updated_at=now() WHERE key=$1`, [attempt.rows[0].idempotency_key]);
      return this.#findById(client, attempt.rows[0].order_id);
    });
  }

  async claimPaymentReconciliationBatch({ provider, limit = 20, lockSeconds = 90, maxFailures = 8 }) {
    const lockId = randomUUID();
    return this.#transaction(async client => {
      const result = await client.query(`WITH due AS (
          SELECT id FROM payment_attempts
          WHERE provider=$1 AND status IN ('created','processing','pending','approved','partially_refunded','chargeback')
            AND reconciliation_needs_review=false AND reconciliation_failures < $2
            AND (status IN ('created','processing','pending') OR reconciliation_monitor_until > now())
            AND (reconciliation_next_at IS NULL OR reconciliation_next_at <= now())
            AND (reconciliation_locked_until IS NULL OR reconciliation_locked_until < now())
          ORDER BY COALESCE(reconciliation_next_at, created_at), created_at
          FOR UPDATE SKIP LOCKED LIMIT $3
        )
        UPDATE payment_attempts p SET reconciliation_lock_id=$4,
          reconciliation_locked_until=now()+($5::text || ' seconds')::interval
        FROM due WHERE p.id=due.id
        RETURNING p.*`, [provider, maxFailures, Math.min(Math.max(limit, 1), 100), lockId, lockSeconds]);
      return result.rows.map(row => ({ id: row.id, orderId: row.order_id, provider: row.provider,
        providerPaymentId: row.provider_payment_id, providerOrderId: row.provider_order_id,
        providerIdempotencyKey: row.provider_idempotency_key, status: row.status,
        createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
        reconciliationFailures: row.reconciliation_failures, lockId }));
    });
  }

  async releasePaymentReconciliation({ attemptId, lockId, outcome, retryAt = null, errorCode = null, maxFailures = 8 }) {
    const failure = outcome === 'transient_error' || outcome === 'manual_review';
    const result = await this.pool.query(`UPDATE payment_attempts SET
        reconciliation_failures=CASE WHEN $8 THEN 0 ELSE reconciliation_failures+CASE WHEN $3 THEN 1 ELSE 0 END END,
        reconciliation_next_at=$4,
        reconciliation_last_error=$5,
        reconciliation_needs_review=CASE
          WHEN $6 THEN true
          WHEN $3 AND reconciliation_failures+1 >= $7 THEN true
          ELSE reconciliation_needs_review END,
        reconciliation_lock_id=NULL,reconciliation_locked_until=NULL,updated_at=now()
      WHERE id=$1 AND reconciliation_lock_id=$2
      RETURNING reconciliation_failures,reconciliation_needs_review`,
      [attemptId, lockId, failure, retryAt, errorCode, outcome === 'manual_review', maxFailures, outcome === 'success']);
    return result.rows[0] || null;
  }
}
