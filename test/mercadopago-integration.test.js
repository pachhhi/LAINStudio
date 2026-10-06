import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { InMemoryOrderRepository } from '../server/orders/order-repository.js';
import { OrderService } from '../server/orders/order-service.js';
import { CatalogService } from '../server/catalog/catalog-service.js';
import { FakePaymentProvider } from '../test-support/fake-payment-provider.js';
import { MercadoPagoProvider } from '../server/payments/mercadopago-provider.js';
import { createTestCatalog } from '../test-support/catalog-fixture.js';

const shippingProvider = { name: 'fake-shipping', isConfigured: () => true, quoteHomeDelivery: async () => [{ id: 'fake-standard', name: 'Standard', carrier: 'Fake Carrier', price: 100, estimatedHours: 24 }] };
const payload = { items: [{ productId: 'lain-cap-01', variantId: 'One size', color: 'Black', quantity: 1 }], customer: { name: 'Test', email: 'test@testuser.com' },
  deliveryAddress: { street: 'Belgrano', streetNumber: '123', apartmentFloor: '', city: 'Merlo', province: 'Buenos Aires', postalCode: '1722' }, shippingMethodId: 'fake-standard' };
const secret = 'integration-webhook-secret';
const sign = (dataId, requestId, ts = '1704908010') => `ts=${ts},v1=${createHmac('sha256', secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex')}`;

async function createPendingPayment() {
  const provider = new FakePaymentProvider('pending'); const repository = new InMemoryOrderRepository();
  const app = createApp({ orderRepository: repository, paymentProvider: provider, paymentPublicKey: 'TEST-public', webhookSecret: secret, shippingProvider, catalogService: createTestCatalog() });
  const order = (await request(app).post('/api/checkout').set('Idempotency-Key', 'mp_order_key_123456').send(payload)).body.order;
  const pending = (await request(app).post(`/api/orders/${order.id}/payments`).set('Idempotency-Key', 'mp_payment_key_123456').send({ token: 'ignored-by-fake' })).body.order;
  return { app, provider, order: pending };
}

test('payment config exposes only public test configuration', async () => {
  const app = createApp({ paymentProvider: new FakePaymentProvider(), paymentPublicKey: 'TEST-public', webhookSecret: secret, shippingProvider, catalogService: createTestCatalog() });
  const result = await request(app).get('/api/payments/config').expect(200);
  assert.deepEqual(result.body, { provider: 'fake', environment: 'test', publicKey: 'TEST-public' });
  assert.equal(JSON.stringify(result.body).includes(secret), false);
});

test('valid webhook confirms pending payment and duplicate events are idempotent', async () => {
  const { app, provider, order } = await createPendingPayment(); assert.equal(order.status, 'processing');
  provider.behavior = 'approved'; const requestId = 'webhook-request-1'; const path = '/api/webhooks/mercadopago?data.id=fake-1';
  for (let index = 0; index < 3; index += 1) await request(app).post(path).set('x-request-id', requestId).set('x-signature', sign('fake-1', requestId)).send({ type: 'payment', data: { id: 'fake-1' } }).expect(200);
  const confirmed = await request(app).get(`/api/public/orders/${order.publicOrderId}`).expect(200); assert.equal(confirmed.body.order.status, 'paid');
});

test('invalid signatures are rejected and unknown payments are acknowledged safely', async () => {
  const { app } = await createPendingPayment();
  await request(app).post('/api/webhooks/mercadopago?data.id=fake-1').set('x-request-id', 'x').set('x-signature', 'bad').send({ type: 'payment' }).expect(401);
  const requestId = 'unknown-request';
  await request(app).post('/api/webhooks/mercadopago?data.id=unknown').set('x-request-id', requestId).set('x-signature', sign('unknown', requestId)).send({ type: 'payment' }).expect(202);
});

test('late pending webhook cannot downgrade a paid order', async () => {
  const { app, provider, order } = await createPendingPayment(); const requestId = 'ordered-events';
  provider.behavior = 'approved'; await request(app).post('/api/webhooks/mercadopago?data.id=fake-1').set('x-request-id', requestId).set('x-signature', sign('fake-1', requestId)).send({ type: 'payment' }).expect(200);
  provider.behavior = 'pending'; await request(app).post('/api/webhooks/mercadopago?data.id=fake-1').set('x-request-id', requestId).set('x-signature', sign('fake-1', requestId)).send({ type: 'payment' }).expect(200);
  assert.equal((await request(app).get(`/api/public/orders/${order.publicOrderId}`)).body.order.status, 'paid');
});

test('confirmed refund advances paid order to refunded through the state machine', async () => {
  const { app, provider, order } = await createPendingPayment(); const requestId = 'refund-events'; const path = '/api/webhooks/mercadopago?data.id=fake-1';
  provider.behavior = 'approved'; await request(app).post(path).set('x-request-id', requestId).set('x-signature', sign('fake-1', requestId)).send({ type: 'payment' }).expect(200);
  provider.behavior = 'refunded'; await request(app).post(path).set('x-request-id', requestId).set('x-signature', sign('fake-1', requestId)).send({ type: 'payment' }).expect(200);
  assert.equal((await request(app).get(`/api/public/orders/${order.publicOrderId}`)).body.order.status, 'refunded');
});

test('production-mode and mismatched webhook payloads are rejected', async () => {
  const { app } = await createPendingPayment(); const requestId = 'security-events';
  await request(app).post('/api/webhooks/mercadopago?data.id=fake-1').set('x-request-id', requestId).set('x-signature', sign('fake-1', requestId)).send({ type: 'payment', live_mode: true, data: { id: 'fake-1' } }).expect(403);
  await request(app).post('/api/webhooks/mercadopago?data.id=fake-1').set('x-request-id', requestId).set('x-signature', sign('fake-1', requestId)).send({ type: 'payment', data: { id: 'different' } }).expect(400);
});

test('indeterminate provider timeout stays recoverable and retry does not POST twice', async () => {
  let calls = 0;
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => { calls += 1; throw new Error('network timeout'); } });
  const repository = new InMemoryOrderRepository(); const orders = new OrderService({ catalogService: createTestCatalog(), orderRepository: repository, paymentProvider: provider });
  const order = orders.create(payload); const options = { idempotencyKey: 'timeout_payment_key_1234', paymentData: { token: 'card_token_123456', paymentMethodId: 'visa', installments: 1 } };
  await assert.rejects(orders.startPayment(order.id, options), /network/);
  assert.equal((await orders.getById(order.id)).status, 'processing');
  const retry = await orders.startPayment(order.id, options); assert.equal(retry.status, 'processing'); assert.equal(calls, 1);
});
