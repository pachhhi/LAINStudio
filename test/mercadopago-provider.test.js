import test from 'node:test';
import assert from 'node:assert/strict';
import { MercadoPagoProvider, MercadoPagoProviderError, mapMercadoPagoStatus, minorUnitsToProviderAmount } from '../server/payments/mercadopago-provider.js';

const order = { id: 'order-1', total: 12345, currency: 'ARS', customer: { email: 'buyer@testuser.com' } };
const context = { paymentAttemptId: '11111111-1111-4111-8111-111111111111', providerIdempotencyKey: '11111111-1111-4111-8111-111111111111',
  paymentData: { token: 'card_token_123456', paymentMethodId: 'visa', installments: 1, issuerId: '1', identification: { type: 'DNI', number: '12345678' } } };
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const orderResponse = ({ status = 'processed', statusDetail = 'accredited' } = {}) => ({ id: 'ORDTST01TEST', status, status_detail: statusDetail, total_amount: '12345.00',
  external_reference: context.paymentAttemptId, transactions: { payments: [{ id: 'PAY01TEST', status, status_detail: statusDetail }] } });

test('money conversion uses explicit currency minor units', () => {
  assert.equal(minorUnitsToProviderAmount(12345, 'ARS'), 12345);
  assert.equal(minorUnitsToProviderAmount(12345, 'USD'), 123.45);
  assert.equal(minorUnitsToProviderAmount(1, 'USD'), 0.01);
  assert.throws(() => minorUnitsToProviderAmount(1.5, 'ARS'), /minor units/);
  assert.throws(() => minorUnitsToProviderAmount(1, 'XXX'), /Unsupported/);
});

test('provider supports explicit test and production environments and requires a backend access token', () => {
  assert.equal(new MercadoPagoProvider({ accessToken: 'x', environment: 'test' }).environment, 'test');
  assert.equal(new MercadoPagoProvider({ accessToken: 'x', environment: 'production' }).environment, 'production');
  assert.throws(() => new MercadoPagoProvider({ accessToken: 'x', environment: 'staging' }), /test or production/);
  assert.throws(() => new MercadoPagoProvider({ accessToken: '', environment: 'test' }), /ACCESS_TOKEN/);
});

for (const [providerStatus, internalStatus] of [['processed', 'approved'], ['processing', 'pending'], ['created', 'pending'], ['action_required', 'pending'], ['failed', 'rejected'], ['rejected', 'rejected'], ['cancelled', 'cancelled'], ['canceled', 'cancelled'], ['expired', 'cancelled'], ['refunded', 'refunded'], ['charged_back', 'chargeback']]) {
  test(`maps Mercado Pago ${providerStatus} to ${internalStatus}`, () => assert.equal(mapMercadoPagoStatus(providerStatus), internalStatus));
}
test('unknown Mercado Pago status fails closed', () => assert.throws(() => mapMercadoPagoStatus('mystery'), /unknown/));
test('maps partial refunds and reimbursed chargebacks precisely', () => {
  assert.equal(mapMercadoPagoStatus('processed', 'partially_refunded'), 'partially_refunded');
  assert.equal(mapMercadoPagoStatus('processed', 'refunded'), 'refunded');
  assert.equal(mapMercadoPagoStatus('charged_back', 'reimbursed'), 'refunded');
});

test('createPayment derives amount/email/reference from durable order and sends provider idempotency', async () => {
  let request; const logs = [];
  const provider = new MercadoPagoProvider({ accessToken: 'TEST_TOKEN', environment: 'test',
    fetchImpl: async (url, options) => { request = { url, options }; return response(201, orderResponse()); },
    logger: { info: (...entry) => logs.push(entry) } });
  const result = await provider.createPayment(order, context);
  assert.deepEqual(result, { orderId: 'ORDTST01TEST', paymentId: 'PAY01TEST', status: 'approved', statusDetail: 'accredited',
    externalReference: context.paymentAttemptId, totalAmount: '12345.00' });
  const body = JSON.parse(request.options.body);
  assert.equal(request.url.endsWith('/v1/orders'), true);
  assert.equal(request.options.headers['X-Idempotency-Key'], context.providerIdempotencyKey);
  assert.equal(request.options.headers.Authorization, 'Bearer TEST_TOKEN');
  assert.equal(body.type, 'online'); assert.equal(body.processing_mode, 'automatic');
  assert.equal(body.total_amount, '12345.00'); assert.equal(body.payer.email, 'test@testuser.com');
  assert.equal(order.customer.email, 'buyer@testuser.com');
  assert.equal(body.external_reference, context.paymentAttemptId); assert.equal(body.notification_url, undefined);
  assert.deepEqual(body.transactions.payments[0], { amount: '12345.00', payment_method: {
    id: 'visa', type: 'credit_card', token: 'card_token_123456', installments: 1
  } });
  assert.equal('card_number' in body.transactions.payments[0].payment_method, false);
  assert.equal('security_code' in body.transactions.payments[0].payment_method, false);
  assert.equal(JSON.stringify(logs).includes('test@testuser.com'), false);
  assert.equal(JSON.stringify(logs).includes(context.paymentData.token), false);
});

test('hosted Checkout Pro uses manual Orders without card data and validates its redirect', async () => {
  let request;
  const hosted = { id: 'ORDTSTHOSTED1', status: 'created', status_detail: 'created', total_amount: '12345.00', currency: 'ARS',
    external_reference: context.paymentAttemptId,
    checkout_url: 'https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=ORDTSTHOSTED1' };
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test',
    fetchImpl: async (url, options) => { request = { url, options }; return response(201, hosted); } });
  const returnUrl = 'https://lain.example/order.html?id=public-id';
  const result = await provider.createHostedCheckout(order, { ...context, paymentData: undefined,
    returnUrls: { successUrl: returnUrl, failureUrl: returnUrl, pendingUrl: returnUrl } });
  const body = JSON.parse(request.options.body);
  assert.equal(body.processing_mode, 'manual'); assert.equal(body.transactions, undefined);
  assert.equal(JSON.stringify(body).includes(context.paymentData.token), false);
  assert.equal(body.config.online.auto_return, 'all'); assert.equal(body.config.online.success_url, returnUrl);
  assert.equal(result.paymentId, null); assert.equal(result.status, 'pending'); assert.equal(result.orderId, hosted.id); assert.equal(result.currency, 'ARS');
  assert.equal(result.checkoutUrl, hosted.checkout_url);
});

test('hosted Checkout Pro rejects arbitrary, cross-order and cross-environment redirect responses', async () => {
  const base = { id: 'ORDTSTHOSTED1', status: 'created', total_amount: '12345.00', external_reference: context.paymentAttemptId };
  const returnUrls = { successUrl: 'https://lain.example/order.html', failureUrl: 'https://lain.example/order.html', pendingUrl: 'https://lain.example/order.html' };
  for (const checkoutUrl of ['https://evil.example/checkout/',
    'https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=ORDTSTOTHER']) {
    const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => response(201, { ...base, checkout_url: checkoutUrl }) });
    await assert.rejects(provider.createHostedCheckout(order, { ...context, returnUrls }), error => error.indeterminate === true);
  }
  const production = new MercadoPagoProvider({ accessToken: 'PROD', environment: 'production', fetchImpl: async () => response(201, {
    ...base, checkout_url: 'https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=ORDTSTHOSTED1'
  }) });
  await assert.rejects(production.createHostedCheckout(order, { ...context, returnUrls }), /malformed/);
});

test('manual order status may be created without a payment transaction and later gain a PAY id', async () => {
  let created = true;
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => response(200, created
    ? { id: 'ORDTSTHOSTED1', status: 'created', status_detail: 'created', total_amount: '12345.00', external_reference: context.paymentAttemptId,
      checkout_url: 'https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=ORDTSTHOSTED1' }
    : { ...orderResponse(), id: 'ORDTSTHOSTED1' }) });
  const pending = await provider.getPaymentStatus('ORDTSTHOSTED1');
  assert.equal(pending.status, 'pending'); assert.equal(pending.paymentId, null); assert.match(pending.checkoutUrl, /^https:/);
  created = false;
  const approved = await provider.getPaymentStatus('ORDTSTHOSTED1');
  assert.equal(approved.status, 'approved'); assert.equal(approved.paymentId, 'PAY01TEST');
});

test('Orders API maps accredited and processing responses', async () => {
  for (const [providerStatus, detail, expected] of [['processed', 'accredited', 'approved'], ['processing', 'in_process', 'pending']]) {
    const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test',
      fetchImpl: async () => response(201, orderResponse({ status: providerStatus, statusDetail: detail })) });
    const result = await provider.createPayment(order, context);
    assert.equal(result.status, expected); assert.equal(result.statusDetail, detail);
    assert.equal(result.orderId, 'ORDTST01TEST'); assert.equal(result.paymentId, 'PAY01TEST');
  }
});

test('Orders API maps a real HTTP 402 transaction rejection without inventing an order ID', async () => {
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => response(402, {
    errors: [{ code: 'failed', message: 'The following transactions failed', details: ['PAY01REJECTED: rejected_by_issuer'] }]
  }) });
  assert.deepEqual(await provider.createPayment(order, context), { orderId: null, paymentId: 'PAY01REJECTED',
    status: 'rejected', statusDetail: 'rejected_by_issuer', externalReference: context.paymentAttemptId });
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

test('HTTP 408 and malformed successful Orders responses remain indeterminate', async () => {
  const create = body => new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => response(body.status, body.payload) });
  await assert.rejects(create({ status: 408, payload: {} }).createPayment(order, context), error => error.indeterminate === true && error.providerStatus === 408);
  await assert.rejects(create({ status: 201, payload: { status: 'processed' } }).createPayment(order, context), error => error.indeterminate === true);
});

test('timeout remains active while reading the Mercado Pago response body', async () => {
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => ({ ok: true, status: 201, headers: { get: () => null }, json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }) }) });
  await assert.rejects(provider.createPayment(order, context), error => error.indeterminate === true && /timed out/.test(error.message));
});

test('synchronous Orders response identity mismatches remain ambiguous', async () => {
  for (const payload of [
    { ...orderResponse(), external_reference: '22222222-2222-4222-8222-222222222222' },
    { ...orderResponse(), total_amount: '999.00' },
    { ...orderResponse(), currency_id: 'USD' }
  ]) {
    const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => response(201, payload) });
    await assert.rejects(provider.createPayment(order, context), error => error.indeterminate === true && /mismatched/.test(error.message));
  }
});

test('getPaymentStatus confirms status server-side', async () => {
  let url;
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async value => {
    url = value; return response(200, orderResponse({ status: 'processing', statusDetail: 'in_process' }));
  } });
  assert.deepEqual(await provider.getPaymentStatus('ORDTST01TEST'), { orderId: 'ORDTST01TEST', paymentId: 'PAY01TEST', status: 'pending', statusDetail: 'in_process', externalReference: context.paymentAttemptId, totalAmount: '12345.00' });
  assert.equal(url.endsWith('/v1/orders/ORDTST01TEST'), true);
});

test('getPaymentStatus rejects cross-environment and mismatched provider orders', async () => {
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => response(200, orderResponse()) });
  await assert.rejects(provider.getPaymentStatus('ORDLIVE01'), /test provider order ID/);
  const mismatch = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => response(200, { ...orderResponse(), id: 'ORDTSTOTHER' }) });
  await assert.rejects(mismatch.getPaymentStatus('ORDTST01TEST'), /mismatched test order/);
});

test('production provider accepts production IDs, real payer email and rejects TEST IDs', async () => {
  let body;
  const productionResponse = { ...orderResponse(), id: 'ORD01PRODUCTION', external_reference: context.paymentAttemptId };
  const provider = new MercadoPagoProvider({ accessToken: 'PROD', environment: 'production', fetchImpl: async (_url, options) => {
    body = options?.body ? JSON.parse(options.body) : null; return response(options?.method === 'POST' ? 201 : 200, productionResponse);
  } });
  const result = await provider.createPayment(order, context);
  assert.equal(result.orderId, 'ORD01PRODUCTION'); assert.equal(body.payer.email, order.customer.email);
  await assert.rejects(provider.getPaymentStatus('ORDTST01TEST'), /production provider order ID/);
  assert.equal((await provider.getPaymentStatus('ORD01PRODUCTION')).orderId, 'ORD01PRODUCTION');
});

test('findPaymentOrder searches by external reference and confirms the unique result by ID', async () => {
  const urls = [];
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async url => {
    urls.push(String(url));
    if (String(url).includes('?')) return response(200, { data: [{ id: 'ORDTST01TEST', external_reference: context.paymentAttemptId }] });
    return response(200, orderResponse());
  } });
  const result = await provider.findPaymentOrder({ externalReference: context.paymentAttemptId, createdAt: '2026-10-08T12:00:00.000Z' });
  assert.equal(result.orderId, 'ORDTST01TEST'); assert.equal(urls.length, 2);
  assert.match(urls[0], /external_reference=11111111-1111-4111-8111-111111111111/);
  assert.match(urls[0], /begin_date=/); assert.match(urls[0], /end_date=/);
});

test('findPaymentOrder returns null for no match and rejects ambiguous matches', async () => {
  const create = data => new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => response(200, { data }) });
  const criteria = { externalReference: context.paymentAttemptId, createdAt: '2026-10-08T12:00:00.000Z' };
  assert.equal(await create([]).findPaymentOrder(criteria), null);
  const match = { id: 'ORDTST01TEST', external_reference: context.paymentAttemptId };
  await assert.rejects(create([match, { ...match, id: 'ORDTST02TEST' }]).findPaymentOrder(criteria), /multiple orders/);
});

test('card token and payment fields are strictly validated', async () => {
  const provider = new MercadoPagoProvider({ accessToken: 'TEST', environment: 'test', fetchImpl: async () => response(200, {}) });
  await assert.rejects(provider.createPayment(order, { ...context, paymentData: { ...context.paymentData, token: { card: 'raw' } } }), /card token/);
  await assert.rejects(provider.createPayment(order, { ...context, paymentData: { ...context.paymentData, installments: '1' } }), /installments/);
  await assert.rejects(provider.createPayment(order, { ...context, paymentData: { ...context.paymentData, paymentTypeId: 'debit_card' } }), /Only credit card/);
  await assert.rejects(provider.createPayment(order, { ...context, paymentData: { ...context.paymentData, paymentTypeId: 'prepaid_card' } }), /Only credit card/);
  await assert.rejects(provider.createPayment(order, { ...context, paymentData: { ...context.paymentData, paymentMethodId: 'debvisa' } }), /Unsupported credit card/);
});
