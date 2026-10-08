/** Storage contract used by OrderService. Implementations must return detached objects. */
export class OrderRepository {
  async save(_order) { throw new Error('Not implemented.'); }
  async createWithIdempotency(_order, _options) { throw new Error('Not implemented.'); }
  async findById(_id) { throw new Error('Not implemented.'); }
  async findByPublicOrderId(_publicOrderId) { throw new Error('Not implemented.'); }
  async listRecent(_options) { throw new Error('Not implemented.'); }
  async listPaymentAttemptsNeedingReview(_options) { throw new Error('Not implemented.'); }
  async listPaymentAttemptsForOrder(_orderId) { throw new Error('Not implemented.'); }
  async update(_id, _expectedVersion, _updater) { throw new Error('Not implemented.'); }
  async beginPayment(_options) { throw new Error('Not implemented.'); }
  async completePayment(_options) { throw new Error('Not implemented.'); }
  async markPaymentProcessing(_options) { throw new Error('Not implemented.'); }
  async failPayment(_options) { throw new Error('Not implemented.'); }
  async findPaymentAttempt(_options) { throw new Error('Not implemented.'); }
  async reconcilePayment(_options) { throw new Error('Not implemented.'); }
  async claimPaymentReconciliationBatch(_options) { throw new Error('Not implemented.'); }
  async releasePaymentReconciliation(_options) { throw new Error('Not implemented.'); }
  async close() {}
}
