import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestCatalog } from '../test-support/catalog-fixture.js';
import { InMemoryOrderRepository } from '../server/orders/order-repository.js';
import { OrderService } from '../server/orders/order-service.js';
import { PaymentProvider } from '../server/payments/payment-provider.js';
import { FakePaymentProvider } from '../test-support/fake-payment-provider.js';
import { ValidationError } from '../server/errors.js';

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

test('hosted checkout persists one reusable redirect without requiring a payment ID', async () => {
  const provider = new FakePaymentProvider('pending'); const { service, order } = setup(provider);
  const options = { idempotencyKey: 'hosted_payment_key_1234', returnUrls: {
    successUrl: 'https://lain.example/order.html', failureUrl: 'https://lain.example/order.html', pendingUrl: 'https://lain.example/order.html' } };
  const first = await service.startHostedPayment(order.id, options);
  const second = await service.startHostedPayment(order.id, options);
  assert.equal(provider.calls, 1); assert.equal(first.order.status, 'processing'); assert.equal(first.checkoutUrl, second.checkoutUrl);
  const attempts = await service.orderRepository.listPaymentAttemptsForOrder(order.id);
  assert.equal(attempts[0].paymentFlow, 'checkout_pro'); assert.equal(attempts[0].providerPaymentId, null);
});

test('card and hosted checkout cannot create concurrent provider orders for one local order', async () => {
  const provider = new FakePaymentProvider('approved', { delay: 20 }); const { service, order } = setup(provider);
  const hosted = service.startHostedPayment(order.id, { idempotencyKey: 'hosted_concurrent_key_1', returnUrls: {
    successUrl: 'https://lain.example/order.html', failureUrl: 'https://lain.example/order.html', pendingUrl: 'https://lain.example/order.html' } });
  const card = service.startPayment(order.id, { idempotencyKey: 'card_concurrent_key_1234', paymentData: {} });
  const settled = await Promise.allSettled([hosted, card]);
  assert.equal(provider.calls, 1); assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
});

test('ambiguous hosted checkout blocks a second payment key', async () => {
  const provider = new FakePaymentProvider('timeout'); const { service, order } = setup(provider);
  const returnUrls = { successUrl: 'https://lain.example/order.html', failureUrl: 'https://lain.example/order.html', pendingUrl: 'https://lain.example/order.html' };
  await assert.rejects(service.startHostedPayment(order.id, { idempotencyKey: 'hosted_timeout_key_1234', returnUrls }), /provider/i);
  assert.equal((await service.getById(order.id)).status, 'processing');
  await assert.rejects(service.startPayment(order.id, { idempotencyKey: 'new_card_key_after_timeout' }), /Cannot start payment from processing/);
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
  assert.equal((await service.getById(order.id)).status, 'processing');
});

test('mismatched synchronous payment identity is ambiguous and blocks a new payment key', async () => {
  const provider = new FakePaymentProvider('approved');
  provider.createPayment = async (order, context) => ({ status: 'approved', paymentId: 'PAY-WRONG', orderId: 'ORDTSTWRONG',
    externalReference: '22222222-2222-4222-8222-222222222222', totalAmount: String(order.total), currency: order.currency });
  const { service, order } = setup(provider);
  await assert.rejects(service.startPayment(order.id, { idempotencyKey: 'identity_mismatch_key_1234' }), error => error.indeterminate === true);
  assert.equal((await service.getById(order.id)).status, 'processing');
  await assert.rejects(service.startPayment(order.id, { idempotencyKey: 'different_payment_key_1234' }), /Cannot start payment from processing/);
});

test('provider approval followed by persistence failure remains processing with provider IDs', async () => {
  const provider = new FakePaymentProvider('approved'); const repository = new InMemoryOrderRepository();
  const original = repository.completePayment.bind(repository);
  repository.completePayment = async () => { throw new Error('database unavailable'); };
  const service = new OrderService({ catalogService: createTestCatalog(), orderRepository: repository, paymentProvider: provider });
  const order = service.create(payload);
  await assert.rejects(service.startPayment(order.id, { idempotencyKey: 'persist_failure_key_1234' }), error => error.indeterminate === true);
  assert.equal((await service.getById(order.id)).status, 'processing');
  const [attempt] = repository.listPaymentAttemptsForOrder(order.id);
  assert.equal(attempt.status, 'processing'); assert.equal(attempt.providerOrderId, 'ORDTSTFAKE1'); assert.equal(attempt.providerPaymentId, 'fake-1');
  repository.completePayment = original;
  await assert.rejects(service.startPayment(order.id, { idempotencyKey: 'persist_failure_new_key_1234' }), /Cannot start payment from processing/);
});

test('late failure and stale approval cannot overwrite approved, refund or chargeback states', async () => {
  const provider = new FakePaymentProvider('pending'); const { service, order } = setup(provider);
  await service.startPayment(order.id, { idempotencyKey: 'late_state_key_123456' });
  const repository = service.orderRepository; const [attempt] = repository.listPaymentAttemptsForOrder(order.id);
  provider.behavior = 'approved'; await service.reconcileProviderPayment('ORDTSTFAKE1');
  await repository.failPayment({ attemptId: attempt.id, orderId: order.id });
  assert.equal((await service.getById(order.id)).status, 'paid');
  provider.behavior = 'refunded'; await service.reconcileProviderPayment('ORDTSTFAKE1');
  const stale = await repository.completePayment({ attemptId: attempt.id, orderId: order.id, status: 'approved', orderStatus: 'paid',
    providerPaymentId: 'fake-1', providerOrderId: 'ORDTSTFAKE1', provider: 'fake' });
  assert.equal(stale.status, 'refunded'); assert.equal(repository.listPaymentAttemptsForOrder(order.id)[0].status, 'refunded');
});

test('webhook reconciliation winning before the synchronous approval is idempotent', async () => {
  let release;
  const provider = new FakePaymentProvider('approved');
  provider.createPayment = async (order, context) => new Promise(resolve => { release = () => resolve({ status: 'approved', paymentId: 'PAY-RACE',
    orderId: 'ORDTSTRACE', externalReference: context.paymentAttemptId, totalAmount: String(order.total), currency: order.currency }); });
  const { service, order } = setup(provider);
  const pending = service.startPayment(order.id, { idempotencyKey: 'webhook_race_key_123456' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const [attempt] = service.orderRepository.listPaymentAttemptsForOrder(order.id);
  const reconciled = await service.reconcileProviderResult({ status: 'approved', paymentId: 'PAY-RACE', orderId: 'ORDTSTRACE',
    externalReference: attempt.id, totalAmount: String(order.total), currency: order.currency });
  assert.equal(reconciled.status, 'paid');
  release();
  assert.equal((await pending).status, 'paid');
  assert.equal(service.orderRepository.listPaymentAttemptsForOrder(order.id).length, 1);
});

test('payment input validation remains a validation error instead of a provider dependency error', async () => {
  const provider = new FakePaymentProvider('approved');
  provider.createPayment = async () => { throw new ValidationError('Only credit card payments are supported.'); };
  const { service, order } = setup(provider);
  await assert.rejects(service.startPayment(order.id, { idempotencyKey: 'invalid_payment_input_1234' }), error => {
    assert.equal(error.code, 'VALIDATION_ERROR'); assert.equal(error.status, 400); return true;
  });
  assert.equal((await service.getById(order.id)).status, 'failed');
});

test('payment provider default contract methods fail closed', async () => {
  class IncompleteProvider extends PaymentProvider { constructor() { super('incomplete'); } }
  const provider = new IncompleteProvider();
  await assert.rejects(provider.createPayment({}), /not configured/);
  await assert.rejects(provider.getPaymentStatus('x'), /not configured/);
  await assert.rejects(provider.refundPayment('x', 1), /not configured/);
});

test('approved payments transition idempotently through partial refund and full refund', async () => {
  const provider = new FakePaymentProvider('pending'); const { service, order } = setup(provider);
  await service.startPayment(order.id, { idempotencyKey: 'refund_lifecycle_key_1234' });
  provider.behavior = 'approved'; assert.equal((await service.reconcileProviderPayment('ORDTSTFAKE1')).status, 'paid');
  provider.behavior = 'partially_refunded'; assert.equal((await service.reconcileProviderPayment('ORDTSTFAKE1')).status, 'partially_refunded');
  assert.equal((await service.reconcileProviderPayment('ORDTSTFAKE1')).status, 'partially_refunded');
  provider.behavior = 'refunded'; assert.equal((await service.reconcileProviderPayment('ORDTSTFAKE1')).status, 'refunded');
});

test('approved payments transition through chargeback without allowing stale approval downgrade', async () => {
  const provider = new FakePaymentProvider('pending'); const { service, order } = setup(provider);
  await service.startPayment(order.id, { idempotencyKey: 'chargeback_lifecycle_key_1234' });
  provider.behavior = 'approved'; await service.reconcileProviderPayment('ORDTSTFAKE1');
  provider.behavior = 'chargeback'; assert.equal((await service.reconcileProviderPayment('ORDTSTFAKE1')).status, 'chargeback');
  provider.behavior = 'approved'; assert.equal((await service.reconcileProviderPayment('ORDTSTFAKE1')).status, 'chargeback');
  provider.behavior = 'refunded'; assert.equal((await service.reconcileProviderPayment('ORDTSTFAKE1')).status, 'refunded');
});
