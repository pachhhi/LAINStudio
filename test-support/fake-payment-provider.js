import { PaymentProvider } from '../server/payments/payment-provider.js';

export class FakePaymentProvider extends PaymentProvider {
  constructor(behavior = 'approved', { delay = 0 } = {}) {
    super('fake');
    this.behavior = behavior;
    this.delay = delay;
    this.calls = 0;
  }
  async createPayment() {
    this.calls += 1;
    if (this.delay) await new Promise(resolve => setTimeout(resolve, this.delay));
    if (this.behavior === 'timeout') { const error = new Error('simulated timeout'); error.code = 'TIMEOUT'; throw error; }
    if (this.behavior === 'provider_error') throw new Error('simulated provider failure');
    return { status: this.behavior, paymentId: `fake-${this.calls}` };
  }
  async getPaymentStatus(paymentId) { return { paymentId, status: this.behavior }; }
  async refundPayment(paymentId, amount) { return { paymentId, amount, status: 'refunded' }; }
}
