import test from 'node:test';
import assert from 'node:assert/strict';
import { CartStore, CART_STORAGE_KEY } from '../cart-store.js';
import { CartService } from '../cart-service.js';
import { createCheckout, createHostedCheckout, createPayment, getPaymentConfig, getPublicOrder, getShippingQuotes, orderConfirmationUrl } from '../checkout-api.js';
import { canSubmitCheckout, createSubmitGuard, normalizeShippingPrice, resolveDeliverySelection } from '../checkout-submit.js';
import { CheckoutAttemptStore } from '../checkout-attempt.js';
import { createApp } from '../server/app.js';
import { InMemoryOrderRepository } from '../server/orders/order-repository.js';
import { createTestCatalog } from '../test-support/catalog-fixture.js';

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

test('checkout enables pickup with buyer data and requires a quote for home delivery', () => {
  assert.equal(canSubmitCheckout({ hasPendingPrice: false, deliveryMode: 'coordinate', selectedShippingMethodId: null, formValid: true }), true);
  assert.equal(canSubmitCheckout({ hasPendingPrice: false, deliveryMode: 'coordinate', selectedShippingMethodId: null, formValid: false }), false);
  assert.equal(canSubmitCheckout({ hasPendingPrice: false, deliveryMode: 'home_delivery', selectedShippingMethodId: null, formValid: true }), false);
  assert.equal(canSubmitCheckout({ hasPendingPrice: false, deliveryMode: 'home_delivery', selectedShippingMethodId: 'enviopack-standard', formValid: true }), true);
});

test('checkout normalizes Enviopack prices exactly like the backend before mounting payment', () => {
  assert.equal(normalizeShippingPrice(13803.58), 13804);
  assert.equal(30000 + normalizeShippingPrice(13803.58), 43804);
});

test('checkout submission derives delivery mode from the selected radio', () => {
  assert.deepEqual(resolveDeliverySelection({ pickupSelected: true, shippingMethodId: 'stale-quote' }),
    { deliveryMode: 'coordinate', shippingMethodId: null });
  assert.deepEqual(resolveDeliverySelection({ pickupSelected: false, shippingMethodId: 'enviopack-standard' }),
    { deliveryMode: 'home_delivery', shippingMethodId: 'enviopack-standard' });
  assert.deepEqual(resolveDeliverySelection({ pickupSelected: false, shippingMethodId: null }),
    { deliveryMode: 'home_delivery', shippingMethodId: null });
  assert.equal(canSubmitCheckout({ hasPendingPrice: false, deliveryMode: 'home_delivery', selectedShippingMethodId: null, formValid: true }), false);
});

test('checkout API sends idempotency and handles success, 400, 409, 500 and invalid responses', async () => {
  const makeFetch = (status, body, jsonThrows = false) => async (_url, options) => ({ ok: status >= 200 && status < 300, status, options, json: async () => { if (jsonThrows) throw new Error(); return body; } });
  const successFetch = makeFetch(201, { order: { id: 'order', publicOrderId: 'public-order' } });
  const order = await createCheckout([], {}, { idempotencyKey: 'frontend_key_123456', fetchImpl: successFetch }); assert.equal(order.id, 'order');
  for (const status of [400, 409, 500]) await assert.rejects(createCheckout([], {}, { idempotencyKey: 'frontend_key_123456', fetchImpl: makeFetch(status, { error: `error-${status}` }) }), new RegExp(`error-${status}`));
  await assert.rejects(createCheckout([], {}, { idempotencyKey: 'frontend_key_123456', fetchImpl: makeFetch(200, null, true) }), /invalid response/);
  await assert.rejects(createCheckout([], {}, { idempotencyKey: 'frontend_key_123456', fetchImpl: async () => { throw new Error('offline'); } }), /connect/);
});

test('checkout API sends only the selected delivery modality fields', async () => {
  const requests = []; const fetchImpl = async (_url, options) => { requests.push(JSON.parse(options.body)); return {
    ok: true, status: 201, json: async () => ({ order: { id: 'order', publicOrderId: 'public-order' } }) }; };
  const address = { street: 'A', streetNumber: '1', city: 'B', province: 'Buenos Aires', postalCode: '1000' };
  await createCheckout([], {}, { deliveryMode: 'home_delivery', deliveryAddress: address, shippingMethodId: 'standard', idempotencyKey: 'frontend_delivery_home_1', fetchImpl });
  await createCheckout([], {}, { deliveryMode: 'coordinate', deliveryAddress: address, shippingMethodId: 'injected', idempotencyKey: 'frontend_delivery_coordinate_1', fetchImpl });
  assert.deepEqual(requests[0], { items: [], customer: {}, deliveryMode: 'home_delivery', deliveryAddress: address, shippingMethodId: 'standard' });
  assert.deepEqual(requests[1], { items: [], customer: {}, deliveryMode: 'coordinate' });
});

test('pickup browser contract reaches the real checkout HTTP endpoint without address or shipping method', async () => {
  const repository = new InMemoryOrderRepository();
  const app = createApp({ orderRepository: repository, catalogService: createTestCatalog() });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = { street: 'must-not-be-sent', streetNumber: '1', city: 'X', province: 'Buenos Aires', postalCode: '1000' };
    let sentPayload;
    const fetchImpl = (url, options) => {
      sentPayload = JSON.parse(options.body);
      return fetch(`http://127.0.0.1:${server.address().port}${url}`, options);
    };
    const order = await createCheckout([{ productId: 'lain-cap-01', variantId: 'One size', color: 'Black', quantity: 1 }],
      { name: 'Pickup Buyer', email: 'pickup@example.com', phone: '' }, { deliveryMode: 'coordinate', deliveryAddress: address,
        shippingMethodId: 'stale-enviopack', idempotencyKey: 'pickup_http_contract_123456', fetchImpl });
    assert.deepEqual(Object.keys(sentPayload).sort(), ['customer', 'deliveryMode', 'items']);
    assert.equal(sentPayload.deliveryMode, 'coordinate');
    const stored = await repository.findById(order.id);
    assert.equal(stored.deliveryMode, 'coordinate');
    assert.equal(stored.total, stored.subtotal);
    assert.equal(stored.shipping, undefined);
    assert.equal(stored.deliveryAddress, undefined);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
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

test('checkout and payment API timeouts remain active while reading response bodies', async () => {
  const slowBody = async (_url, { signal }) => ({ ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })));
  }) });
  await assert.rejects(createCheckout([], {}, { idempotencyKey: 'body_timeout_checkout_1234', fetchImpl: slowBody, timeoutMs: 5 }), /timed out/);
  await assert.rejects(createPayment('order-id', { token: 'card_token_123456', payment_method_id: 'visa', installments: 1 },
    { idempotencyKey: 'body_timeout_payment_1234', fetchImpl: slowBody, timeoutMs: 5 }), error => error.code === 'PAYMENT_TIMEOUT');
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

test('hosted checkout API sends no card data and accepts only a Mercado Pago checkout URL', async () => {
  let request;
  const fetchImpl = async (url, options) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({
    order: { status: 'processing' }, checkoutUrl: 'https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=ORDTST1'
  }) }; };
  const result = await createHostedCheckout('order/id', { idempotencyKey: 'hosted_key_12345678', fetchImpl });
  assert.equal(request.url, '/api/orders/order%2Fid/checkout-pro'); assert.deepEqual(JSON.parse(request.options.body), {});
  assert.equal(request.options.headers['Idempotency-Key'], 'hosted_key_12345678'); assert.match(result.checkoutUrl, /mercadopago/);
  await assert.rejects(createHostedCheckout('order', { idempotencyKey: 'hosted_key_12345678', fetchImpl: async () => ({ ok: true, status: 200,
    json: async () => ({ order: { status: 'processing' }, checkoutUrl: 'https://evil.example/checkout/' }) }) }), /invalid hosted checkout/);
});

test('checkout attempt survives refresh, rotates rejected payments and changes for a new cart', () => {
  const data = new Map(); const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  let sequence = 0; const store = new CheckoutAttemptStore(storage, () => `uuid-${++sequence}`);
  const cart = [{ productId: 'shirt', variantId: 'M', quantity: 1 }];
  const first = store.load(cart); assert.equal(first.checkoutKey, 'uuid-1');
  assert.equal(first.paymentFlow, 'card');
  const hosted = store.selectPaymentFlow(first, 'checkout_pro'); assert.equal(hosted.paymentFlow, 'checkout_pro');
  const withOrder = store.attachOrder(hosted, { id: 'order-1' }); assert.equal(withOrder.paymentKey, 'uuid-2');
  assert.deepEqual(store.load(cart), withOrder);
  const retry = store.rotatePaymentKey(withOrder); assert.equal(retry.paymentKey, 'uuid-3'); assert.equal(retry.checkoutKey, first.checkoutKey);
  const changedDelivery = store.rotateCheckoutKey(retry, 'coordinate'); assert.equal(changedDelivery.checkoutKey, 'uuid-4'); assert.equal(changedDelivery.deliveryMode, 'coordinate'); assert.equal(changedDelivery.order, undefined); assert.equal(changedDelivery.paymentKey, undefined);
  assert.equal(store.load(cart).deliveryMode, 'coordinate');
  const nextCart = store.load([{ productId: 'shirt', variantId: 'L', quantity: 1 }]);
  assert.equal(nextCart.checkoutKey, 'uuid-5'); assert.equal(nextCart.order, undefined);
});

test('cancelled payments are terminal in the checkout and do not rotate a retry key', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../checkout.js', import.meta.url), 'utf8'));
  assert.match(source, /updated\.status === 'cancelled'[\s\S]{0,120}t\('orderCancelled'\)/);
  assert.doesNotMatch(source, /\['failed', 'cancelled'\][\s\S]{0,100}rotatePaymentKey/);
});
