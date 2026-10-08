import test from 'node:test';
import assert from 'node:assert/strict';
import { CartStore, CART_STORAGE_KEY } from '../cart-store.js';
import { CartService } from '../cart-service.js';
import { createCheckout, createPayment, getPaymentConfig, getPublicOrder, getShippingQuotes, orderConfirmationUrl } from '../checkout-api.js';
import { createSubmitGuard } from '../checkout-submit.js';
import { CheckoutAttemptStore } from '../checkout-attempt.js';

test('CartStore loads, saves, clears and tolerates unavailable storage', () => {
  const data = new Map(); const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const store = new CartStore(storage); assert.deepEqual(store.load(), []);
  assert.equal(store.save([{ productId: 'x' }]), true); assert.deepEqual(store.load(), [{ productId: 'x' }]);
  store.clear(); assert.equal(data.has(CART_STORAGE_KEY), false);
  const broken = new CartStore({ getItem: () => { throw new Error(); }, setItem: () => { throw new Error(); }, removeItem: () => { throw new Error(); } });
  assert.deepEqual(broken.load(), []); assert.equal(broken.save([]), false); assert.doesNotThrow(() => broken.clear());
});

test('CartService rejects invalid adds and returns defensive item copies', () => {
  const store = { load: () => [], save: () => true, clear: () => {} };
  const cart = new CartService({ catalog: [{ id: 'x', available: true, variants: [{ id: 'M' }], colors: ['Black'] }], store });
  assert.throws(() => cart.add({ productId: 'x', variantId: 'M', color: 'Black', quantity: '1' }), /Invalid/);
  cart.add({ productId: 'x', variantId: 'M', color: 'Black', quantity: 1 }); const copy = cart.getItems(); copy[0].quantity = 9;
  assert.equal(cart.getCount(), 1);
});

test('submit guard collapses rapid submissions and unlocks after completion', async () => {
  let calls = 0; let release;
  const guarded = createSubmitGuard(() => { calls += 1; return new Promise(resolve => { release = resolve; }); });
  const first = guarded(); const second = guarded(); assert.equal(first, second); assert.equal(calls, 0);
  await Promise.resolve(); assert.equal(calls, 1); release('ok'); assert.equal(await first, 'ok');
  const third = guarded(); await Promise.resolve(); assert.equal(calls, 2); release('again'); await third;
});

test('checkout API sends idempotency and handles success, 400, 409, 500 and invalid responses', async () => {
  const makeFetch = (status, body, jsonThrows = false) => async (_url, options) => ({ ok: status >= 200 && status < 300, status, options, json: async () => { if (jsonThrows) throw new Error(); return body; } });
  const successFetch = makeFetch(201, { order: { id: 'order', publicOrderId: 'public-order' } });
  const order = await createCheckout([], {}, { idempotencyKey: 'frontend_key_123456', fetchImpl: successFetch }); assert.equal(order.id, 'order');
  for (const status of [400, 409, 500]) await assert.rejects(createCheckout([], {}, { idempotencyKey: 'frontend_key_123456', fetchImpl: makeFetch(status, { error: `error-${status}` }) }), new RegExp(`error-${status}`));
  await assert.rejects(createCheckout([], {}, { idempotencyKey: 'frontend_key_123456', fetchImpl: makeFetch(200, null, true) }), /invalid response/);
  await assert.rejects(createCheckout([], {}, { idempotencyKey: 'frontend_key_123456', fetchImpl: async () => { throw new Error('offline'); } }), /connect/);
});

test('public order API and durable confirmation URL recover an order without internal data', async () => {
  let requestedUrl;
  const publicOrder = { publicOrderId: '550e8400-e29b-41d4-a716-446655440000', items: [], subtotal: 1, total: 1, currency: 'ARS', status: 'pending' };
  const recovered = await getPublicOrder(publicOrder.publicOrderId, { fetchImpl: async url => { requestedUrl = url; return { ok: true, status: 200, json: async () => ({ order: publicOrder }) }; } });
  assert.equal(requestedUrl, `/api/public/orders/${publicOrder.publicOrderId}`);
  assert.deepEqual(recovered, publicOrder);
  assert.equal(orderConfirmationUrl(publicOrder.publicOrderId), `/order.html?id=${publicOrder.publicOrderId}`);
  await assert.rejects(getPublicOrder('missing', { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: 'Order not found.' }) }) }), /not found/);
});

test('checkout API aborts slow requests', async () => {
  const slowFetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' }))));
  await assert.rejects(createCheckout([], {}, { idempotencyKey: 'frontend_key_123456', fetchImpl: slowFetch, timeoutMs: 5 }), /timed out/);
});

test('shipping API sends only destination and cart identifiers', async () => {
  let sent;
  const fetchImpl = async (_url, options) => { sent = JSON.parse(options.body); return { ok: true, status: 200,
    json: async () => ({ available: false, reason: 'shipping_provider_not_configured', methods: [] }) }; };
  const result = await getShippingQuotes('1722', 'Buenos Aires', [{ productId: 'x', quantity: 1 }], { fetchImpl });
  assert.deepEqual(sent, { postalCode: '1722', province: 'Buenos Aires', cart: [{ productId: 'x', quantity: 1 }] });
  assert.equal(result.available, false);
  await assert.rejects(getShippingQuotes('1722', 'Buenos Aires', [], { fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'Invalid cart', methods: [] }) }) }), /Invalid cart/);
  await assert.rejects(getShippingQuotes('1722', 'Buenos Aires', [], { fetchImpl: async () => ({ ok: false, status: 400,
    json: async () => ({ error: 'internal detail', code: 'shipping_product_missing_dimensions' }) }) }), /dimensions are not configured/);
});

test('payment config accepts only configured Mercado Pago TEST public data', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ configured: true, provider: 'mercadopago', environment: 'test', publicKey: 'TEST-public' }) });
  assert.deepEqual(await getPaymentConfig({ fetchImpl }), { configured: true, provider: 'mercadopago', environment: 'test', publicKey: 'TEST-public' });
  await assert.rejects(getPaymentConfig({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ provider: 'none', environment: 'disabled', publicKey: '' }) }) }), /not configured/);
});

test('payment config accepts production public data without exposing backend credentials', async () => {
  const result = await getPaymentConfig({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
    configured: true, provider: 'mercadopago', environment: 'production', publicKey: 'APP_USR-production-public'
  }) }) });
  assert.equal(result.environment, 'production'); assert.equal(result.publicKey, 'APP_USR-production-public');
});

test('payment API sends only the Brick token and non-sensitive payment fields', async () => {
  let request;
  const fetchImpl = async (url, options) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({ order: { status: 'paid' } }) }; };
  const cardData = { token: 'card_token_123456', payment_method_id: 'visa', installments: 1, issuer_id: '1', transaction_amount: 999,
    payer: { email: 'ignored@example.com', identification: { type: 'DNI', number: '12345678' } }, cardNumber: 'should-never-be-sent' };
  assert.equal((await createPayment('order/id', cardData, { idempotencyKey: 'payment_key_123456', fetchImpl })).status, 'paid');
  assert.equal(request.url, '/api/orders/order%2Fid/payments');
  assert.equal(request.options.headers['Idempotency-Key'], 'payment_key_123456');
  assert.deepEqual(JSON.parse(request.options.body), { token: 'card_token_123456', paymentMethodId: 'visa', installments: 1,
    issuerId: '1', identification: { type: 'DNI', number: '12345678' } });
});

test('checkout attempt survives refresh, rotates rejected payments and changes for a new cart', () => {
  const data = new Map(); const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  let sequence = 0; const store = new CheckoutAttemptStore(storage, () => `uuid-${++sequence}`);
  const cart = [{ productId: 'shirt', variantId: 'M', quantity: 1 }];
  const first = store.load(cart); assert.equal(first.checkoutKey, 'uuid-1');
  const withOrder = store.attachOrder(first, { id: 'order-1' }); assert.equal(withOrder.paymentKey, 'uuid-2');
  assert.deepEqual(store.load(cart), withOrder);
  const retry = store.rotatePaymentKey(withOrder); assert.equal(retry.paymentKey, 'uuid-3'); assert.equal(retry.checkoutKey, first.checkoutKey);
  const nextCart = store.load([{ productId: 'shirt', variantId: 'L', quantity: 1 }]);
  assert.equal(nextCart.checkoutKey, 'uuid-4'); assert.equal(nextCart.order, undefined);
});
