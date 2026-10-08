const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;
const SETTLED_PAYMENT_INTERVAL_MS = 6 * 60 * 60_000;

function retryDate(attempt, error, now) {
  const exponential = Math.min(DEFAULT_INTERVAL_MS * (2 ** attempt.reconciliationFailures), MAX_RETRY_DELAY_MS);
  const providerDelay = Number.isInteger(error?.retryAfterSeconds) ? error.retryAfterSeconds * 1000 : 0;
  return new Date(now.getTime() + Math.min(Math.max(exponential, providerDelay), MAX_RETRY_DELAY_MS)).toISOString();
}

function safeErrorCode(error) {
  if (error?.providerStatus === 429) return 'PROVIDER_RATE_LIMIT';
  if (error?.providerStatus >= 500) return 'PROVIDER_UNAVAILABLE';
  if (error?.indeterminate) return 'PROVIDER_TIMEOUT';
  return error?.code === 'DEPENDENCY_ERROR' ? 'RECONCILIATION_MISMATCH' : 'RECONCILIATION_ERROR';
}

export class PaymentReconciler {
  constructor({ orderRepository, orderService, paymentProvider, logger = console, intervalMs = DEFAULT_INTERVAL_MS,
    batchSize = 20, maxFailures = 8, clock = () => new Date() }) {
    this.orderRepository = orderRepository; this.orderService = orderService; this.paymentProvider = paymentProvider;
    this.logger = logger; this.intervalMs = intervalMs; this.batchSize = batchSize; this.maxFailures = maxFailures; this.clock = clock;
    this.timer = null; this.running = null; this.stopped = false;
  }

  start() {
    if (!this.paymentProvider || this.timer || this.running) return;
    this.stopped = false;
    this.runOnce().catch(() => {});
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.running || Promise.resolve();
  }

  schedule() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.runOnce().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
  }

  async runOnce() {
    if (this.running) return this.running;
    this.running = this.#run().catch(error => {
      this.logger.error?.('Payment reconciliation cycle failed', { code: error?.code || 'RECONCILIATION_CYCLE_ERROR' });
      throw error;
    }).finally(() => { this.running = null; this.schedule(); });
    return this.running;
  }

  async #run() {
    const attempts = await this.orderRepository.claimPaymentReconciliationBatch({ provider: this.paymentProvider.name,
      limit: this.batchSize, maxFailures: this.maxFailures });
    for (const attempt of attempts) await this.#reconcile(attempt);
    return attempts.length;
  }

  async #reconcile(attempt) {
    try {
      const order = await this.orderService.reconcilePaymentAttempt(attempt);
      if (!order) {
        const outcome = attempt.reconciliationFailures + 1 >= this.maxFailures ? 'manual_review' : 'transient_error';
        await this.orderRepository.releasePaymentReconciliation({ attemptId: attempt.id, lockId: attempt.lockId,
          outcome,
          retryAt: retryDate(attempt, null, this.clock()), errorCode: 'PROVIDER_ORDER_NOT_FOUND', maxFailures: this.maxFailures });
        if (outcome === 'manual_review') this.logger.error?.('Payment reconciliation requires manual review', {
          paymentAttemptId: attempt.id, provider: attempt.provider, code: 'PROVIDER_ORDER_NOT_FOUND' });
        return;
      }
      const monitored = ['paid', 'partially_refunded', 'chargeback'].includes(order.status);
      const terminal = ['failed', 'cancelled', 'refunded'].includes(order.status);
      await this.orderRepository.releasePaymentReconciliation({ attemptId: attempt.id, lockId: attempt.lockId,
        outcome: 'success', retryAt: terminal ? null : new Date(this.clock().getTime()
          + (monitored ? SETTLED_PAYMENT_INTERVAL_MS : this.intervalMs)).toISOString(),
        errorCode: null, maxFailures: this.maxFailures });
    } catch (error) {
      const transient = error?.indeterminate || error?.providerStatus === 429 || error?.providerStatus >= 500;
      const outcome = transient && attempt.reconciliationFailures + 1 < this.maxFailures ? 'transient_error' : 'manual_review';
      await this.orderRepository.releasePaymentReconciliation({ attemptId: attempt.id, lockId: attempt.lockId, outcome,
        retryAt: outcome === 'transient_error' ? retryDate(attempt, error, this.clock()) : null,
        errorCode: safeErrorCode(error), maxFailures: this.maxFailures });
      this.logger.error?.('Payment reconciliation failed', { paymentAttemptId: attempt.id, provider: attempt.provider,
        providerOrderId: attempt.providerOrderId || null, code: safeErrorCode(error), manualReview: outcome === 'manual_review' });
    }
  }
}

export { DEFAULT_INTERVAL_MS, MAX_RETRY_DELAY_MS, SETTLED_PAYMENT_INTERVAL_MS };
