import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { InMemoryOrderRepository } from '../server/orders/order-repository.js';
import { createTestCatalog } from '../test-support/catalog-fixture.js';

const item = { productId: 'lain-cap-01', variantId: 'One size', color: 'Black', quantity: 2 };
const deliveryAddress = { street: 'Belgrano', streetNumber: '123', apartmentFloor: '2 A', city: 'Merlo', province: 'Buenos Aires', postalCode: '1722' };
const payload = { items: [item], customer: { name: 'Shipping Buyer', email: 'shipping@example.com' },
  deliveryAddress, shippingMethodId: 'real-standard' };
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
