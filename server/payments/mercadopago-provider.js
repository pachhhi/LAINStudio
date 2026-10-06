import { DependencyError, ValidationError } from '../errors.js';
import { PaymentProvider } from './payment-provider.js';

const CURRENCY_DECIMALS = Object.freeze({ ARS: 0, BRL: 2, CLP: 0, COP: 0, MXN: 2, PEN: 2, USD: 2, UYU: 2 });
const STATUS_MAP = Object.freeze({
  approved: 'approved', pending: 'pending', in_process: 'pending', authorized: 'pending',
  rejected: 'rejected', cancelled: 'cancelled', refunded: 'refunded', charged_back: 'refunded'
});

export class MercadoPagoProviderError extends DependencyError {
  constructor(message, { indeterminate = false, providerStatus = null } = {}) {
    super(message); this.indeterminate = indeterminate; this.providerStatus = providerStatus;
  }
}

export function minorUnitsToProviderAmount(amount, currency) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new ValidationError('Payment amount must use non-negative safe integer minor units.');
  const decimals = CURRENCY_DECIMALS[currency];
  if (decimals == null) throw new ValidationError(`Unsupported payment currency ${currency}.`);
  if (decimals === 0) return amount;
  const scale = 10 ** decimals;
  return Number(`${Math.floor(amount / scale)}.${String(amount % scale).padStart(decimals, '0')}`);
}

export function mapMercadoPagoStatus(status) {
  const mapped = STATUS_MAP[status];
  if (!mapped) throw new MercadoPagoProviderError('Mercado Pago returned an unknown payment status.');
  return mapped;
}

function validatePaymentData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ValidationError('Payment data is required.');
  if (typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(data.token)) throw new ValidationError('A valid card token is required.');
  if (typeof data.paymentMethodId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(data.paymentMethodId)) throw new ValidationError('A valid payment method is required.');
  if (!Number.isInteger(data.installments) || data.installments < 1 || data.installments > 48) throw new ValidationError('Invalid installments value.');
  const identification = data.identification;
  if (identification != null && (typeof identification !== 'object' || Array.isArray(identification)
    || typeof identification.type !== 'string' || typeof identification.number !== 'string')) throw new ValidationError('Invalid payer identification.');
  return { token: data.token, paymentMethodId: data.paymentMethodId, installments: data.installments,
    ...(typeof data.issuerId === 'string' && data.issuerId ? { issuerId: data.issuerId } : {}),
    ...(identification ? { identification: { type: identification.type.slice(0, 20), number: identification.number.slice(0, 30) } } : {}) };
}

export class MercadoPagoProvider extends PaymentProvider {
  constructor({ accessToken, environment, notificationUrl = '', fetchImpl = fetch, timeoutMs = 15000, baseUrl = 'https://api.mercadopago.com' }) {
    super('mercadopago');
    if (environment !== 'test') throw new Error('Mercado Pago provider is restricted to PAYMENT_ENV=test.');
    if (typeof accessToken !== 'string' || !accessToken) throw new Error('MP_ACCESS_TOKEN is required.');
    this.accessToken = accessToken; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl; this.notificationUrl = notificationUrl;
  }

  async request(path, { method = 'GET', body, idempotencyKey } = {}) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method, signal: controller.signal,
        headers: { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch (error) {
      throw new MercadoPagoProviderError(error?.name === 'AbortError' ? 'Mercado Pago request timed out.' : 'Mercado Pago network request failed.', { indeterminate: method === 'POST' });
    } finally { clearTimeout(timeout); }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const indeterminate = response.status >= 500 || response.status === 429;
      throw new MercadoPagoProviderError('Mercado Pago rejected the request.', { indeterminate, providerStatus: response.status });
    }
    if (!payload || typeof payload !== 'object') throw new MercadoPagoProviderError('Mercado Pago returned a malformed response.', { indeterminate: method === 'POST' });
    return payload;
  }

  async createPayment(order, context = {}) {
    const data = validatePaymentData(context.paymentData);
    if (typeof context.providerIdempotencyKey !== 'string' || !context.providerIdempotencyKey) throw new ValidationError('Provider idempotency key is required.');
    const payload = await this.request('/v1/payments', { method: 'POST', idempotencyKey: context.providerIdempotencyKey, body: {
      transaction_amount: minorUnitsToProviderAmount(order.total, order.currency), token: data.token,
      description: `LAIN Store order ${order.id}`, installments: data.installments,
      payment_method_id: data.paymentMethodId, ...(data.issuerId ? { issuer_id: data.issuerId } : {}),
      payer: { email: order.customer.email, ...(data.identification ? { identification: data.identification } : {}) },
      external_reference: context.paymentAttemptId,
      ...(this.notificationUrl ? { notification_url: this.notificationUrl } : {})
    }});
    if (payload.id == null || typeof payload.status !== 'string') throw new MercadoPagoProviderError('Mercado Pago returned a malformed payment.', { indeterminate: true });
    return { paymentId: String(payload.id), status: mapMercadoPagoStatus(payload.status), externalReference: payload.external_reference || context.paymentAttemptId };
  }

  async getPaymentStatus(paymentId) {
    if (typeof paymentId !== 'string' || !paymentId) throw new ValidationError('Payment ID is required.');
    const payload = await this.request(`/v1/payments/${encodeURIComponent(paymentId)}`);
    if (payload.id == null || typeof payload.status !== 'string') throw new MercadoPagoProviderError('Mercado Pago returned a malformed payment status.');
    return { paymentId: String(payload.id), status: mapMercadoPagoStatus(payload.status), externalReference: payload.external_reference ? String(payload.external_reference) : null };
  }

  async refundPayment(paymentId, _amount) {
    throw new MercadoPagoProviderError(`Refund is not enabled in this test integration for payment ${paymentId}.`);
  }
}

export { CURRENCY_DECIMALS };
