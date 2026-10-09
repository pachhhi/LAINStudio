import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { InMemoryOrderRepository } from '../server/orders/order-repository.js';
import { FakePaymentProvider } from '../test-support/fake-payment-provider.js';
import { CartStore } from '../cart-store.js';
import { CartService } from '../cart-service.js';
import { createTestCatalog, testProducts } from '../test-support/catalog-fixture.js';

const item = { productId: 'lain-cap-01', variantId: 'One size', color: 'Black', quantity: 1 };
const customer = { name: 'API User', email: 'api@example.com' };
const deliveryAddress = { street: 'Belgrano', streetNumber: '123', apartmentFloor: '2 A', city: 'Merlo', province: 'Buenos Aires', postalCode: '1722' };
const payload = { items: [item], customer, deliveryMode: 'home_delivery', deliveryAddress, shippingMethodId: 'fake-standard' };
const shippingProvider = { name: 'fake-shipping', isConfigured: () => true, quoteHomeDelivery: async () => [{ id: 'fake-standard', name: 'Standard', carrier: 'Fake Carrier', price: 100, estimatedHours: 24 }] };
const createTestApp = (options = {}) => createApp({ shippingProvider, catalogService: createTestCatalog(), ...options });
const key = value => `integration_${value}_123456`;

test('real checkout HTTP flow creates and reads an order', async () => {
  const app = createTestApp();
  const created = await request(app).post('/api/checkout').set('Idempotency-Key', key('flow')).send(payload).expect(201);
  assert.equal(created.body.order.total, 29100);
  const read = await request(app).get(`/api/public/orders/${created.body.order.publicOrderId}`).expect(200);
  assert.equal(read.body.order.publicOrderId, created.body.order.publicOrderId);
  assert.equal(read.body.order.total, created.body.order.total);
});

test('full CartStore to HTTP repository flow uses only product IDs and quantities', async () => {
  const memory = new Map();
  const store = new CartStore({ getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) });
  const cart = new CartService({ catalog: testProducts, store });
  const repository = new InMemoryOrderRepository();
  cart.add(item);
  const response = await request(createTestApp({ orderRepository: repository })).post('/api/checkout').set('Idempotency-Key', key('fullflow')).send({ ...payload, items: cart.getItems() }).expect(201);
  const stored = await repository.findById(response.body.order.id);
  assert.equal(response.body.order.total, 29100);
  assert.equal(stored.items[0].unitPrice, 29000);
  assert.equal(response.body.order.customer, undefined); assert.equal(response.body.order.items, undefined);
});

test('checkout requires JSON and a valid idempotency key', async () => {
  const app = createTestApp();
  await request(app).post('/api/checkout').send(payload).expect(400);
  await request(app).post('/api/checkout').set('Idempotency-Key', key('content')).type('form').send(payload).expect(400);
});

test('malformed JSON returns a sanitized API error', async () => {
  const response = await request(createTestApp()).post('/api/checkout').set('Idempotency-Key', key('json')).set('Content-Type', 'application/json').send('{').expect(400);
  assert.deepEqual(response.body, { error: 'Invalid JSON request.', code: 'INVALID_JSON' });
  assert.equal(JSON.stringify(response.body).includes('stack'), false);
});

test('body limit, unknown route, wrong method, missing order and source exposure are hardened', async () => {
  const app = createTestApp();
  await request(app).post('/api/checkout').set('Idempotency-Key', key('large')).set('Content-Type', 'application/json').send(JSON.stringify({ padding: 'x'.repeat(40000) })).expect(413);
  await request(app).get('/api/unknown').expect(404);
  const pageNotFound = await request(app).get('/definitely-not-a-page').expect(404);
  assert.match(pageNotFound.text, /404 \/ NO SIGNAL/);
  await request(app).put('/api/checkout').expect(404);
  await request(app).get('/api/public/orders/not-real').expect(404);
  await request(app).get('/api/orders/not-real').expect(404);
  await request(app).get('/server/app.js').expect(404);
});

test('public order access uses an independent identifier and never exposes customer or internal IDs', async () => {
  const app = createTestApp();
  const created = await request(app).post('/api/checkout').set('Idempotency-Key', key('public_access')).send(payload).expect(201);
  const { order } = created.body;
  assert.match(order.publicOrderId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(order.publicOrderId, order.id);
  await request(app).get(`/api/public/orders/${order.id}`).expect(404);
  await request(app).get(`/api/orders/${order.id}`).expect(404);
  const publicResponse = await request(app).get(`/api/public/orders/${order.publicOrderId}`).expect(200);
  assert.deepEqual(Object.keys(publicResponse.body.order).sort(), ['createdAt', 'currency', 'deliveryMode', 'items', 'publicOrderId', 'shipping', 'shippingStatus', 'status', 'subtotal', 'total'].sort());
  const serialized = JSON.stringify(publicResponse.body);
  for (const forbidden of [customer.email, customer.name, 'phone', order.id, 'paymentId', 'paymentProvider', deliveryAddress.street,
    deliveryAddress.streetNumber, deliveryAddress.apartmentFloor, 'deliveryAddress']) assert.equal(serialized.includes(forbidden), false);
  assert.equal(publicResponse.body.order.items[0].productId, undefined);
  const refreshed = await request(app).get(`/api/public/orders/${order.publicOrderId}`).expect(200);
  assert.deepEqual(refreshed.body.order, publicResponse.body.order);
  await request(app).get('/api/public/orders/00000000-0000-4000-8000-000000000000').expect(404);
});

test('each order receives a unique public order identifier', async () => {
  const app = createTestApp();
  const first = (await request(app).post('/api/checkout').set('Idempotency-Key', key('public_unique_a')).send(payload).expect(201)).body.order;
  const second = (await request(app).post('/api/checkout').set('Idempotency-Key', key('public_unique_b')).send(payload).expect(201)).body.order;
  assert.notEqual(first.publicOrderId, second.publicOrderId);
});

test('security headers are present and cross-origin access is not enabled', async () => {
  const response = await request(createTestApp()).get('/api/unknown');
  assert.equal(response.headers['x-powered-by'], undefined);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('health check reports PostgreSQL readiness without exposing diagnostics', async () => {
  const healthy = await request(createTestApp()).get('/health').expect(200);
  assert.deepEqual(healthy.body, { status: 'ok' }); assert.equal(healthy.headers['cache-control'], 'no-store');
  const repository = new InMemoryOrderRepository(); repository.healthCheck = async () => { throw new Error('postgresql://secret'); };
  const unavailable = await request(createTestApp({ orderRepository: repository })).get('/health').expect(503);
  assert.deepEqual(unavailable.body, { status: 'unavailable' }); assert.equal(JSON.stringify(unavailable.body).includes('secret'), false);
});

test('idempotent duplicate and concurrent checkout requests return one order', async () => {
  const repository = new InMemoryOrderRepository(); const app = createTestApp({ orderRepository: repository });
  const idempotencyKey = key('duplicate');
  const responses = await Promise.all(Array.from({ length: 12 }, () => request(app).post('/api/checkout').set('Idempotency-Key', idempotencyKey).send(payload)));
  assert.equal(responses.every(response => response.status === 201), true);
  assert.equal(new Set(responses.map(response => response.body.order.id)).size, 1);
  assert.equal(repository.count(), 1);
});

test('reuse of an idempotency key with another payload returns 409', async () => {
  const app = createTestApp(); const idempotencyKey = key('conflict');
  await request(app).post('/api/checkout').set('Idempotency-Key', idempotencyKey).send(payload).expect(201);
  const response = await request(app).post('/api/checkout').set('Idempotency-Key', idempotencyKey).send({ ...payload, items: [{ ...item, quantity: 2 }] }).expect(409);
  assert.equal(response.body.code, 'CONFLICT');
});

test('mass assignment and prototype pollution payloads cannot alter the order or globals', async () => {
  const repository = new InMemoryOrderRepository();
  const attackObject = {
    items: [{ ...item, price: 1, unitPrice: 1, constructor: { prototype: { polluted: true } } }],
    customer, deliveryMode: 'home_delivery', deliveryAddress, shippingMethodId: 'fake-standard', shipping: { price: 1 }, total: 1, status: 'paid', paymentProvider: 'fake', paymentId: 'x', id: 'owned',
    constructor: { prototype: { polluted: true } }, prototype: { polluted: true }
  };
  Object.defineProperty(attackObject, '__proto__', { value: { polluted: true }, enumerable: true });
  const attack = JSON.stringify(attackObject);
  const response = await request(createTestApp({ orderRepository: repository })).post('/api/checkout').set('Idempotency-Key', key('pollution')).set('Content-Type', 'application/json').send(attack).expect(201);
  const stored = await repository.findById(response.body.order.id);
  assert.equal(response.body.order.total, 29100); assert.equal(response.body.order.shipping, undefined); assert.equal(response.body.order.status, 'pending'); assert.notEqual(response.body.order.id, 'owned');
  assert.equal(stored.shipping.price, 100);
  assert.equal({}.polluted, undefined);
});

test('repository failures return generic 500 and are logged without a stack response', async () => {
  const logs = [];
  const repository = new InMemoryOrderRepository(); repository.save = () => { throw new Error('database password=do-not-leak'); };
  const response = await request(createTestApp({ orderRepository: repository, logger: { error: (...args) => logs.push(args) } })).post('/api/checkout').set('Idempotency-Key', key('repo')).send(payload).expect(500);
  assert.deepEqual(response.body, { error: 'Internal server error.', code: 'INTERNAL_ERROR' });
  assert.equal(JSON.stringify(response.body).includes('password'), false); assert.equal(JSON.stringify(logs).includes('do-not-leak'), false); assert.equal(logs.length, 1);
});

test('payment endpoint is backend-idempotent under concurrent HTTP requests', async () => {
  const provider = new FakePaymentProvider('approved', { delay: 20 }); const app = createTestApp({ paymentProvider: provider });
  const order = (await request(app).post('/api/checkout').set('Idempotency-Key', key('payorder')).send(payload)).body.order;
  const paymentKey = key('payment');
  const responses = await Promise.all(Array.from({ length: 8 }, () => request(app).post(`/api/orders/${order.id}/payments`).set('Idempotency-Key', paymentKey).send({})));
  assert.equal(responses.every(response => response.status === 200), true); assert.equal(provider.calls, 1);
});

test('disabled payment mode exposes no provider and rejects every payment operation', async () => {
  const repository = new InMemoryOrderRepository();
  const app = createTestApp({ orderRepository: repository, paymentProvider: null, paymentPublicKey: '', publicBaseUrl: 'https://lain.example' });
  const config = await request(app).get('/api/payments/config').expect(200);
  assert.deepEqual(config.body, { configured: false, provider: 'none', environment: 'disabled', publicKey: '' });
  const order = (await request(app).post('/api/checkout').set('Idempotency-Key', key('disabled_payment_order')).send(payload).expect(201)).body.order;
  await request(app).post(`/api/orders/${order.id}/payments`).set('Idempotency-Key', key('disabled_card')).send({}).expect(502);
  await request(app).post(`/api/orders/${order.id}/checkout-pro`).set('Idempotency-Key', key('disabled_hosted')).send({}).expect(502);
  assert.deepEqual(await repository.listPaymentAttemptsForOrder(order.id), []);
  assert.equal((await repository.findById(order.id)).status, 'pending');
});

test('hosted checkout endpoint returns only the durable order and validated redirect', async () => {
  const provider = new FakePaymentProvider('pending');
  const app = createTestApp({ paymentProvider: provider, publicBaseUrl: 'https://lain.example' });
  const order = (await request(app).post('/api/checkout').set('Idempotency-Key', key('hosted_order')).send(payload)).body.order;
  const paymentKey = key('hosted_payment');
  const first = await request(app).post(`/api/orders/${order.id}/checkout-pro`).set('Idempotency-Key', paymentKey).send({ injectedStatus: 'approved' }).expect(200);
  const second = await request(app).post(`/api/orders/${order.id}/checkout-pro`).set('Idempotency-Key', paymentKey).send({}).expect(200);
  assert.equal(provider.calls, 1); assert.equal(first.body.checkoutUrl, second.body.checkoutUrl);
  assert.deepEqual(Object.keys(first.body).sort(), ['checkoutUrl', 'order']);
  assert.equal(provider.lastHostedContext.returnUrls.successUrl, `https://lain.example/order.html?id=${order.publicOrderId}`);
  assert.equal(first.body.order.status, 'processing');
});

test('hosted checkout requires a configured HTTPS public base URL', async () => {
  const provider = new FakePaymentProvider('pending');
  for (const publicBaseUrl of ['', 'http://lain.example']) {
    const app = createTestApp({ paymentProvider: provider, publicBaseUrl });
    const order = (await request(app).post('/api/checkout').set('Idempotency-Key', key(`bad_base_${publicBaseUrl.length}`)).send(payload)).body.order;
    await request(app).post(`/api/orders/${order.id}/checkout-pro`).set('Idempotency-Key', key(`bad_payment_${publicBaseUrl.length}`)).send({}).expect(400);
  }
  assert.equal(provider.calls, 0);
});
