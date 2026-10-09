const CHECKOUT_ATTEMPT_KEY = 'lain-checkout-attempt-v1';

export function cartFingerprint(items) {
  return JSON.stringify(items.map(item => ({
    productId: item.productId,
    quantity: item.quantity,
    ...(item.variantId ? { variantId: item.variantId } : {}),
    ...(item.color ? { color: item.color } : {})
  })));
}

export class CheckoutAttemptStore {
  constructor(storage = window.sessionStorage, uuid = () => crypto.randomUUID()) {
    this.storage = storage;
    this.uuid = uuid;
  }

  load(items) {
    const fingerprint = cartFingerprint(items);
    try {
      const saved = JSON.parse(this.storage.getItem(CHECKOUT_ATTEMPT_KEY) || 'null');
      if (saved?.cartFingerprint === fingerprint && typeof saved.checkoutKey === 'string') return saved;
    } catch {
      // A missing or malformed attempt starts a new checkout safely.
    }
    const attempt = { cartFingerprint: fingerprint, checkoutKey: this.uuid() };
    this.save(attempt);
    return attempt;
  }

  save(attempt) {
    try { this.storage.setItem(CHECKOUT_ATTEMPT_KEY, JSON.stringify(attempt)); }
    catch { /* The backend idempotency guarantee still applies for the current page. */ }
    return attempt;
  }

  attachOrder(attempt, order) {
    return this.save({ ...attempt, order, paymentKey: attempt.paymentKey || this.uuid() });
  }

  rotateCheckoutKey(attempt, deliveryMode) {
    const { order: _order, paymentKey: _paymentKey, ...current } = attempt;
    return this.save({ ...current, checkoutKey: this.uuid(), deliveryMode });
  }

  rotatePaymentKey(attempt) {
    return this.save({ ...attempt, paymentKey: this.uuid() });
  }

  clear() {
    try { this.storage.removeItem(CHECKOUT_ATTEMPT_KEY); }
    catch { /* Storage failures must not hide a completed payment. */ }
  }
}

export { CHECKOUT_ATTEMPT_KEY };
