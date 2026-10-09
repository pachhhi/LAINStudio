import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { InMemoryOrderRepository } from '../server/orders/order-repository.js';
import { createTestCatalog } from '../test-support/catalog-fixture.js';
import { FakePaymentProvider } from '../test-support/fake-payment-provider.js';

const item = { productId: 'lain-cap-01', variantId: 'One size', color: 'Black', quantity: 2 };
const deliveryAddress = { street: 'Belgrano', streetNumber: '123', apartmentFloor: '2 A', city: 'Merlo', province: 'Buenos Aires', postalCode: '1722' };
const payload = { items: [item], customer: { name: 'Shipping Buyer', email: 'shipping@example.com' },
  deliveryMode: 'home_delivery', deliveryAddress, shippingMethodId: 'real-standard' };
const key = value => `shipping_order_${value}_123456`;

function setup(method = { id: 'real-standard', name: 'Standard', carrier: 'Carrier', price: 1234.5, estimatedHours: 24 }) {
  const calls = [];
  const shippingProvider = { name: 'enviopack', isConfigured: () => true, quoteHomeDelivery: async input => { calls.push(input); return [method]; } };
  const repository = new InMemoryOrderRepository();
  return { app: createApp({ shippingProvider, orderRepository: repository, catalogService: createTestCatalog() }), repository, calls };
}

test('order rejects incomplete delivery address before quoting', async () => {
  const { app, calls } = setup();
  const response = await request(app).post('/api/checkout').set('Idempotency-Key', key('address'))
    .send({ ...payload, deliveryAddress: { ...deliveryAddress, street: '' } }).expect(400);
  assert.match(response.body.error, /delivery street/); assert.equal(calls.length, 0);
});

test('order rejects invalid delivery postal code before quoting', async () => {
  const { app, calls } = setup();
  const response = await request(app).post('/api/checkout').set('Idempotency-Key', key('postal'))
    .send({ ...payload, deliveryAddress: { ...deliveryAddress, postalCode: '17A2' } }).expect(400);
  assert.match(response.body.error, /postal code/); assert.equal(calls.length, 0);
});

test('order rejects a client-manipulated shipping method', async () => {
  const { app, calls } = setup();
  const response = await request(app).post('/api/checkout').set('Idempotency-Key', key('method'))
    .send({ ...payload, shippingMethodId: 'cheap-injected-method' }).expect(400);
  assert.equal(response.body.code, 'shipping_method_invalid'); assert.equal(calls.length, 1);
});

test('order re-quotes server-side, ignores client price and persists shipping snapshot and delivery', async () => {
  const { app, repository, calls } = setup();
  const response = await request(app).post('/api/checkout').set('Idempotency-Key', key('snapshot'))
    .send({ ...payload, shipping: { provider: 'attacker', price: 1 }, shippingPrice: 1, total: 1 }).expect(201);
  const order = await repository.findById(response.body.order.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].province, 'B'); assert.equal(calls[0].postalCode, '1722'); assert.equal(calls[0].weightKg, 0.5);
  assert.equal(order.shipping.price, 1235); assert.equal(order.total, 58000 + 1235);
  assert.deepEqual(order.deliveryAddress, deliveryAddress); assert.equal(order.shippingStatus, 'selected');
  assert.deepEqual({ ...order.shipping, quotedAt: '<time>' }, { provider: 'enviopack', service: 'Standard', carrier: 'Carrier',
    price: 1235, estimatedHours: 24, postalCode: '1722', province: 'Buenos Aires', quotedAt: '<time>' });
  assert.match(order.shipping.quotedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual((await repository.findById(order.id)).shipping, order.shipping);
});

test('coordinate delivery skips Enviopack, persists zero shipping and ignores manipulated amounts', async () => {
  const { app, repository, calls } = setup();
  const response = await request(app).post('/api/checkout').set('Idempotency-Key', key('coordinate'))
    .send({ items: payload.items, customer: payload.customer, deliveryMode: 'coordinate', shippingPrice: 1, shipping: { price: 1 }, total: 1,
      deliveryAddress, shippingMethodId: 'cheap-injected-method' }).expect(201);
  const order = await repository.findById(response.body.order.id);
  assert.equal(calls.length, 0);
  assert.equal(order.deliveryMode, 'coordinate');
  assert.equal(order.shippingStatus, 'coordination_pending');
  assert.equal(order.shipping, undefined); assert.equal(order.deliveryAddress, undefined);
  assert.equal(order.subtotal, 58000); assert.equal(order.total, 58000);
});

test('coordinate delivery requires name and email but accepts an empty phone and no address', async () => {
  const { app, repository } = setup();
  const valid = await request(app).post('/api/checkout').set('Idempotency-Key', key('pickup_contact'))
    .send({ items: payload.items, customer: { ...payload.customer, phone: '' }, deliveryMode: 'coordinate' }).expect(201);
  const order = await repository.findById(valid.body.order.id);
  assert.equal(order.customer.phone, '');
  assert.equal(order.deliveryAddress, undefined);
  await request(app).post('/api/checkout').set('Idempotency-Key', key('pickup_no_name'))
    .send({ items: payload.items, customer: { name: '', email: payload.customer.email }, deliveryMode: 'coordinate' }).expect(400);
  await request(app).post('/api/checkout').set('Idempotency-Key', key('pickup_no_email'))
    .send({ items: payload.items, customer: { name: payload.customer.name, email: '' }, deliveryMode: 'coordinate' }).expect(400);
});

test('coordinate delivery order continues through the existing payment flow', async () => {
  const paymentProvider = new FakePaymentProvider('approved');
  const app = createApp({ paymentProvider, orderRepository: new InMemoryOrderRepository(), catalogService: createTestCatalog() });
  const checkout = await request(app).post('/api/checkout').set('Idempotency-Key', key('pickup_payment'))
    .send({ items: payload.items, customer: payload.customer, deliveryMode: 'coordinate' }).expect(201);
  const payment = await request(app).post(`/api/orders/${checkout.body.order.id}/payments`)
    .set('Idempotency-Key', 'pickup_payment_attempt_123456').send({ token: 'fake-token' }).expect(200);
  assert.equal(payment.body.order.status, 'paid');
});

test('delivery mode is validated and participates in checkout idempotency', async () => {
  const { app } = setup(); const idempotencyKey = key('delivery_mode');
  await request(app).post('/api/checkout').set('Idempotency-Key', idempotencyKey)
    .send({ items: payload.items, customer: payload.customer, deliveryMode: 'coordinate' }).expect(201);
  const duplicate = await request(app).post('/api/checkout').set('Idempotency-Key', idempotencyKey)
    .send({ items: payload.items, customer: payload.customer, deliveryMode: 'coordinate' }).expect(201);
  assert.equal(duplicate.body.order.total, 58000);
  await request(app).post('/api/checkout').set('Idempotency-Key', idempotencyKey).send(payload).expect(409);
  await request(app).post('/api/checkout').set('Idempotency-Key', key('invalid_mode'))
    .send({ items: payload.items, customer: payload.customer, deliveryMode: 'free_shipping' }).expect(400);
});

test('home delivery cannot use a zero-price provider quote', async () => {
  const { app } = setup({ id: 'real-standard', name: 'Standard', carrier: 'Carrier', price: 0, estimatedHours: 24 });
  await request(app).post('/api/checkout').set('Idempotency-Key', key('zero_home')).send(payload).expect(502);
});
