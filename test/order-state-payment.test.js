import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestCatalog } from '../test-support/catalog-fixture.js';
import { InMemoryOrderRepository } from '../server/orders/order-repository.js';
import { OrderService } from '../server/orders/order-service.js';
import { PaymentProvider } from '../server/payments/payment-provider.js';
import { FakePaymentProvider } from '../test-support/fake-payment-provider.js';

const payload = { items: [{ productId: 'lain-cap-01', variantId: 'One size', color: 'Black', quantity: 1 }], customer: { name: 'Test', email: 'test@example.com' } };
function setup(provider = null) { const repository = new InMemoryOrderRepository(); const service = new OrderService({ catalogService: createTestCatalog(), orderRepository: repository, paymentProvider: provider }); return { service, order: service.create(payload) }; }

test('PaymentProvider is abstract', () => assert.throws(() => new PaymentProvider('x'), /abstract/));

test('state machine rejects impossible transitions', async () => {
  const { service, order } = setup();
  const awaiting = await service.transition(order.id, 'awaiting_payment');
  const paid = await service.transition(awaiting.id, 'paid');
  for (const status of ['pending', 'processing']) await assert.rejects(service.transition(paid.id, status), /Cannot transition/);
  const refunded = await service.transition(paid.id, 'refunded');
  await assert.rejects(service.transition(refunded.id, 'paid'), /Cannot transition/);
  const other = setup(); const cancelled = await other.service.transition(other.order.id, 'cancelled');
  await assert.rejects(other.service.transition(cancelled.id, 'processing'), /Cannot transition/);
  await assert.rejects(service.transition(paid.id, 'unknown'), /Unknown/);
});

for (const [behavior, expected] of [['approved', 'paid'], ['pending', 'processing'], ['rejected', 'failed']]) {
  test(`payment result ${behavior} maps to ${expected}`, async () => {
    const provider = new FakePaymentProvider(behavior); const { service, order } = setup(provider);
    const result = await service.startPayment(order.id, { idempotencyKey: `payment_key_${behavior}_1234` });
    assert.equal(result.status, expected); assert.equal(result.paymentProvider, 'fake'); assert.equal(provider.calls, 1);
  });
}

for (const behavior of ['timeout', 'provider_error']) test(`${behavior} becomes a safe dependency error and failed order`, async () => {
  const provider = new FakePaymentProvider(behavior); const { service, order } = setup(provider);
  await assert.rejects(service.startPayment(order.id, { idempotencyKey: `payment_key_${behavior}_1234` }), /provider/i);
  assert.equal((await service.getById(order.id)).status, 'failed');
});

test('concurrent payment attempts execute the provider once for the same key', async () => {
  const provider = new FakePaymentProvider('approved', { delay: 20 }); const { service, order } = setup(provider);
  const key = 'same_payment_key_123456';
  const results = await Promise.all(Array.from({ length: 10 }, () => service.startPayment(order.id, { idempotencyKey: key })));
  assert.equal(provider.calls, 1); assert.equal(new Set(results.map(result => result.paymentId)).size, 1);
});

test('different concurrent keys cannot start multiple payments on one order', async () => {
  const provider = new FakePaymentProvider('approved', { delay: 20 }); const { service, order } = setup(provider);
  const settled = await Promise.allSettled(['payment_key_one_1234', 'payment_key_two_1234'].map(idempotencyKey => service.startPayment(order.id, { idempotencyKey })));
  assert.equal(provider.calls, 1); assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1); assert.equal(settled.filter(item => item.status === 'rejected').length, 1);
});

test('completed payment retry returns the stored result without another provider call', async () => {
  const provider = new FakePaymentProvider('approved'); const { service, order } = setup(provider); const key = 'completed_payment_key_1234';
  const first = await service.startPayment(order.id, { idempotencyKey: key }); const second = await service.startPayment(order.id, { idempotencyKey: key });
  assert.deepEqual(second, first); assert.equal(provider.calls, 1);
});

test('invalid provider responses fail safely', async () => {
  const provider = new FakePaymentProvider('approved'); provider.createPayment = async () => ({ status: 'mystery' });
  const { service, order } = setup(provider);
  await assert.rejects(service.startPayment(order.id, { idempotencyKey: 'invalid_provider_key_1234' }), /invalid response/);
  assert.equal((await service.getById(order.id)).status, 'failed');
});

test('payment provider default contract methods fail closed', async () => {
  class IncompleteProvider extends PaymentProvider { constructor() { super('incomplete'); } }
  const provider = new IncompleteProvider();
  await assert.rejects(provider.createPayment({}), /not configured/);
  await assert.rejects(provider.getPaymentStatus('x'), /not configured/);
  await assert.rejects(provider.refundPayment('x', 1), /not configured/);
});
