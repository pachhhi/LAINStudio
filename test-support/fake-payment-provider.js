import { PaymentProvider } from '../server/payments/payment-provider.js';

export class FakePaymentProvider extends PaymentProvider {
  constructor(behavior = 'approved', { delay = 0 } = {}) {
    super('fake');
    this.behavior = behavior;
    this.delay = delay;
    this.calls = 0;
  }
  async createPayment(order, context = {}) {
    this.calls += 1;
    this.lastPaymentAttemptId = context.paymentAttemptId || null;
    this.lastTotalAmount = order.total;
    if (this.delay) await new Promise(resolve => setTimeout(resolve, this.delay));
    if (this.behavior === 'timeout') { const error = new Error('simulated timeout'); error.code = 'TIMEOUT'; throw error; }
    if (this.behavior === 'provider_error') throw new Error('simulated provider failure');
    return { status: this.behavior, paymentId: `fake-${this.calls}`, orderId: `ORDTSTFAKE${this.calls}` };
  }
  async getPaymentStatus(orderId) {
    const knownOrder = orderId === 'ORDTSTFAKE1';
    return { orderId, paymentId: knownOrder ? 'fake-1' : 'unknown-payment', status: this.behavior,
      externalReference: knownOrder ? this.lastPaymentAttemptId : null,
      totalAmount: String(this.lastTotalAmount) };
  }
  async refundPayment(paymentId, amount) { return { paymentId, amount, status: 'refunded' }; }
}
