import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryOrderRepository } from '../server/orders/order-repository.js';
import { OrderService } from '../server/orders/order-service.js';
import { PaymentReconciler } from '../server/payments/payment-reconciler.js';
import { PaymentProvider } from '../server/payments/payment-provider.js';
import { createTestCatalog } from '../test-support/catalog-fixture.js';

const payload = { items: [{ productId: 'lain-cap-01', variantId: 'One size', color: 'Black', quantity: 1 }],
  customer: { name: 'Reconciliation', email: 'reconciliation@example.com' } };

class ReconciliationProvider extends PaymentProvider {
  constructor(initial = 'pending') { super('mercadopago'); this.initial = initial; this.lookup = 'approved'; this.attemptId = null; this.postCalls = 0; this.lookupCalls = 0; }
  async createPayment(order, context) {
    this.postCalls += 1; this.attemptId = context.paymentAttemptId; this.amount = order.total;
    if (this.initial === 'timeout') { const error = new Error('timeout'); error.indeterminate = true; throw error; }
    return { orderId: 'ORDTSTRECONCILE1', paymentId: 'PAYRECONCILE1', status: this.initial,
      externalReference: this.attemptId };
  }
  result(orderId = 'ORDTSTRECONCILE1') {
    return { orderId, paymentId: 'PAYRECONCILE1', status: this.lookup, statusDetail: this.lookup === 'approved' ? 'accredited' : 'in_process',
      externalReference: this.attemptId, totalAmount: `${this.amount}.00` };
  }
  async getPaymentStatus(orderId) { this.lookupCalls += 1; return this.result(orderId); }
  async findPaymentOrder() { this.lookupCalls += 1; return this.searchResult === undefined ? this.result() : this.searchResult; }
}

async function setup(provider) {
  const repository = new InMemoryOrderRepository();
  const service = new OrderService({ catalogService: createTestCatalog(), orderRepository: repository, paymentProvider: provider });
  const order = await service.create(payload);
  try { await service.startPayment(order.id, { idempotencyKey: 'reconciliation_payment_key_1' }); }
  catch (error) { if (provider.initial !== 'timeout') throw error; }
  return { repository, service, order };
}

function reconciler(repository, service, provider, options = {}) {
  return new PaymentReconciler({ orderRepository: repository, orderService: service, paymentProvider: provider,
    intervalMs: 300_000, logger: { error() {} }, ...options });
}

test('periodic reconciliation advances pending to accredited without another POST', async () => {
  const provider = new ReconciliationProvider('pending'); const { repository, service, order } = await setup(provider);
  await reconciler(repository, service, provider).runOnce();
  const stored = await service.getById(order.id);
  assert.equal(stored.status, 'paid'); assert.equal(stored.providerOrderId, 'ORDTSTRECONCILE1');
  assert.equal(stored.paymentId, 'PAYRECONCILE1'); assert.equal(provider.postCalls, 1);
});

test('ambiguous POST response is recovered by external_reference search and never repeated', async () => {
  const provider = new ReconciliationProvider('timeout'); const { repository, service, order } = await setup(provider);
  assert.equal((await service.getById(order.id)).status, 'processing');
  await reconciler(repository, service, provider).runOnce();
  assert.equal((await service.getById(order.id)).status, 'paid');
  assert.equal(provider.postCalls, 1); assert.equal(provider.lookupCalls, 1);
});

test('an unresolved ambiguous payment is eventually marked for manual review', async () => {
  const provider = new ReconciliationProvider('timeout'); provider.searchResult = null;
  const { repository, service } = await setup(provider); const worker = reconciler(repository, service, provider, { maxFailures: 1 });
  await worker.runOnce();
  const due = await repository.claimPaymentReconciliationBatch({ provider: provider.name, maxFailures: 1 });
  assert.equal(due.length, 0); assert.equal(provider.postCalls, 1);
});

test('temporary provider failures are bounded and do not expose sensitive errors', async () => {
  const provider = new ReconciliationProvider('pending'); const { repository, service } = await setup(provider);
  provider.getPaymentStatus = async () => { const error = new Error('token=secret'); error.indeterminate = true; error.providerStatus = 503; throw error; };
  const logs = []; await reconciler(repository, service, provider, { logger: { error: (...entry) => logs.push(entry) } }).runOnce();
  assert.equal(JSON.stringify(logs).includes('token=secret'), false);
  assert.match(JSON.stringify(logs), /PROVIDER_UNAVAILABLE/);
});

test('concurrent workers claim one attempt and an amount mismatch fails closed', async () => {
  const provider = new ReconciliationProvider('pending'); const { repository, service, order } = await setup(provider);
  provider.getPaymentStatus = async orderId => ({ ...provider.result(orderId), totalAmount: '1.00' });
  const workers = [reconciler(repository, service, provider), reconciler(repository, service, provider)];
  await Promise.all(workers.map(worker => worker.runOnce()));
  assert.equal((await service.getById(order.id)).status, 'processing');
  assert.equal(provider.postCalls, 1);
});
