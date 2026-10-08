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
import { DependencyError } from '../server/errors.js';
import { createTestCatalog } from '../test-support/catalog-fixture.js';

const shippingProvider = { name: 'fake-shipping', isConfigured: () => true, quoteHomeDelivery: async () => [{ id: 'fake-standard', name: 'Standard', carrier: 'Fake Carrier', price: 100, estimatedHours: 24 }] };
const payload = { items: [{ productId: 'lain-cap-01', variantId: 'One size', color: 'Black', quantity: 1 }], customer: { name: 'Test', email: 'test@testuser.com' },
  deliveryAddress: { street: 'Belgrano', streetNumber: '123', apartmentFloor: '', city: 'Merlo', province: 'Buenos Aires', postalCode: '1722' }, shippingMethodId: 'fake-standard' };
const secret = 'integration-webhook-secret';
const sign = (dataId, requestId, ts = '1704908010') => `ts=${ts},v1=${createHmac('sha256', secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex')}`;
const providerOrderId = 'ORDTSTFAKE1';
const orderWebhook = (overrides = {}) => ({
  action: 'order.processed', api_version: 'v1', live_mode: false, type: 'order',
  data: { id: providerOrderId, status: 'processed', status_detail: 'accredited', ...overrides }
});
const webhookPath = `/api/webhooks/mercadopago?data.id=${providerOrderId}&type=order`;

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
  assert.deepEqual(result.body, { configured: false, provider: 'none', environment: 'disabled', publicKey: '' });
  assert.equal(JSON.stringify(result.body).includes(secret), false);
});

test('Mercado Pago config reports configured and exposes only its public key', async () => {
  const provider = new FakePaymentProvider(); provider.name = 'mercadopago';
  const app = createApp({ paymentProvider: provider, paymentPublicKey: 'TEST-public', webhookSecret: '', shippingProvider, catalogService: createTestCatalog() });
  const result = await request(app).get('/api/payments/config').expect(200);
  assert.deepEqual(result.body, { configured: true, provider: 'mercadopago', environment: 'test', publicKey: 'TEST-public' });
  assert.equal(JSON.stringify(result.body).includes(secret), false);
});

test('Mercado Pago production config exposes only the production public key and validates production webhook IDs', async () => {
  const provider = new FakePaymentProvider(); provider.name = 'mercadopago'; provider.environment = 'production';
  const app = createApp({ paymentProvider: provider, paymentPublicKey: 'PROD-public', paymentEnvironment: 'production',
    webhookSecret: secret, shippingProvider, catalogService: createTestCatalog() });
  const config = await request(app).get('/api/payments/config').expect(200);
  assert.deepEqual(config.body, { configured: true, provider: 'mercadopago', environment: 'production', publicKey: 'PROD-public' });
  const requestId = 'production-id-validation';
  await request(app).post(`/api/webhooks/mercadopago?data.id=${providerOrderId}&type=order`).set('x-request-id', requestId)
    .set('x-signature', sign(providerOrderId, requestId)).send(orderWebhook()).expect(400);
});

test('valid webhook confirms pending payment and duplicate events are idempotent', async () => {
  const { app, provider, order } = await createPendingPayment(); assert.equal(order.status, 'processing');
  provider.behavior = 'approved'; const requestId = 'webhook-request-1';
  for (let index = 0; index < 3; index += 1) await request(app).post(webhookPath).set('x-request-id', requestId)
    .set('x-signature', sign(providerOrderId, requestId)).send(orderWebhook()).expect(200);
  const confirmed = await request(app).get(`/api/public/orders/${order.publicOrderId}`).expect(200); assert.equal(confirmed.body.order.status, 'paid');
});

test('pending Orders webhook preserves processing until a later approved transition', async () => {
  const { app, provider, order } = await createPendingPayment(); const requestId = 'pending-order-event';
  await request(app).post(webhookPath).set('x-request-id', requestId).set('x-signature', sign(providerOrderId, requestId))
    .send(orderWebhook({ status: 'processing', status_detail: 'in_process' })).expect(200);
  assert.equal((await request(app).get(`/api/public/orders/${order.publicOrderId}`)).body.order.status, 'processing');
  provider.behavior = 'approved';
  await request(app).post(webhookPath).set('x-request-id', requestId).set('x-signature', sign(providerOrderId, requestId))
    .send(orderWebhook()).expect(200);
  assert.equal((await request(app).get(`/api/public/orders/${order.publicOrderId}`)).body.order.status, 'paid');
});

test('invalid signatures fail closed', async () => {
  const { app } = await createPendingPayment();
  await request(app).post(webhookPath).set('x-request-id', 'x').set('x-signature', 'bad').send(orderWebhook()).expect(401);
});

test('authenticated Mercado Pago simulation is acknowledged without querying or modifying orders', async () => {
  const { app, provider, order } = await createPendingPayment(); const dataId = '123456'; const requestId = 'simulation-request';
  provider.behavior = 'approved';
  const result = await request(app).post(`/api/webhooks/mercadopago?data.id=${dataId}&type=order`).set('x-request-id', requestId)
    .set('x-signature', sign(dataId, requestId)).send({ action: 'order.processed', live_mode: true, type: 'order', data: { id: dataId } }).expect(202);
  assert.deepEqual(result.body, { received: true, simulation: true });
  assert.equal((await request(app).get(`/api/public/orders/${order.publicOrderId}`)).body.order.status, 'processing');
});

test('unknown TEST order is queried and acknowledged without modifying local orders', async () => {
  const { app, order } = await createPendingPayment(); const dataId = 'ORDTSTUNKNOWN1'; const requestId = 'unknown-request';
  await request(app).post(`/api/webhooks/mercadopago?data.id=${dataId}&type=order`).set('x-request-id', requestId)
    .set('x-signature', sign(dataId, requestId)).send(orderWebhook({ id: dataId })).expect(202);
  assert.equal((await request(app).get(`/api/public/orders/${order.publicOrderId}`)).body.order.status, 'processing');
});

test('provider lookup failure remains a retryable dependency error', async () => {
  const { app, provider } = await createPendingPayment(); const requestId = 'lookup-failure';
  provider.getPaymentStatus = async () => { throw new DependencyError('Temporary provider lookup failure.'); };
  await request(app).post(webhookPath).set('x-request-id', requestId).set('x-signature', sign(providerOrderId, requestId))
    .send(orderWebhook()).expect(502);
});

test('late pending webhook cannot downgrade a paid order', async () => {
  const { app, provider, order } = await createPendingPayment(); const requestId = 'ordered-events';
  provider.behavior = 'approved'; await request(app).post(webhookPath).set('x-request-id', requestId).set('x-signature', sign(providerOrderId, requestId)).send(orderWebhook()).expect(200);
  provider.behavior = 'pending'; await request(app).post(webhookPath).set('x-request-id', requestId).set('x-signature', sign(providerOrderId, requestId)).send(orderWebhook({ status: 'processing', status_detail: 'in_process' })).expect(200);
  assert.equal((await request(app).get(`/api/public/orders/${order.publicOrderId}`)).body.order.status, 'paid');
});

test('confirmed refund advances paid order to refunded through the state machine', async () => {
  const { app, provider, order } = await createPendingPayment(); const requestId = 'refund-events';
  provider.behavior = 'approved'; await request(app).post(webhookPath).set('x-request-id', requestId).set('x-signature', sign(providerOrderId, requestId)).send(orderWebhook()).expect(200);
  provider.behavior = 'refunded'; await request(app).post(webhookPath).set('x-request-id', requestId).set('x-signature', sign(providerOrderId, requestId)).send(orderWebhook({ status_detail: 'refunded' })).expect(200);
  assert.equal((await request(app).get(`/api/public/orders/${order.publicOrderId}`)).body.order.status, 'refunded');
});

test('non-TEST and mismatched webhook payloads are rejected', async () => {
  const { app } = await createPendingPayment(); const requestId = 'security-events';
  const liveId = 'ORDLIVE123';
  await request(app).post(`/api/webhooks/mercadopago?data.id=${liveId}&type=order`).set('x-request-id', requestId)
    .set('x-signature', sign(liveId, requestId)).send({ ...orderWebhook({ id: liveId }), live_mode: true }).expect(400);
  await request(app).post(webhookPath).set('x-request-id', requestId).set('x-signature', sign(providerOrderId, requestId)).send(orderWebhook({ id: 'ORD-different' })).expect(400);
  await request(app).post(`/api/webhooks/mercadopago?data.id=${providerOrderId}&type=payment`).set('x-request-id', requestId)
    .set('x-signature', sign(providerOrderId, requestId)).send(orderWebhook()).expect(400);
});

test('legacy payment-topic webhook is acknowledged without reconciling an Orders payment', async () => {
  const { app, provider, order } = await createPendingPayment(); const requestId = 'legacy-payment-topic';
  provider.behavior = 'approved';
  await request(app).post(`/api/webhooks/mercadopago?data.id=${providerOrderId}&type=payment`).set('x-request-id', requestId)
    .set('x-signature', sign(providerOrderId, requestId)).send({ type: 'payment', data: { id: providerOrderId } }).expect(200);
  assert.equal((await request(app).get(`/api/public/orders/${order.publicOrderId}`)).body.order.status, 'processing');
});

test('indeterminate provider timeout stays recoverable and retry does not POST twice', async () => {
  let calls = 0;
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => { calls += 1; throw new Error('network timeout'); } });
  const repository = new InMemoryOrderRepository(); const orders = new OrderService({ catalogService: createTestCatalog(), orderRepository: repository, paymentProvider: provider });
  const order = orders.create(payload); const options = { idempotencyKey: 'timeout_payment_key_1234', paymentData: { token: 'card_token_123456', paymentMethodId: 'visa', paymentTypeId: 'credit_card', installments: 1 } };
  await assert.rejects(orders.startPayment(order.id, options), /network/);
  assert.equal((await orders.getById(order.id)).status, 'processing');
  const retry = await orders.startPayment(order.id, options); assert.equal(retry.status, 'processing'); assert.equal(calls, 1);
});

test('Mercado Pago Orders request uses the TEST payer without changing the order', async () => {
  let sentBody;
  const logs = [];
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', logger: { info: (...args) => logs.push(args) },
    fetchImpl: async (_url, options) => {
      sentBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: 'ORDTST01', status: 'processed', status_detail: 'accredited', external_reference: 'attempt-1',
        transactions: { payments: [{ id: 'PAY01', status: 'processed', status_detail: 'accredited' }] } }), { status: 201 });
    } });
  const order = { id: 'order-1', total: 1000, currency: 'ARS', customer: { email: 'real-customer@example.com' } };
  await provider.createPayment(order, { paymentAttemptId: 'attempt-1', providerIdempotencyKey: 'provider-key-1',
    paymentData: { token: 'card_token_123456', paymentMethodId: 'master', paymentTypeId: 'credit_card', installments: 1,
      identification: { type: 'DNI', number: '12345678' } } });
  assert.equal(sentBody.payer.email, 'test@testuser.com');
  assert.equal(order.customer.email, 'real-customer@example.com');
  assert.equal(sentBody.notification_url, undefined);
  assert.equal(JSON.stringify(logs).includes('card_token_123456'), false);
});

test('Mercado Pago errors retain only safe diagnostic fields', async () => {
  const logs = [];
  const provider = new MercadoPagoProvider({ accessToken: 'SECRET', environment: 'test', logger: { info: (...args) => logs.push(args) },
    fetchImpl: async () => new Response(JSON.stringify({ error: 'bad_request', message: 'Invalid payer.email',
      cause: [{ code: 'invalid_email', description: 'payer.email is invalid', data: 'must-not-leak' }] }), { status: 400 }) });
  await assert.rejects(provider.createPayment({ id: 'order-1', total: 1000, currency: 'ARS', customer: { email: 'customer@example.com' } }, {
    paymentAttemptId: 'attempt-1', providerIdempotencyKey: 'provider-key-1',
    paymentData: { token: 'card_token_123456', paymentMethodId: 'master', paymentTypeId: 'credit_card', installments: 1 }
  }), error => {
    assert.equal(error.providerStatus, 400);
    assert.equal(error.providerError, 'bad_request');
    assert.equal(error.providerMessage, 'Invalid payer.email');
    assert.deepEqual(error.providerCause, [{ code: 'invalid_email', description: 'payer.email is invalid' }]);
    assert.equal(JSON.stringify(error).includes('SECRET'), false);
    assert.equal(JSON.stringify(error).includes('card_token_123456'), false);
    return true;
  });
  assert.equal(JSON.stringify(logs).includes('must-not-leak'), false);
});
