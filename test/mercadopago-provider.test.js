import test from 'node:test';
import assert from 'node:assert/strict';
import { MercadoPagoProvider, MercadoPagoProviderError, mapMercadoPagoStatus, minorUnitsToProviderAmount } from '../server/payments/mercadopago-provider.js';

const order = { id: 'order-1', total: 12345, currency: 'ARS', customer: { email: 'buyer@testuser.com' } };
const context = { paymentAttemptId: '11111111-1111-4111-8111-111111111111', providerIdempotencyKey: '11111111-1111-4111-8111-111111111111',
  paymentData: { token: 'card_token_123456', paymentMethodId: 'visa', installments: 1, issuerId: '1', identification: { type: 'DNI', number: '12345678' } } };
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('money conversion uses explicit currency minor units', () => {
  assert.equal(minorUnitsToProviderAmount(12345, 'ARS'), 12345);
  assert.equal(minorUnitsToProviderAmount(12345, 'USD'), 123.45);
  assert.equal(minorUnitsToProviderAmount(1, 'USD'), 0.01);
  assert.throws(() => minorUnitsToProviderAmount(1.5, 'ARS'), /minor units/);
  assert.throws(() => minorUnitsToProviderAmount(1, 'XXX'), /Unsupported/);
});

test('provider is test-only and requires a backend access token', () => {
  assert.throws(() => new MercadoPagoProvider({ accessToken: 'x', environment: 'production' }), /restricted/);
  assert.throws(() => new MercadoPagoProvider({ accessToken: '', environment: 'test' }), /ACCESS_TOKEN/);
});

for (const [providerStatus, internalStatus] of [['approved', 'approved'], ['pending', 'pending'], ['in_process', 'pending'], ['rejected', 'rejected'], ['cancelled', 'cancelled'], ['refunded', 'refunded'], ['charged_back', 'refunded']]) {
  test(`maps Mercado Pago ${providerStatus} to ${internalStatus}`, () => assert.equal(mapMercadoPagoStatus(providerStatus), internalStatus));
}
test('unknown Mercado Pago status fails closed', () => assert.throws(() => mapMercadoPagoStatus('mystery'), /unknown/));

test('createPayment derives amount/email/reference from durable order and sends provider idempotency', async () => {
  let request;
  const provider = new MercadoPagoProvider({ accessToken: 'TEST_TOKEN', environment: 'test', notificationUrl: 'https://example.test/hook',
    fetchImpl: async (url, options) => { request = { url, options }; return response(201, { id: 99, status: 'approved', external_reference: context.paymentAttemptId }); } });
  const result = await provider.createPayment(order, context);
  assert.deepEqual(result, { paymentId: '99', status: 'approved', externalReference: context.paymentAttemptId });
  const body = JSON.parse(request.options.body);
  assert.equal(request.options.headers['X-Idempotency-Key'], context.providerIdempotencyKey);
  assert.equal(request.options.headers.Authorization, 'Bearer TEST_TOKEN');
  assert.equal(body.transaction_amount, 12345); assert.equal(body.payer.email, order.customer.email);
  assert.equal(body.external_reference, context.paymentAttemptId); assert.equal(body.notification_url, 'https://example.test/hook');
  assert.equal('total' in body, false); assert.equal('status' in body, false);
});

test('provider handles 4xx, 5xx, malformed response, network errors and timeout safely', async () => {
  const create = fetchImpl => new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl, timeoutMs: 5 });
  await assert.rejects(create(async () => response(400, { message: 'secret detail' })).createPayment(order, context), error => error instanceof MercadoPagoProviderError && !error.indeterminate);
  await assert.rejects(create(async () => response(500, {})).createPayment(order, context), error => error.indeterminate);
  await assert.rejects(create(async () => response(201, null)).createPayment(order, context), error => error.indeterminate);
  await assert.rejects(create(async () => { throw new Error('network'); }).createPayment(order, context), error => error.indeterminate);
  const slow = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' }))));
  await assert.rejects(create(slow).createPayment(order, context), error => error.indeterminate && /timed out/.test(error.message));
});

test('getPaymentStatus confirms status server-side', async () => {
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => response(200, { id: 10, status: 'pending', external_reference: context.paymentAttemptId }) });
  assert.deepEqual(await provider.getPaymentStatus('10'), { paymentId: '10', status: 'pending', externalReference: context.paymentAttemptId });
});

test('card token and payment fields are strictly validated', async () => {
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => response(200, {}) });
  await assert.rejects(provider.createPayment(order, { ...context, paymentData: { ...context.paymentData, token: { card: 'raw' } } }), /card token/);
  await assert.rejects(provider.createPayment(order, { ...context, paymentData: { ...context.paymentData, installments: '1' } }), /installments/);
});
