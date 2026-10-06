import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createOpsApp } from '../ops/app.js';
import { listenOps, OPS_HOST } from '../ops/server.js';
import { InMemoryOrderRepository } from '../server/orders/order-repository.js';
import { createApp } from '../server/app.js';

const id = '11111111-1111-4111-8111-111111111111';
const order = { id, publicOrderId: '22222222-2222-4222-8222-222222222222', createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:00:00.000Z',
  status: 'pending', subtotal: 29000, total: 30100, currency: 'ARS', version: 1,
  customer: { name: 'LAIN Buyer', email: 'buyer@example.com', phone: '+54 11 5555 5555' },
  items: [{ productId: 'lain-cap-01', name: 'Offline Cap', variantId: 'One size', color: 'Black', quantity: 1, unitPrice: 29000, lineTotal: 29000 }],
  deliveryAddress: { street: 'Belgrano', streetNumber: '123', apartmentFloor: '2 A', city: 'Merlo', province: 'Buenos Aires', postalCode: '1722' },
  shipping: { provider: 'enviopack', carrier: 'enviopack', service: 'Standard', price: 1100, estimatedHours: 12, postalCode: '1722', province: 'Buenos Aires', quotedAt: '2026-10-06T11:59:00.000Z' },
  shippingStatus: 'selected', paymentProvider: null, paymentId: null };

function repositoryWithOrder() { const repository = new InMemoryOrderRepository(); repository.save(order); return repository; }

test('Ops bind helper listens exclusively on 127.0.0.1', () => {
  let captured; const server = {};
  const app = { listen: (port, host, callback) => { captured = { port, host, callback }; return server; } };
  assert.equal(listenOps(app), server); assert.equal(OPS_HOST, '127.0.0.1');
  assert.deepEqual({ port: captured.port, host: captured.host }, { port: 4000, host: '127.0.0.1' });
});

test('Ops lists recent orders and renders the empty state', async () => {
  const populated = await request(createOpsApp({ orderRepository: repositoryWithOrder() })).get('/orders').expect(200);
  assert.match(populated.text, /LAIN \/ OPS/); assert.match(populated.text, /LAIN Buyer/); assert.match(populated.text, new RegExp(id));
  const empty = await request(createOpsApp({ orderRepository: new InMemoryOrderRepository() })).get('/orders').expect(200);
  assert.match(empty.text, /NO ORDERS YET/);
});

test('Ops renders one order with customer, items, delivery, shipping and payment data', async () => {
  const response = await request(createOpsApp({ orderRepository: repositoryWithOrder() })).get(`/orders/${id}`).expect(200);
  for (const content of ['ORDER', 'CUSTOMER', 'ITEMS', 'DELIVERY', 'SHIPPING', 'PAYMENT', 'Offline Cap', 'Belgrano', 'enviopack', 'selected']) {
    assert.match(response.text, new RegExp(content));
  }
});

test('Ops returns 404 for missing orders and 405 for every write method', async () => {
  const app = createOpsApp({ orderRepository: repositoryWithOrder() });
  await request(app).get('/orders/33333333-3333-4333-8333-333333333333').expect(404);
  await request(app).get('/orders/not-an-id').expect(404);
  for (const method of ['post', 'put', 'patch', 'delete']) await request(app)[method](`/orders/${id}`).send({ status: 'paid' }).expect(405);
});

test('Ops never exposes database errors or environment secrets', async () => {
  const secret = 'postgresql://secret-user:secret-password@host/database'; const logs = [];
  const repository = { listRecent: async () => { throw new Error(secret); }, findById: async () => null };
  const response = await request(createOpsApp({ orderRepository: repository, logger: { error: (...entry) => logs.push(entry) } })).get('/orders').expect(500);
  assert.equal(response.text.includes(secret), false); assert.equal(JSON.stringify(logs).includes(secret), false); assert.match(response.text, /OPS UNAVAILABLE/); assert.equal(logs.length, 1);
});

test('public storefront does not serve Ops files or routes', async () => {
  await request(createApp()).get('/ops').expect(404);
  await request(createApp()).get('/ops/app.js').expect(404);
});
