import { randomUUID } from 'node:crypto';
import { ConflictError, DependencyError, NotFoundError, ValidationError } from '../errors.js';

const ORDER_STATUSES = ['pending', 'awaiting_payment', 'processing', 'paid', 'failed', 'cancelled', 'refunded'];
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['processing', 'paid', 'failed', 'cancelled'],
  processing: ['paid', 'failed', 'cancelled'],
  paid: ['refunded'],
  failed: ['awaiting_payment', 'cancelled'],
  cancelled: [],
  refunded: []
});
const PROVIDER_STATUS_TO_ORDER = Object.freeze({ approved: 'paid', pending: 'processing', rejected: 'failed', cancelled: 'cancelled', refunded: 'refunded' });

function requireString(value, field, { min = 1, max, pattern } = {}) {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string.`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max || (pattern && !pattern.test(normalized))) {
    throw new ValidationError(`A valid ${field} is required.`);
  }
  return normalized;
}

export class OrderService {
  #paymentOperations = new Map();
  constructor({ catalogService, orderRepository, paymentProvider = null, shippingService = null, idGenerator = randomUUID, publicIdGenerator = randomUUID, clock = () => new Date() }) {
    this.catalogService = catalogService;
    this.orderRepository = orderRepository;
    this.paymentProvider = paymentProvider;
    this.shippingService = shippingService;
    this.idGenerator = idGenerator;
    this.publicIdGenerator = publicIdGenerator;
    this.clock = clock;
  }

  async createWithShipping(payload, { idempotencyKey } = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ValidationError('Request payload must be an object.');
    if (!this.shippingService) throw new DependencyError('Shipping service is not configured.');
    const deliveryAddress = this.normalizeDeliveryAddress(payload.deliveryAddress);
    const selected = await this.shippingService.select({ postalCode: deliveryAddress.postalCode,
      province: deliveryAddress.province, cart: payload.items }, payload.shippingMethodId);
    const quotedAt = this.clock().toISOString();
    const shipping = { provider: selected.provider, service: selected.name, carrier: selected.carrier,
      price: selected.price, estimatedHours: selected.estimatedHours, postalCode: deliveryAddress.postalCode,
      province: deliveryAddress.province, quotedAt };
    const fingerprintShipping = { deliveryAddress, shippingMethodId: payload.shippingMethodId };
    return this.create(payload, { idempotencyKey, shipping, deliveryAddress, fingerprintShipping });
  }

  create(payload, { idempotencyKey, shipping = null, deliveryAddress = null, fingerprintShipping = null } = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ValidationError('Request payload must be an object.');
    const { items, customer } = payload;
    if (!Array.isArray(items) || items.length === 0) throw new ValidationError('The order must contain at least one item.');
    if (items.length > 50) throw new ValidationError('The order cannot contain more than 50 items.');
    const normalizedCustomer = this.normalizeCustomer(customer);
    const resolvedItems = items.map(item => this.catalogService.resolveItem(item));
    const currencies = new Set(resolvedItems.map(item => this.catalogService.getById(item.productId).currency));
    if (currencies.size !== 1) throw new ValidationError('All order items must use the same currency.');
    const subtotal = resolvedItems.reduce((sum, item) => sum + item.lineTotal, 0);
    if (!Number.isSafeInteger(subtotal)) throw new ValidationError('Order amount exceeds the supported range.');

    const fingerprint = JSON.stringify({ items: resolvedItems, customer: normalizedCustomer, ...(fingerprintShipping ? { shipping: fingerprintShipping } : {}) });
    if (idempotencyKey) this.validateIdempotencyKey(idempotencyKey);

    const now = this.clock().toISOString();
    const order = {
      id: this.idGenerator(), publicOrderId: this.publicIdGenerator(), items: resolvedItems, subtotal,
      total: subtotal + (shipping ? Math.round(shipping.price) : 0),
      currency: [...currencies][0], customer: normalizedCustomer,
      ...(shipping ? { shipping, shippingStatus: 'selected', deliveryAddress } : {}),
      status: 'pending', paymentProvider: null, paymentId: null,
      createdAt: now, updatedAt: now, version: 1
    };
    if (!idempotencyKey) return this.orderRepository.save(order);
    return this.orderRepository.createWithIdempotency(order, { key: `checkout:${idempotencyKey}`, fingerprint }).then(result => result.order);
  }

  normalizeDeliveryAddress(address) {
    if (!address || typeof address !== 'object' || Array.isArray(address)) throw new ValidationError('Delivery address is required.');
    const street = requireString(address.street, 'delivery street', { max: 120 });
    const streetNumber = requireString(address.streetNumber, 'delivery street number', { max: 20 });
    const city = requireString(address.city, 'delivery city', { max: 100 });
    const province = requireString(address.province, 'delivery province', { max: 100 });
    const postalCode = requireString(address.postalCode, 'delivery postal code', { max: 4, pattern: /^\d{4}$/ });
    let apartmentFloor = '';
    if (address.apartmentFloor != null && address.apartmentFloor !== '') apartmentFloor = requireString(address.apartmentFloor, 'apartment/floor', { max: 60 });
    return { street, streetNumber, apartmentFloor, city, province, postalCode };
  }

  getById(id) { return this.orderRepository.findById(id); }

  async getPublicById(publicOrderId) {
    if (typeof publicOrderId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicOrderId)) return null;
    const order = await this.orderRepository.findByPublicOrderId(publicOrderId);
    if (!order) return null;
    return {
      publicOrderId: order.publicOrderId,
      items: order.items.map(item => ({
        name: item.name, quantity: item.quantity, unitPrice: item.unitPrice, lineTotal: item.lineTotal,
        ...(item.variantId ? { variantId: item.variantId } : {}), ...(item.color ? { color: item.color } : {})
      })),
      subtotal: order.subtotal,
      total: order.total,
      currency: order.currency,
      ...(order.shipping ? { shipping: order.shipping, shippingStatus: order.shippingStatus } : {}),
      status: order.status,
      createdAt: order.createdAt
    };
  }

  async transition(id, nextStatus, changes = {}) {
    if (!ORDER_STATUSES.includes(nextStatus)) throw new ValidationError('Unknown order status.');
    const current = await this.orderRepository.findById(id);
    if (!current) throw new NotFoundError('Order not found.');
    const updated = await this.orderRepository.update(id, current.version, order => {
      if (!ALLOWED_TRANSITIONS[order.status].includes(nextStatus)) throw new ConflictError(`Cannot transition order from ${order.status} to ${nextStatus}.`);
      return { ...order, ...changes, status: nextStatus, updatedAt: this.clock().toISOString() };
    });
    if (!updated) throw new NotFoundError('Order not found.');
    return updated;
  }

  async startPayment(orderId, { idempotencyKey, paymentData } = {}) {
    if (!this.paymentProvider) throw new DependencyError('Payment provider is not configured.');
    this.validateIdempotencyKey(idempotencyKey);
    const order = await this.getById(orderId);
    if (!order) throw new NotFoundError('Order not found.');
    const storageKey = `payment:${idempotencyKey}`;
    if (this.#paymentOperations.has(storageKey)) return this.#paymentOperations.get(storageKey);
    const operation = this.executePayment(order, storageKey, paymentData).finally(() => this.#paymentOperations.delete(storageKey));
    this.#paymentOperations.set(storageKey, operation);
    return operation;
  }

  async executePayment(order, storageKey, paymentData) {
    const claim = await this.orderRepository.beginPayment({ orderId: order.id, key: storageKey, fingerprint: order.id, provider: this.paymentProvider.name });
    if (!claim.created) {
      if (claim.completed) return claim.order;
      return claim.order;
    }
    try {
      const result = await this.paymentProvider.createPayment(claim.order, {
        paymentAttemptId: claim.attemptId, providerIdempotencyKey: claim.providerIdempotencyKey, paymentData
      });
      if (!result || !Object.hasOwn(PROVIDER_STATUS_TO_ORDER, result.status) || typeof result.paymentId !== 'string') {
        throw new DependencyError('Payment provider returned an invalid response.');
      }
      const targetStatus = PROVIDER_STATUS_TO_ORDER[result.status];
      if (!ALLOWED_TRANSITIONS[claim.order.status]?.includes(targetStatus)) throw new DependencyError('Payment provider returned an impossible initial status.');
      return this.orderRepository.completePayment({
        attemptId: claim.attemptId, orderId: order.id, status: result.status,
        orderStatus: targetStatus, provider: this.paymentProvider.name, providerPaymentId: result.paymentId
      });
    } catch (error) {
      if (error?.indeterminate) await this.orderRepository.markPaymentProcessing({ attemptId: claim.attemptId, orderId: order.id });
      else await this.orderRepository.failPayment({ attemptId: claim.attemptId, orderId: order.id });
      error.orderId = order.id; error.paymentAttemptId = claim.attemptId;
      if (error instanceof DependencyError) throw error;
      throw new DependencyError(error?.code === 'TIMEOUT' ? 'Payment provider timed out.' : 'Payment provider failed.');
    }
  }

  async reconcileProviderPayment(providerPaymentId) {
    if (!this.paymentProvider) throw new DependencyError('Payment provider is not configured.');
    const result = await this.paymentProvider.getPaymentStatus(String(providerPaymentId));
    if (!result || !Object.hasOwn(PROVIDER_STATUS_TO_ORDER, result.status)) throw new DependencyError('Payment provider returned an invalid status.');
    const attempt = await this.orderRepository.findPaymentAttempt({ provider: this.paymentProvider.name,
      providerPaymentId: result.paymentId, externalReference: result.externalReference });
    if (!attempt) return null;
    const target = PROVIDER_STATUS_TO_ORDER[result.status]; const current = attempt.order;
    if (current.status === target) return current;
    if (!ALLOWED_TRANSITIONS[current.status]?.includes(target)) return current;
    return this.orderRepository.reconcilePayment({ attemptId: attempt.id, expectedOrderVersion: current.version,
      expectedOrderStatus: current.status, providerPaymentId: result.paymentId, paymentStatus: result.status, orderStatus: target });
  }

  normalizeCustomer(customer) {
    if (!customer || typeof customer !== 'object' || Array.isArray(customer)) throw new ValidationError('Customer details are required.');
    const name = requireString(customer.name, 'customer name', { max: 100 });
    const email = requireString(customer.email, 'customer email', { max: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }).toLowerCase();
    let phone = '';
    if (customer.phone != null && customer.phone !== '') phone = requireString(customer.phone, 'customer phone', { max: 40, pattern: /^\+?[0-9 ()-]{6,40}$/ });
    return { name, email, phone };
  }

  validateIdempotencyKey(key) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ValidationError('A valid Idempotency-Key header is required.');
  }
}

export { ALLOWED_TRANSITIONS, ORDER_STATUSES };
