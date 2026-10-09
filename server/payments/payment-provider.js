/** Contract implemented by future payment adapters. */
export class PaymentProvider {
  constructor(name) {
    if (new.target === PaymentProvider) throw new TypeError('PaymentProvider is an abstract contract.');
    if (typeof name !== 'string' || !name) throw new TypeError('Payment provider name is required.');
    this.name = name;
  }
  async createPayment(_order) { throw new Error('Payment provider not configured.'); }
  async createHostedCheckout(_order) { throw new Error('Payment provider not configured.'); }
  async getPaymentStatus(_paymentId) { throw new Error('Payment provider not configured.'); }
  async findPaymentOrder(_criteria) { throw new Error('Payment provider not configured.'); }
  async refundPayment(_paymentId, _amount) { throw new Error('Payment provider not configured.'); }
}
