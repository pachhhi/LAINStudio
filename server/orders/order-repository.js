import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../errors.js';
import { OrderRepository } from './order-repository-contract.js';

export class InMemoryOrderRepository extends OrderRepository {
  #orders = new Map();
  #idempotency = new Map();
  #paymentAttempts = new Map();
  constructor() { super(); }
  save(order) {
    if (this.#orders.has(order.id)) throw new Error(`Order ${order.id} already exists.`);
    if (order.publicOrderId && [...this.#orders.values()].some(value => value.publicOrderId === order.publicOrderId)) throw new Error(`Public order ${order.publicOrderId} already exists.`);
    this.#orders.set(order.id, structuredClone(order)); return structuredClone(order);
  }
  findById(id) { const order = this.#orders.get(id); return order ? structuredClone(order) : null; }
  findByPublicOrderId(publicOrderId) {
    const order = [...this.#orders.values()].find(value => value.publicOrderId === publicOrderId);
    return order ? structuredClone(order) : null;
  }
  listRecent({ limit = 100 } = {}) {
    return [...this.#orders.values()].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, limit).map(order => structuredClone(order));
  }
  update(id, expectedVersion, updater) {
    const current = this.#orders.get(id);
    if (!current) return null;
    if (current.version !== expectedVersion) throw new ConflictError('Order was modified concurrently.');
    const next = updater(structuredClone(current));
    next.version = current.version + 1;
    this.#orders.set(id, structuredClone(next));
    return structuredClone(next);
  }
  reserveIdempotency(key, fingerprint) {
    const existing = this.#idempotency.get(key);
    if (existing) return existing.fingerprint === fingerprint ? { created: false, record: { ...existing, value: structuredClone(existing.value) } } : { conflict: true };
    const record = { fingerprint, state: 'in_progress', value: null, promise: null };
    this.#idempotency.set(key, record);
    return { created: true };
  }
  attachIdempotencyPromise(key, promise) { const record = this.#idempotency.get(key); if (record) record.promise = promise; }
  completeIdempotency(key, value) {
    const record = this.#idempotency.get(key);
    if (record) { record.state = 'completed'; record.value = structuredClone(value); record.promise = null; }
  }
  failIdempotency(key) { const record = this.#idempotency.get(key); if (record) { record.state = 'failed'; record.promise = null; } }
  releaseIdempotency(key) { this.#idempotency.delete(key); }
  count() { return this.#orders.size; }

  async createWithIdempotency(order, { key, fingerprint }) {
    const reservation = this.reserveIdempotency(key, fingerprint);
    if (reservation.conflict) throw new ConflictError('Idempotency key was already used with a different payload.');
    if (!reservation.created) return { order: structuredClone(reservation.record.value), created: false };
    try { const saved = this.save(order); this.completeIdempotency(key, saved); return { order: saved, created: true }; }
    catch (error) { this.releaseIdempotency(key); throw error; }
  }

  async beginPayment({ orderId, key, fingerprint, provider }) {
    const reservation = this.reserveIdempotency(key, fingerprint);
    if (reservation.conflict) throw new ConflictError('Idempotency key was already used for another payment.');
    if (!reservation.created) return { created: false, completed: reservation.record.state === 'completed',
      order: structuredClone(reservation.record.value || this.#orders.get(fingerprint)) };
    const order = this.#orders.get(orderId);
    if (!order) { this.releaseIdempotency(key); throw new NotFoundError('Order not found.'); }
    if (!['pending', 'failed'].includes(order.status)) { this.releaseIdempotency(key); throw new ConflictError(`Cannot start payment from ${order.status}.`); }
    const attemptId = randomUUID(); const now = new Date().toISOString();
    this.#paymentAttempts.set(attemptId, { id: attemptId, orderId, provider, providerPaymentId: null, providerIdempotencyKey: attemptId, idempotencyKey: key, status: 'created', requestFingerprint: fingerprint, createdAt: now, updatedAt: now });
    const next = { ...order, status: 'awaiting_payment', updatedAt: now, version: order.version + 1 };
    this.#orders.set(orderId, structuredClone(next));
    return { created: true, attemptId, providerIdempotencyKey: attemptId, order: structuredClone(next) };
  }

  async completePayment({ attemptId, orderId, status, orderStatus, providerPaymentId, provider }) {
    const attempt = this.#paymentAttempts.get(attemptId);
    if (!attempt) throw new NotFoundError('Payment attempt not found.');
    const order = this.#orders.get(orderId);
    if (order?.status !== 'awaiting_payment') throw new ConflictError(`Cannot complete payment from ${order?.status || 'missing order'}.`);
    const now = new Date().toISOString(); Object.assign(attempt, { status, providerPaymentId, updatedAt: now });
    const next = { ...order, status: orderStatus, paymentProvider: provider, paymentId: providerPaymentId, updatedAt: now, version: order.version + 1 };
    this.#orders.set(orderId, structuredClone(next)); this.completeIdempotency(attempt.idempotencyKey, next); return structuredClone(next);
  }

  async failPayment({ attemptId, orderId }) {
    const attempt = this.#paymentAttempts.get(attemptId); const now = new Date().toISOString();
    if (attempt) { attempt.status = 'failed'; attempt.updatedAt = now; this.failIdempotency(attempt.idempotencyKey); }
    const order = this.#orders.get(orderId);
    if (order?.status === 'awaiting_payment') { order.status = 'failed'; order.updatedAt = now; order.version += 1; }
    return order ? structuredClone(order) : null;
  }

  async markPaymentProcessing({ attemptId, orderId }) {
    const attempt = this.#paymentAttempts.get(attemptId); const order = this.#orders.get(orderId); const now = new Date().toISOString();
    if (attempt) { attempt.status = 'processing'; attempt.updatedAt = now; }
    if (order?.status === 'awaiting_payment') { order.status = 'processing'; order.updatedAt = now; order.version += 1; }
    return order ? structuredClone(order) : null;
  }

  async findPaymentAttempt({ provider, providerPaymentId, externalReference }) {
    const value = [...this.#paymentAttempts.values()].find(attempt => attempt.provider === provider
      && ((providerPaymentId && attempt.providerPaymentId === providerPaymentId) || (externalReference && attempt.id === externalReference)));
    if (!value) return null;
    return { ...structuredClone(value), order: structuredClone(this.#orders.get(value.orderId)) };
  }

  async reconcilePayment({ attemptId, expectedOrderVersion, expectedOrderStatus, providerPaymentId, paymentStatus, orderStatus }) {
    const attempt = this.#paymentAttempts.get(attemptId); const order = this.#orders.get(attempt?.orderId);
    if (!attempt || !order) return null;
    if (order.version !== expectedOrderVersion || order.status !== expectedOrderStatus) throw new ConflictError('Order was modified concurrently.');
    const now = new Date().toISOString(); Object.assign(attempt, { providerPaymentId, status: paymentStatus, updatedAt: now });
    Object.assign(order, { status: orderStatus, paymentProvider: attempt.provider, paymentId: providerPaymentId, updatedAt: now, version: order.version + 1 });
    this.completeIdempotency(attempt.idempotencyKey, order);
    return structuredClone(order);
  }
}
