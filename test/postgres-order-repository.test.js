import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresOrderRepository } from '../server/orders/postgres-order-repository.js';
import { OrderService } from '../server/orders/order-service.js';
import { createTestCatalog } from '../test-support/catalog-fixture.js';
import { MercadoPagoProvider } from '../server/payments/mercadopago-provider.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL tests. Use npm run test:postgres or npm run test:all.');
const databaseName = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
if (!/test/i.test(databaseName) || process.env.DATABASE_URL === connectionString) throw new Error('Refusing to run PostgreSQL tests against a non-test database.');
const pool = new pg.Pool({ connectionString });
const repository = new PostgresOrderRepository({ pool });
const customer = { name: "Robert'); DROP TABLE orders;--", email: 'db@example.com', phone: '+54 11 5555-5555' };
const item = { productId: 'lain-cap-01', variantId: 'One size', color: 'Black', quantity: 1 };
const payload = { items: [item], customer };
const key = suffix => `postgres_key_${suffix}_123456`;
const options = {};

function service(repo = repository) { return new OrderService({ catalogService: createTestCatalog(), orderRepository: repo }); }

beforeEach(async () => {
  await pool.query('TRUNCATE payment_attempts, idempotency_keys, order_items, orders RESTART IDENTITY CASCADE');
});
after(async () => { await pool.end(); });

test('creates and retrieves a durable order with items and SQL-safe customer input', options, async () => {
  const created = await service().create(payload, { idempotencyKey: key('create') });
  const found = await repository.findById(created.id);
  assert.deepEqual(found, created); assert.equal(found.items[0].unitPrice, 29000);
  assert.equal(found.deliveryMode, 'coordinate'); assert.equal(found.shippingStatus, 'coordination_pending'); assert.equal(found.total, found.subtotal);
  assert.deepEqual(await repository.findByPublicOrderId(created.publicOrderId), created);
  assert.equal((await pool.query("SELECT to_regclass('public.orders') AS table_name")).rows[0].table_name, 'orders');
});

test('PostgreSQL persists home delivery and enforces coherent delivery combinations', options, async () => {
  const deliveryAddress = { street: 'Belgrano', streetNumber: '123', apartmentFloor: '', city: 'Merlo', province: 'Buenos Aires', postalCode: '1722' };
  const shipping = { provider: 'enviopack', service: 'Standard', carrier: 'Carrier', price: 1000, estimatedHours: 24,
    postalCode: '1722', province: 'Buenos Aires', quotedAt: new Date().toISOString() };
  const created = await service().create(payload, { idempotencyKey: key('home_delivery'), deliveryMode: 'home_delivery',
    shippingStatus: 'selected', shipping, deliveryAddress, fingerprintShipping: { deliveryMode: 'home_delivery', deliveryAddress, shippingMethodId: 'standard' } });
  const found = await repository.findById(created.id);
  assert.equal(found.deliveryMode, 'home_delivery'); assert.equal(found.shippingStatus, 'selected');
  assert.equal(found.shipping.price, 1000); assert.equal(found.total, found.subtotal + 1000); assert.deepEqual(found.deliveryAddress, deliveryAddress);
  await assert.rejects(pool.query(`UPDATE orders SET delivery_mode='coordinate' WHERE id=$1`, [created.id]), /constraint/i);
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

test('late failure cannot overwrite a reconciled approval and repeated approval is idempotent', options, async () => {
  const order = await service().create(payload, { idempotencyKey: key('late_failure_order') });
  const claim = await repository.beginPayment({ orderId: order.id, key: `payment:${key('late_failure_attempt')}`, fingerprint: order.id, provider: 'fake' });
  const processing = await repository.findById(order.id);
  const paid = await repository.reconcilePayment({ attemptId: claim.attemptId, expectedOrderVersion: processing.version,
    expectedOrderStatus: 'awaiting_payment', providerPaymentId: 'PAY-RACE', providerOrderId: 'ORDTSTRACE',
    paymentStatus: 'approved', orderStatus: 'paid' });
  await repository.failPayment({ attemptId: claim.attemptId, orderId: order.id });
  const repeated = await repository.completePayment({ attemptId: claim.attemptId, orderId: order.id, status: 'approved', orderStatus: 'paid',
    providerPaymentId: 'PAY-RACE', providerOrderId: 'ORDTSTRACE', provider: 'fake' });
  assert.equal(paid.status, 'paid'); assert.equal(repeated.status, 'paid');
  assert.equal((await pool.query('SELECT status FROM payment_attempts WHERE id=$1', [claim.attemptId])).rows[0].status, 'approved');
});

test('processing and failure updates cannot downgrade refunded or chargeback attempts', options, async () => {
  for (const terminal of ['refunded', 'chargeback']) {
    const order = await service().create(payload, { idempotencyKey: key(`terminal_${terminal}`) });
    const claim = await repository.beginPayment({ orderId: order.id, key: `payment:${key(`terminal_attempt_${terminal}`)}`, fingerprint: order.id, provider: 'fake' });
    await pool.query('UPDATE payment_attempts SET status=$2 WHERE id=$1', [claim.attemptId, terminal]);
    await pool.query('UPDATE orders SET status=$2 WHERE id=$1', [order.id, terminal]);
    await repository.failPayment({ attemptId: claim.attemptId, orderId: order.id });
    await repository.markPaymentProcessing({ attemptId: claim.attemptId, orderId: order.id });
    assert.equal((await pool.query('SELECT status FROM payment_attempts WHERE id=$1', [claim.attemptId])).rows[0].status, terminal);
    assert.equal((await repository.findById(order.id)).status, terminal);
  }
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
    sent = request; return { ok: true, status: 201, json: async () => ({ id: 'ORDTST987', status: 'processed', status_detail: 'accredited',
      external_reference: JSON.parse(request.body).external_reference, transactions: { payments: [{ id: 'PAY987', status: 'processed', status_detail: 'accredited' }] } }) };
  } });
  const orders = new OrderService({ catalogService: createTestCatalog(), orderRepository: repository, paymentProvider: provider });
  const order = await orders.create(payload, { idempotencyKey: key('mp_order') });
  const paid = await orders.startPayment(order.id, { idempotencyKey: key('mp_payment'), paymentData: { token: 'card_token_123456', paymentMethodId: 'visa', paymentTypeId: 'credit_card', installments: 1 } });
  const attempt = (await pool.query('SELECT * FROM payment_attempts WHERE order_id=$1', [order.id])).rows[0];
  assert.equal(paid.status, 'paid'); assert.equal(attempt.provider_payment_id, 'PAY987'); assert.equal(attempt.provider_order_id, 'ORDTST987');
  assert.equal(paid.paymentId, 'PAY987'); assert.equal(paid.providerOrderId, 'ORDTST987');
  assert.equal(attempt.provider_idempotency_key, attempt.id);
  assert.equal(sent.headers['X-Idempotency-Key'], attempt.id);
});

test('timeout remains recoverable across OrderService restart without a second POST', options, async () => {
  let postCalls = 0;
  const timeoutProvider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => { postCalls += 1; throw new Error('network'); } });
  const firstService = new OrderService({ catalogService: createTestCatalog(), orderRepository: repository, paymentProvider: timeoutProvider });
  const order = await firstService.create(payload, { idempotencyKey: key('timeout_order') }); const paymentKey = key('timeout_payment');
  const paymentData = { token: 'card_token_123456', paymentMethodId: 'visa', paymentTypeId: 'credit_card', installments: 1 };
  await assert.rejects(firstService.startPayment(order.id, { idempotencyKey: paymentKey, paymentData }), /network/);
  const attempt = (await pool.query('SELECT * FROM payment_attempts WHERE order_id=$1', [order.id])).rows[0];
  let recoveryPosts = 0;
  const recoveryProvider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async (url) => {
    if (url.endsWith('/v1/orders/ORDTSTCONFIRMED1')) return { ok: true, status: 200, json: async () => ({ id: 'ORDTSTCONFIRMED1', status: 'processed', status_detail: 'accredited', total_amount: '29000.00', external_reference: attempt.id,
      transactions: { payments: [{ id: 'PAY-confirmed-1', status: 'processed', status_detail: 'accredited' }] } }) };
    recoveryPosts += 1; return { ok: true, status: 201, json: async () => ({}) };
  } });
  const restarted = new OrderService({ catalogService: createTestCatalog(), orderRepository: repository, paymentProvider: recoveryProvider });
  const retry = await restarted.startPayment(order.id, { idempotencyKey: paymentKey, paymentData });
  assert.equal(retry.status, 'processing'); assert.equal(postCalls, 1); assert.equal(recoveryPosts, 0);
  const reconciled = await restarted.reconcileProviderPayment('ORDTSTCONFIRMED1');
  assert.equal(reconciled.status, 'paid'); assert.equal(reconciled.paymentId, 'PAY-confirmed-1');
  assert.equal(reconciled.providerOrderId, 'ORDTSTCONFIRMED1');
  const reconciledAttempt = (await pool.query('SELECT provider_order_id,provider_payment_id FROM payment_attempts WHERE id=$1', [attempt.id])).rows[0];
  assert.deepEqual(reconciledAttempt, { provider_order_id: 'ORDTSTCONFIRMED1', provider_payment_id: 'PAY-confirmed-1' });
});

test('PostgreSQL reconciliation claims exclude concurrent backend processes', options, async () => {
  const order = await service().create(payload, { idempotencyKey: key('reconcile_claim_order') });
  await repository.beginPayment({ orderId: order.id, key: `payment:${key('reconcile_claim')}`, fingerprint: order.id, provider: 'mercadopago' });
  const other = new PostgresOrderRepository({ pool: new pg.Pool({ connectionString }) });
  try {
    const [first, second] = await Promise.all([
      repository.claimPaymentReconciliationBatch({ provider: 'mercadopago' }),
      other.claimPaymentReconciliationBatch({ provider: 'mercadopago' })
    ]);
    assert.equal(first.length + second.length, 1);
    assert.equal(new Set([...first, ...second].map(attempt => attempt.id)).size, 1);
  } finally { await other.close(); }
});

test('expired reconciliation lease is recoverable after backend restart and retry limit is durable', options, async () => {
  const order = await service().create(payload, { idempotencyKey: key('reconcile_restart_order') });
  await repository.beginPayment({ orderId: order.id, key: `payment:${key('reconcile_restart')}`, fingerprint: order.id, provider: 'mercadopago' });
  const [abandoned] = await repository.claimPaymentReconciliationBatch({ provider: 'mercadopago', lockSeconds: 90, maxFailures: 1 });
  await pool.query('UPDATE payment_attempts SET reconciliation_locked_until=now()-interval \'1 second\' WHERE id=$1', [abandoned.id]);
  const restarted = new PostgresOrderRepository({ pool: new pg.Pool({ connectionString }) });
  try {
    const [recovered] = await restarted.claimPaymentReconciliationBatch({ provider: 'mercadopago', maxFailures: 1 });
    assert.equal(recovered.id, abandoned.id);
    const released = await restarted.releasePaymentReconciliation({ attemptId: recovered.id, lockId: recovered.lockId,
      outcome: 'transient_error', retryAt: new Date(Date.now() + 60_000).toISOString(), errorCode: 'PROVIDER_UNAVAILABLE', maxFailures: 1 });
    assert.deepEqual(released, { reconciliation_failures: 1, reconciliation_needs_review: true });
    assert.equal((await restarted.claimPaymentReconciliationBatch({ provider: 'mercadopago', maxFailures: 1 })).length, 0);
    const reviews = await restarted.listPaymentAttemptsNeedingReview();
    assert.equal(reviews.length, 1); assert.equal(reviews[0].id, recovered.id);
    assert.equal(reviews[0].reconciliationLastError, 'PROVIDER_UNAVAILABLE'); assert.equal(reviews[0].reconciliationFailures, 1);
    const detail = await restarted.listPaymentAttemptsForOrder(order.id);
    assert.equal(detail.length, 1); assert.equal(detail[0].reconciliationNeedsReview, true);
  } finally { await restarted.close(); }
});

test('recent approved payments are periodically claimable while expired monitoring windows are not', options, async () => {
  const order = await service().create(payload, { idempotencyKey: key('approved_monitor_order') });
  const claim = await repository.beginPayment({ orderId: order.id, key: `payment:${key('approved_monitor')}`,
    fingerprint: order.id, provider: 'mercadopago' });
  await repository.completePayment({ attemptId: claim.attemptId, orderId: order.id, status: 'approved', orderStatus: 'paid',
    providerPaymentId: 'PAY-MONITOR', providerOrderId: 'ORDTSTMONITOR', provider: 'mercadopago' });
  await pool.query('UPDATE payment_attempts SET reconciliation_next_at=now()-interval \'1 second\' WHERE id=$1', [claim.attemptId]);
  const [recent] = await repository.claimPaymentReconciliationBatch({ provider: 'mercadopago' });
  assert.equal(recent.id, claim.attemptId); assert.equal(recent.status, 'approved');
  await repository.releasePaymentReconciliation({ attemptId: recent.id, lockId: recent.lockId, outcome: 'success',
    retryAt: new Date(Date.now() + 6 * 3600_000).toISOString() });
  await pool.query(`UPDATE payment_attempts SET reconciliation_monitor_until=now()-interval '1 second',
    reconciliation_next_at=now()-interval '1 second' WHERE id=$1`, [claim.attemptId]);
  assert.equal((await repository.claimPaymentReconciliationBatch({ provider: 'mercadopago' })).length, 0);
});

test('PostgreSQL persists partial refund and chargeback lifecycle states', options, async () => {
  const order = await service().create(payload, { idempotencyKey: key('post_payment_states_order') });
  const claim = await repository.beginPayment({ orderId: order.id, key: `payment:${key('post_payment_states')}`,
    fingerprint: order.id, provider: 'mercadopago' });
  await repository.completePayment({ attemptId: claim.attemptId, orderId: order.id, status: 'approved', orderStatus: 'paid',
    providerPaymentId: 'PAY-STATES', providerOrderId: 'ORDTSTSTATES', provider: 'mercadopago' });
  const paid = await repository.findById(order.id);
  const partial = await repository.reconcilePayment({ attemptId: claim.attemptId, expectedOrderVersion: paid.version,
    expectedOrderStatus: 'paid', providerPaymentId: 'PAY-STATES', providerOrderId: 'ORDTSTSTATES',
    paymentStatus: 'partially_refunded', orderStatus: 'partially_refunded' });
  const chargeback = await repository.reconcilePayment({ attemptId: claim.attemptId, expectedOrderVersion: partial.version,
    expectedOrderStatus: 'partially_refunded', providerPaymentId: 'PAY-STATES', providerOrderId: 'ORDTSTSTATES',
    paymentStatus: 'chargeback', orderStatus: 'chargeback' });
  assert.equal(chargeback.status, 'chargeback');
  assert.equal((await pool.query('SELECT status FROM payment_attempts WHERE id=$1', [claim.attemptId])).rows[0].status, 'chargeback');
});
