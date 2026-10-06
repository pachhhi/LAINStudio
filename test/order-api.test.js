import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestCatalog } from '../test-support/catalog-fixture.js';
import { InMemoryOrderRepository } from '../server/orders/order-repository.js';
import { OrderService } from '../server/orders/order-service.js';

function createService() {
  return new OrderService({ catalogService: createTestCatalog(), orderRepository: new InMemoryOrderRepository() });
}

test('order service calculates totals from the server catalog and persists the order', () => {
  const service = createService();
  const order = service.create({
    items: [{ productId: 'lain-cap-01', variantId: 'One size', color: 'Black', quantity: 2 }],
    customer: { name: 'Test Buyer', email: 'buyer@example.com' }
  });
  assert.equal(order.subtotal, 58000);
  assert.equal(order.total, 58000);
  assert.equal(order.currency, 'ARS');
  assert.equal(order.status, 'pending');
  assert.equal(order.paymentProvider, null);
  assert.equal(order.paymentId, null);
  assert.deepEqual(service.getById(order.id), order);
});

test('order service ignores client prices and rejects products without a server price', () => {
  const service = createService();
  assert.throws(() => service.create({
    items: [{ productId: 'lain-tee-02', variantId: 'M', quantity: 1, price: 1 }],
    customer: { name: 'Test Buyer', email: 'buyer@example.com' }
  }), /integer price/);
});
