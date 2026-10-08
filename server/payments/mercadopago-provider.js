import { DependencyError, ValidationError } from '../errors.js';
import { PaymentProvider } from './payment-provider.js';

const CURRENCY_DECIMALS = Object.freeze({ ARS: 0, BRL: 2, CLP: 0, COP: 0, MXN: 2, PEN: 2, USD: 2, UYU: 2 });
const SUPPORTED_PAYMENT_TYPE = 'credit_card';
const SUPPORTED_CREDIT_PAYMENT_METHODS = new Set(['visa', 'master', 'amex']);
const STATUS_MAP = Object.freeze({
  processed: 'approved', processing: 'pending', created: 'pending', action_required: 'pending',
  failed: 'rejected', rejected: 'rejected', cancelled: 'cancelled', canceled: 'cancelled', expired: 'cancelled',
  refunded: 'refunded', charged_back: 'chargeback'
});

function providerOrderIdPattern(environment) {
  return environment === 'test' ? /^ORDTST[A-Z0-9]+$/ : /^ORD(?!TST)[A-Z0-9]+$/;
}

export class MercadoPagoProviderError extends DependencyError {
  constructor(message, { indeterminate = false, providerStatus = null, providerError = null,
    providerMessage = null, providerCause = [], statusDetail = null, providerPaymentId = null, providerRequestId = null,
    retryAfterSeconds = null } = {}) {
    super(message); this.indeterminate = indeterminate; this.providerStatus = providerStatus;
    this.providerError = providerError; this.providerMessage = providerMessage;
    this.providerCause = providerCause; this.statusDetail = statusDetail;
    this.providerPaymentId = providerPaymentId; this.providerRequestId = providerRequestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function safeProviderDiagnostics(payload, httpStatus) {
  const payment = payload?.transactions?.payments?.[0];
  const rejected = rejectedOrderResult(payload, null);
  const cause = Array.isArray(payload?.cause) ? payload.cause.slice(0, 10).map(item => ({
    ...(item?.code != null ? { code: String(item.code).slice(0, 100) } : {}),
    ...(typeof item?.description === 'string' ? { description: item.description.slice(0, 500) } : {})
  })) : [];
  const errors = Array.isArray(payload?.errors) ? payload.errors.slice(0, 10).map(item => ({
    ...(typeof item?.code === 'string' ? { code: item.code.slice(0, 100) } : {}),
    ...(typeof item?.message === 'string' ? { message: item.message.slice(0, 500) } : {}),
    ...(Array.isArray(item?.details) ? { details: item.details.filter(value => typeof value === 'string').slice(0, 10).map(value => value.slice(0, 300)) } : {})
  })) : [];
  return {
    httpStatus,
    ...(typeof payload?.error === 'string' ? { error: payload.error.slice(0, 200) } : {}),
    ...(typeof payload?.message === 'string' ? { message: payload.message.slice(0, 500) } : {}),
    ...(typeof payload?.status === 'string' ? { paymentStatus: payload.status.slice(0, 80) } : {}),
    ...(typeof payload?.status_detail === 'string' ? { statusDetail: payload.status_detail.slice(0, 160) } : {}),
    ...(payload?.id != null ? { providerOrderId: String(payload.id).slice(0, 100) } : {}),
    ...(payment?.id != null ? { providerPaymentId: String(payment.id).slice(0, 100) } : {}),
    ...(!payment?.id && rejected?.paymentId ? { providerPaymentId: rejected.paymentId } : {}),
    ...(typeof payment?.status === 'string' ? { transactionStatus: payment.status.slice(0, 80) } : {}),
    ...(typeof payment?.status_detail === 'string' ? { transactionStatusDetail: payment.status_detail.slice(0, 160) } : {}),
    ...(!payment?.status && rejected ? { transactionStatus: 'failed', transactionStatusDetail: rejected.statusDetail } : {}),
    ...(cause.length ? { cause } : {})
    , ...(errors.length ? { errors } : {})
  };
}

function rejectedOrderResult(payload, externalReference) {
  if (!Array.isArray(payload?.errors) || !payload.errors.some(error => error?.code === 'failed')) return null;
  const detail = payload.errors.flatMap(error => Array.isArray(error?.details) ? error.details : [])
    .find(value => typeof value === 'string' && /^PAY[A-Za-z0-9]+: [a-z0-9_]+$/.test(value));
  if (!detail) return null;
  const [paymentId, statusDetail] = detail.split(': ');
  return { orderId: null, paymentId, status: 'rejected', statusDetail, externalReference };
}

export function minorUnitsToProviderAmount(amount, currency) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new ValidationError('Payment amount must use non-negative safe integer minor units.');
  const decimals = CURRENCY_DECIMALS[currency];
  if (decimals == null) throw new ValidationError(`Unsupported payment currency ${currency}.`);
  if (decimals === 0) return amount;
  const scale = 10 ** decimals;
  return Number(`${Math.floor(amount / scale)}.${String(amount % scale).padStart(decimals, '0')}`);
}

export function mapMercadoPagoStatus(status, statusDetail = null) {
  if (status === 'processed' && statusDetail === 'refunded') return 'refunded';
  if (status === 'processed' && statusDetail === 'partially_refunded') return 'partially_refunded';
  if (status === 'charged_back' && statusDetail === 'reimbursed') return 'refunded';
  const mapped = STATUS_MAP[status];
  if (!mapped) throw new MercadoPagoProviderError('Mercado Pago returned an unknown payment status.');
  return mapped;
}

function validatePaymentData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ValidationError('Payment data is required.');
  if (typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(data.token)) throw new ValidationError('A valid card token is required.');
  if (typeof data.paymentMethodId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(data.paymentMethodId)) throw new ValidationError('A valid payment method is required.');
  if (!SUPPORTED_CREDIT_PAYMENT_METHODS.has(data.paymentMethodId)) throw new ValidationError('Unsupported credit card payment method.');
  if (data.paymentTypeId != null && data.paymentTypeId !== SUPPORTED_PAYMENT_TYPE) {
    throw new ValidationError('Only credit card payments are supported.');
  }
  if (!Number.isInteger(data.installments) || data.installments < 1 || data.installments > 48) throw new ValidationError('Invalid installments value.');
  const identification = data.identification;
  if (identification != null && (typeof identification !== 'object' || Array.isArray(identification)
    || typeof identification.type !== 'string' || typeof identification.number !== 'string')) throw new ValidationError('Invalid payer identification.');
  return { token: data.token, paymentMethodId: data.paymentMethodId, paymentTypeId: SUPPORTED_PAYMENT_TYPE, installments: data.installments,
    ...(typeof data.issuerId === 'string' && data.issuerId ? { issuerId: data.issuerId } : {}),
    ...(identification ? { identification: { type: identification.type.slice(0, 20), number: identification.number.slice(0, 30) } } : {}) };
}

export class MercadoPagoProvider extends PaymentProvider {
  constructor({ accessToken, environment, fetchImpl = fetch, timeoutMs = 15000,
    baseUrl = 'https://api.mercadopago.com', logger = console }) {
    super('mercadopago');
    if (!['test', 'production'].includes(environment)) throw new Error('PAYMENT_ENV must be test or production.');
    if (typeof accessToken !== 'string' || !accessToken) throw new Error('MERCADOPAGO_ACCESS_TOKEN is required.');
    this.accessToken = accessToken; this.environment = environment; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl; this.logger = logger;
  }

  async request(path, { method = 'GET', body, idempotencyKey, acceptedStatuses = [] } = {}) {
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
    const diagnostics = { ...safeProviderDiagnostics(payload, response.status),
      ...(response.headers?.get?.('x-request-id') ? { requestId: response.headers.get('x-request-id') } : {}) };
    this.logger.info?.('Mercado Pago response', diagnostics);
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      const indeterminate = response.status >= 500 || response.status === 429;
      throw new MercadoPagoProviderError('Mercado Pago rejected the request.', {
        indeterminate, providerStatus: response.status, providerError: diagnostics.error,
        providerMessage: diagnostics.message, providerCause: diagnostics.cause,
        statusDetail: diagnostics.statusDetail, providerPaymentId: diagnostics.providerPaymentId,
        providerRequestId: diagnostics.requestId,
        retryAfterSeconds: response.status === 429 ? Number.parseInt(response.headers?.get?.('retry-after') || '', 10) || null : null
      });
    }
    if (!payload || typeof payload !== 'object') throw new MercadoPagoProviderError('Mercado Pago returned a malformed response.', { indeterminate: method === 'POST' });
    return payload;
  }

  async createPayment(order, context = {}) {
    const data = validatePaymentData(context.paymentData);
    if (typeof context.providerIdempotencyKey !== 'string' || !context.providerIdempotencyKey) throw new ValidationError('Provider idempotency key is required.');
    const amount = minorUnitsToProviderAmount(order.total, order.currency).toFixed(2);
    const requestBody = {
      type: 'online', processing_mode: 'automatic', total_amount: amount,
      external_reference: context.paymentAttemptId,
      payer: { email: this.environment === 'test' ? 'test@testuser.com' : order.customer.email },
      transactions: { payments: [{ amount, payment_method: {
        id: data.paymentMethodId, type: data.paymentTypeId, token: data.token, installments: data.installments
      } }] }
    };
    this.logger.info?.('Mercado Pago payment request', {
      totalAmount: requestBody.total_amount, paymentMethodId: data.paymentMethodId, paymentTypeId: data.paymentTypeId,
      installments: data.installments, payerEmailPresent: Boolean(requestBody.payer.email),
      identificationReceived: Boolean(data.identification),
      tokenPresent: true,
      paymentAttemptId: context.paymentAttemptId
    });
    const payload = await this.request('/v1/orders', { method: 'POST', idempotencyKey: context.providerIdempotencyKey,
      body: requestBody, acceptedStatuses: [402] });
    const rejected = rejectedOrderResult(payload, context.paymentAttemptId);
    if (rejected) return rejected;
    const payment = payload.transactions?.payments?.[0];
    if (typeof payload.id !== 'string' || !providerOrderIdPattern(this.environment).test(payload.id)
      || typeof payload.status !== 'string' || typeof payment?.id !== 'string') {
      throw new MercadoPagoProviderError('Mercado Pago returned a malformed order.');
    }
    return { orderId: payload.id, paymentId: payment.id, status: mapMercadoPagoStatus(payload.status, payload.status_detail),
      statusDetail: payload.status_detail || payment.status_detail || null,
      externalReference: payload.external_reference || context.paymentAttemptId };
  }

  async getPaymentStatus(orderId) {
    const orderIdPattern = providerOrderIdPattern(this.environment);
    if (typeof orderId !== 'string' || !orderIdPattern.test(orderId)) throw new ValidationError(`A valid ${this.environment} provider order ID is required.`);
    const payload = await this.request(`/v1/orders/${encodeURIComponent(orderId)}`);
    const payment = payload.transactions?.payments?.[0];
    if (typeof payload.id !== 'string' || typeof payload.status !== 'string' || typeof payment?.id !== 'string') {
      throw new MercadoPagoProviderError('Mercado Pago returned a malformed order status.');
    }
    if (payload.id !== orderId || !orderIdPattern.test(payload.id)) {
      throw new MercadoPagoProviderError(`Mercado Pago returned a mismatched ${this.environment} order.`);
    }
    return { orderId: payload.id, paymentId: payment.id, status: mapMercadoPagoStatus(payload.status, payload.status_detail),
      statusDetail: payload.status_detail || payment.status_detail || null,
      externalReference: payload.external_reference ? String(payload.external_reference) : null,
      totalAmount: typeof payload.total_amount === 'string' || typeof payload.total_amount === 'number' ? String(payload.total_amount) : null };
  }

  async findPaymentOrder({ externalReference, createdAt }) {
    if (typeof externalReference !== 'string' || !/^[0-9a-f-]{36}$/i.test(externalReference)) throw new ValidationError('A valid payment attempt reference is required.');
    const created = new Date(createdAt);
    if (Number.isNaN(created.getTime())) throw new ValidationError('A valid payment attempt creation date is required.');
    const begin = new Date(created.getTime() - 5 * 60_000).toISOString();
    const end = new Date(Math.max(Date.now(), created.getTime()) + 5 * 60_000).toISOString();
    const query = new URLSearchParams({ begin_date: begin, end_date: end, external_reference: externalReference,
      type: 'online', page: '1', page_size: '20', sort_by: 'created_date', sort_order: 'desc' });
    const payload = await this.request(`/v1/orders?${query}`);
    if (!Array.isArray(payload.data)) throw new MercadoPagoProviderError('Mercado Pago returned a malformed order search response.');
    const orderIdPattern = providerOrderIdPattern(this.environment);
    const matches = payload.data.filter(item => item && String(item.external_reference || '') === externalReference
      && typeof item.id === 'string' && orderIdPattern.test(item.id));
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw new MercadoPagoProviderError('Mercado Pago returned multiple orders for one payment attempt.');
    return this.getPaymentStatus(matches[0].id);
  }

  async refundPayment(paymentId, _amount) {
    throw new MercadoPagoProviderError(`Refund is not enabled in this test integration for payment ${paymentId}.`);
  }
}

export { CURRENCY_DECIMALS, SUPPORTED_CREDIT_PAYMENT_METHODS, SUPPORTED_PAYMENT_TYPE, providerOrderIdPattern };
