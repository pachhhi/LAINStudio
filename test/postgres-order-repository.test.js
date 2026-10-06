import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresOrderRepository } from '../server/orders/postgres-order-repository.js';
import { OrderService } from '../server/orders/order-service.js';
import { createTestCatalog } from '../test-support/catalog-fixture.js';
import { MercadoPagoProvider } from '../server/payments/mercadopago-provider.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString && process.env.DATABASE_URL === connectionString) {
  throw new Error('TEST_DATABASE_URL must not be the same database as DATABASE_URL.');
}
const enabled = Boolean(connectionString);
const pool = enabled ? new pg.Pool({ connectionString }) : null;
const repository = enabled ? new PostgresOrderRepository({ pool }) : null;
const customer = { name: "Robert'); DROP TABLE orders;--", email: 'db@example.com', phone: '+54 11 5555-5555' };
const item = { productId: 'lain-cap-01', variantId: 'One size', color: 'Black', quantity: 1 };
const payload = { items: [item], customer };
const key = suffix => `postgres_key_${suffix}_123456`;
const options = { skip: !enabled };

function service(repo = repository) { return new OrderService({ catalogService: createTestCatalog(), orderRepository: repo }); }

beforeEach(async () => {
  if (enabled) await pool.query('TRUNCATE payment_attempts, idempotency_keys, order_items, orders RESTART IDENTITY CASCADE');
});
after(async () => { if (pool) await pool.end(); });

test('creates and retrieves a durable order with items and SQL-safe customer input', options, async () => {
  const created = await service().create(payload, { idempotencyKey: key('create') });
  const found = await repository.findById(created.id);
  assert.deepEqual(found, created); assert.equal(found.items[0].unitPrice, 29000);
  assert.deepEqual(await repository.findByPublicOrderId(created.publicOrderId), created);
  assert.equal((await pool.query("SELECT to_regclass('public.orders') AS table_name")).rows[0].table_name, 'orders');
});

test('PostgreSQL read model lists newest orders for Ops', options, async () => {
  const first = await service().create(payload, { idempotencyKey: key('ops_first') });
  const second = await service().create(payload, { idempotencyKey: key('ops_second') });
  await pool.query('UPDATE orders SET created_at=$2 WHERE id=$1', [first.id, '2026-01-01T00:00:00.000Z']);
  await pool.query('UPDATE orders SET created_at=$2 WHERE id=$1', [second.id, '2026-02-01T00:00:00.000Z']);
  const listed = await repository.listRecent(); assert.deepEqual(listed.map(value => value.id), [second.id, first.id]);
});

test('connection-string factory validates configuration and health checks PostgreSQL', options, async () => {
  assert.throws(() => PostgresOrderRepository.fromConnectionString(''), /DATABASE_URL/);
  const standalone = PostgresOrderRepository.fromConnectionString(connectionString);
  await standalone.healthCheck(); await standalone.close();
});

test('survives repository and pool replacement and returns the same idempotent resource', options, async () => {
  const firstPool = new pg.Pool({ connectionString }); const firstRepository = new PostgresOrderRepository({ pool: firstPool });
  const created = await service(firstRepository).create(payload, { idempotencyKey: key('restart') }); await firstRepository.close();
  const secondPool = new pg.Pool({ connectionString }); const secondRepository = new PostgresOrderRepository({ pool: secondPool });
  const recovered = await secondRepository.findById(created.id);
  const retried = await service(secondRepository).create(payload, { idempotencyKey: key('restart') });
  assert.deepEqual(recovered, created); assert.equal(retried.id, created.id); await secondRepository.close();
});

test('12 concurrent identical checkouts across repository instances create one order', options, async () => {
  const repositories = Array.from({ length: 12 }, () => new PostgresOrderRepository({ pool: new pg.Pool({ connectionString, max: 2 }) }));
  try {
    const orders = await Promise.all(repositories.map(repo => service(repo).create(payload, { idempotencyKey: key('concurrent') })));
    assert.equal(new Set(orders.map(order => order.id)).size, 1);
    assert.equal(Number((await pool.query('SELECT count(*) FROM orders')).rows[0].count), 1);
  } finally { await Promise.all(repositories.map(repo => repo.close())); }
});

test('same key with different payload conflicts while different keys create legitimate orders', options, async () => {
  await service().create(payload, { idempotencyKey: key('conflict') });
  await assert.rejects(service().create({ ...payload, items: [{ ...item, quantity: 2 }] }, { idempotencyKey: key('conflict') }), /different payload/);
  const orders = await Promise.all(Array.from({ length: 6 }, (_, index) => service().create(payload, { idempotencyKey: key(`legit_${index}`) })));
  assert.equal(new Set(orders.map(order => order.id)).size, 6);
});

test('database enforces unique public order identifiers', options, async () => {
  const publicOrderId = randomUUID();
  const first = new OrderService({ catalogService: createTestCatalog(), orderRepository: repository, publicIdGenerator: () => publicOrderId });
  const second = new OrderService({ catalogService: createTestCatalog(), orderRepository: repository, publicIdGenerator: () => publicOrderId });
  await first.create(payload, { idempotencyKey: key('public_unique_first') });
  await assert.rejects(second.create(payload, { idempotencyKey: key('public_unique_second') }), /unique|duplicate/i);
  assert.equal(Number((await pool.query('SELECT count(*) FROM orders WHERE public_order_id=$1', [publicOrderId])).rows[0].count), 1);
});

test('item failure rolls back order and idempotency record completely', options, async () => {
  const now = new Date().toISOString(); const id = randomUUID();
  const invalid = { id, publicOrderId: randomUUID(), status: 'pending', subtotal: 1, total: 1, currency: 'ARS', customer: { name: 'A', email: 'a@b.co', phone: '' }, paymentProvider: null, paymentId: null, createdAt: now, updatedAt: now, version: 1,
    items: [{ productId: 'x', name: 'X', quantity: 0, unitPrice: 1, lineTotal: 1 }] };
  await assert.rejects(repository.createWithIdempotency(invalid, { key: key('rollback'), fingerprint: 'x' }), /constraint/i);
  assert.equal(await repository.findById(id), null);
  assert.equal(Number((await pool.query('SELECT count(*) FROM idempotency_keys WHERE key=$1', [key('rollback')])).rows[0].count), 0);
});

test('database constraints reject invalid money, states and quantities', options, async () => {
  const now = new Date().toISOString();
  await assert.rejects(pool.query(`INSERT INTO orders(id,status,subtotal,total,currency,customer_name,customer_email,created_at,updated_at)
    VALUES($1,'hacked',-1,-1,'ARS','A','a@b.co',$2,$2)`, [randomUUID(), now]), /constraint/i);
});

test('optimistic versioning prevents lost concurrent order updates', options, async () => {
  const created = await service().create(payload, { idempotencyKey: key('version') }); const current = await repository.findById(created.id);
  const updates = await Promise.allSettled([
    repository.update(created.id, current.version, value => ({ ...value, status: 'cancelled' })),
    repository.update(created.id, current.version, value => ({ ...value, status: 'awaiting_payment' }))
  ]);
  assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(updates.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await repository.findById(created.id)).version, 2);
});

test('state transitions remain protected with PostgreSQL storage', options, async () => {
  const order = await service().create(payload, { idempotencyKey: key('state') });
  const cancelled = await service().transition(order.id, 'cancelled'); assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(service().transition(order.id, 'processing'), /Cannot transition/);
});

test('payment attempts and their idempotency are durable', options, async () => {
  const order = await service().create(payload, { idempotencyKey: key('attempt_order') });
  const paymentKey = `payment:${key('attempt')}`;
  const claim = await repository.beginPayment({ orderId: order.id, key: paymentKey, fingerprint: order.id, provider: 'fake' });
  const paid = await repository.completePayment({ attemptId: claim.attemptId, orderId: order.id, status: 'approved', orderStatus: 'paid', providerPaymentId: 'provider-1', provider: 'fake' });
  const retry = await repository.beginPayment({ orderId: order.id, key: paymentKey, fingerprint: order.id, provider: 'fake' });
  assert.equal(paid.status, 'paid'); assert.equal(retry.completed, true); assert.equal(retry.order.paymentId, 'provider-1');
  const attempt = await pool.query('SELECT * FROM payment_attempts WHERE id=$1', [claim.attemptId]); assert.equal(attempt.rows[0].status, 'approved');
});

test('failed payment attempts atomically persist failed attempt and order states', options, async () => {
  const order = await service().create(payload, { idempotencyKey: key('failed_attempt_order') });
  const claim = await repository.beginPayment({ orderId: order.id, key: `payment:${key('failed_attempt')}`, fingerprint: order.id, provider: 'fake' });
  const failed = await repository.failPayment({ attemptId: claim.attemptId, orderId: order.id });
  const stored = await pool.query('SELECT status FROM payment_attempts WHERE id=$1', [claim.attemptId]);
  assert.equal(failed.status, 'failed'); assert.equal(stored.rows[0].status, 'failed');
});

test('late payment completion cannot overwrite a concurrently cancelled order', options, async () => {
  const orders = service(); const order = await orders.create(payload, { idempotencyKey: key('late_order') });
  const claim = await repository.beginPayment({ orderId: order.id, key: `payment:${key('late_attempt')}`, fingerprint: order.id, provider: 'fake' });
  await orders.transition(order.id, 'cancelled');
  await assert.rejects(repository.completePayment({ attemptId: claim.attemptId, orderId: order.id, status: 'approved', orderStatus: 'paid', providerPaymentId: 'late-1', provider: 'fake' }), /Cannot complete/);
  assert.equal((await repository.findById(order.id)).status, 'cancelled');
});

test('concurrent payment claims with the same key persist one attempt', options, async () => {
  const order = await service().create(payload, { idempotencyKey: key('same_payment_order') });
  const repositories = Array.from({ length: 10 }, () => new PostgresOrderRepository({ pool: new pg.Pool({ connectionString, max: 2 }) }));
  try {
    const claims = await Promise.all(repositories.map(repo => repo.beginPayment({
      orderId: order.id, key: `payment:${key('same_payment')}`, fingerprint: order.id, provider: 'fake'
    })));
    assert.equal(claims.filter(claim => claim.created).length, 1);
    assert.equal(Number((await pool.query('SELECT count(*) FROM payment_attempts WHERE order_id=$1', [order.id])).rows[0].count), 1);
  } finally { await Promise.all(repositories.map(repo => repo.close())); }
});

test('different concurrent payment keys cannot claim the same order twice', options, async () => {
  const order = await service().create(payload, { idempotencyKey: key('different_payment_order') });
  const first = new PostgresOrderRepository({ pool: new pg.Pool({ connectionString }) });
  const second = new PostgresOrderRepository({ pool: new pg.Pool({ connectionString }) });
  try {
    const results = await Promise.allSettled([
      first.beginPayment({ orderId: order.id, key: `payment:${key('different_a')}`, fingerprint: order.id, provider: 'fake' }),
      second.beginPayment({ orderId: order.id, key: `payment:${key('different_b')}`, fingerprint: order.id, provider: 'fake' })
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(Number((await pool.query('SELECT count(*) FROM payment_attempts WHERE order_id=$1', [order.id])).rows[0].count), 1);
    assert.equal(Number((await pool.query("SELECT count(*) FROM idempotency_keys WHERE operation='payment'")).rows[0].count), 1);
  } finally { await Promise.all([first.close(), second.close()]); }
});

test('MercadoPagoProvider mocked flow persists provider ID and durable idempotency key', options, async () => {
  let sent;
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async (_url, request) => {
    sent = request; return { ok: true, status: 201, json: async () => ({ id: 987, status: 'approved', external_reference: JSON.parse(request.body).external_reference }) };
  } });
  const orders = new OrderService({ catalogService: createTestCatalog(), orderRepository: repository, paymentProvider: provider });
  const order = await orders.create(payload, { idempotencyKey: key('mp_order') });
  const paid = await orders.startPayment(order.id, { idempotencyKey: key('mp_payment'), paymentData: { token: 'card_token_123456', paymentMethodId: 'visa', installments: 1 } });
  const attempt = (await pool.query('SELECT * FROM payment_attempts WHERE order_id=$1', [order.id])).rows[0];
  assert.equal(paid.status, 'paid'); assert.equal(attempt.provider_payment_id, '987');
  assert.equal(attempt.provider_idempotency_key, attempt.id);
  assert.equal(sent.headers['X-Idempotency-Key'], attempt.id);
});

test('timeout remains recoverable across OrderService restart without a second POST', options, async () => {
  let postCalls = 0;
  const timeoutProvider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => { postCalls += 1; throw new Error('network'); } });
  const firstService = new OrderService({ catalogService: createTestCatalog(), orderRepository: repository, paymentProvider: timeoutProvider });
  const order = await firstService.create(payload, { idempotencyKey: key('timeout_order') }); const paymentKey = key('timeout_payment');
  const paymentData = { token: 'card_token_123456', paymentMethodId: 'visa', installments: 1 };
  await assert.rejects(firstService.startPayment(order.id, { idempotencyKey: paymentKey, paymentData }), /network/);
  const attempt = (await pool.query('SELECT * FROM payment_attempts WHERE order_id=$1', [order.id])).rows[0];
  let recoveryPosts = 0;
  const recoveryProvider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async (url) => {
    if (url.endsWith('/v1/payments/confirmed-1')) return { ok: true, status: 200, json: async () => ({ id: 'confirmed-1', status: 'approved', external_reference: attempt.id }) };
    recoveryPosts += 1; return { ok: true, status: 201, json: async () => ({ id: 'duplicate', status: 'approved' }) };
  } });
  const restarted = new OrderService({ catalogService: createTestCatalog(), orderRepository: repository, paymentProvider: recoveryProvider });
  const retry = await restarted.startPayment(order.id, { idempotencyKey: paymentKey, paymentData });
  assert.equal(retry.status, 'processing'); assert.equal(postCalls, 1); assert.equal(recoveryPosts, 0);
  const reconciled = await restarted.reconcileProviderPayment('confirmed-1');
  assert.equal(reconciled.status, 'paid'); assert.equal(reconciled.paymentId, 'confirmed-1');
});
