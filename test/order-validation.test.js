import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogService } from '../server/catalog/catalog-service.js';
import { createTestCatalog } from '../test-support/catalog-fixture.js';
import { InMemoryOrderRepository } from '../server/orders/order-repository.js';
import { OrderService } from '../server/orders/order-service.js';

const customer = { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+54 11 5555-5555' };
const cap = (overrides = {}) => ({ productId: 'lain-cap-01', variantId: 'One size', color: 'Black', quantity: 1, ...overrides });
const hoodie = (overrides = {}) => ({ productId: 'lain-hoodie-01', variantId: 'M', color: 'Graphite', quantity: 1, ...overrides });
const service = () => new OrderService({ catalogService: createTestCatalog(), orderRepository: new InMemoryOrderRepository() });

test('creates one-item and multiple-item orders using integer minor units', () => {
  assert.equal(service().create({ items: [cap()], customer }).total, 29000);
  const order = service().create({ items: [cap({ quantity: 2 }), hoodie()], customer });
  assert.equal(order.total, 147000);
  assert.equal(Number.isSafeInteger(order.total), true);
});

test('allows repeated products and distinct variants as distinct immutable lines', () => {
  const order = service().create({ items: [hoodie({ variantId: 'S' }), hoodie({ variantId: 'M' })], customer });
  assert.equal(order.items.length, 2);
  assert.equal(order.total, 178000);
});

for (const [label, item, pattern] of [
  ['missing product', cap({ productId: 'not-real' }), /unavailable/],
  ['missing variant', cap({ variantId: 'XXL' }), /valid variant/],
  ['product without price', { productId: 'lain-tee-02', variantId: 'M', quantity: 1 }, /integer price/],
  ['zero quantity', cap({ quantity: 0 }), /integer between/],
  ['negative quantity', cap({ quantity: -1 }), /integer between/],
  ['decimal quantity', cap({ quantity: 1.5 }), /integer between/],
  ['string quantity', cap({ quantity: '1' }), /integer between/],
  ['huge quantity', cap({ quantity: 10 ** 12 }), /integer between/],
  ['null quantity', cap({ quantity: null }), /integer between/]
]) test(`rejects ${label}`, () => assert.throws(() => service().create({ items: [item], customer }), pattern));

for (const [label, payload] of [
  ['empty cart', { items: [], customer }], ['null items', { items: null, customer }],
  ['object items', { items: {}, customer }], ['empty payload', {}], ['null payload', null]
]) test(`rejects ${label}`, () => assert.throws(() => service().create(payload), /payload|at least one item/));

test('ignores all client-controlled monetary fields', () => {
  const attack = { price: 1, unitPrice: 1, subtotal: 1, total: 1, currency: 'USD', discount: 999999, shipping: -999999, finalPrice: 1 };
  const order = service().create({ ...attack, items: [{ ...cap(), ...attack }], customer });
  assert.equal(order.items[0].unitPrice, 29000);
  assert.equal(order.items[0].lineTotal, 29000);
  assert.equal(order.subtotal, 29000);
  assert.equal(order.total, 29000);
  assert.equal(order.currency, 'ARS');
  for (const field of ['price', 'discount', 'shipping', 'finalPrice']) assert.equal(field in order, false);
});

test('rejects fractional catalog prices and unsafe monetary totals', () => {
  const base = { id: 'x', name: 'X', available: true, currency: 'ARS', variants: [], colors: [] };
  const fractional = new OrderService({ catalogService: new CatalogService([{ ...base, price: 10.5 }]), orderRepository: new InMemoryOrderRepository() });
  assert.throws(() => fractional.create({ items: [{ productId: 'x', quantity: 1 }], customer }), /integer price/);
  const unsafe = new OrderService({ catalogService: new CatalogService([{ ...base, price: Number.MAX_SAFE_INTEGER }]), orderRepository: new InMemoryOrderRepository() });
  assert.throws(() => unsafe.create({ items: [{ productId: 'x', quantity: 2 }], customer }), /supported range/);
});

test('mass-assignment fields cannot control an order', () => {
  const supplied = { id: 'owned', status: 'paid', paymentProvider: 'fake', paymentId: '123', createdAt: 'x', updatedAt: 'x' };
  const order = service().create({ ...supplied, items: [cap(supplied)], customer: { ...customer, ...supplied } });
  assert.notEqual(order.id, 'owned'); assert.equal(order.status, 'pending');
  assert.equal(order.paymentProvider, null); assert.equal(order.paymentId, null);
  assert.notEqual(order.createdAt, 'x'); assert.notEqual(order.updatedAt, 'x');
});

for (const [label, value, pattern] of [
  ['empty name', { ...customer, name: ' ' }, /customer name/],
  ['invalid email', { ...customer, email: 'nope' }, /customer email/],
  ['long email', { ...customer, email: `${'a'.repeat(250)}@x.com` }, /customer email/],
  ['invalid phone', { ...customer, phone: 'call-me' }, /customer phone/],
  ['long name', { ...customer, name: 'a'.repeat(101) }, /customer name/],
  ['array name', { ...customer, name: ['Ada'] }, /must be a string/],
  ['object email', { ...customer, email: { value: 'a@b.com' } }, /must be a string/],
  ['null customer', null, /required/]
]) test(`customer validation rejects ${label}`, () => assert.throws(() => service().create({ items: [cap()], customer: value }), pattern));

test('customer validation accepts valid Unicode', () => {
  const order = service().create({ items: [cap()], customer: { name: 'Zoë 王 👾', email: 'zoe@example.com' } });
  assert.equal(order.customer.name, 'Zoë 王 👾');
});
