import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const opsDirectory = dirname(fileURLToPath(import.meta.url));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const orderIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function money(value, currency = 'ARS') {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency }).format(Number(value) || 0);
}

function dateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function layout(title, content) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} — LAIN OPS</title><link rel="stylesheet" href="/ops.css"></head>
    <body><main class="ops"><header><a href="/orders" class="brand">LAIN / OPS</a><span class="local">LOCAL ONLY</span></header>${content}</main></body></html>`;
}

function value(value) { return value == null || value === '' ? '—' : escapeHtml(value); }

function reviewRow(attempt) {
  return `<a class="order-row review-row" role="row" href="/orders/${encodeURIComponent(attempt.orderId)}"><span class="mono">${value(attempt.publicOrderId || attempt.orderId)}</span><span>${dateTime(attempt.updatedAt)}</span><span>${value(attempt.status)}</span><span>${value(attempt.providerOrderId)}</span><span>${value(attempt.providerPaymentId)}</span><span>${value(attempt.reconciliationLastError)} (${escapeHtml(attempt.reconciliationFailures || 0)})</span></a>`;
}

function ordersPage(orders, reviews = []) {
  const body = orders.length ? `<div class="orders-list" role="table">
    <div class="order-row order-head" role="row"><span>ID</span><span>CREATED</span><span>CUSTOMER</span><span>TOTAL</span><span>PAYMENT</span><span>SHIPPING</span></div>
    ${orders.map(order => `<a class="order-row" role="row" href="/orders/${encodeURIComponent(order.id)}"><span class="mono">${escapeHtml(order.id)}</span><span>${dateTime(order.createdAt)}</span><span>${value(order.customer?.name)}</span><span>${money(order.total, order.currency)}</span><span>${value(order.status)}</span><span>${value(order.shippingStatus)}</span></a>`).join('')}
    </div>` : '<p class="empty">NO ORDERS YET</p>';
  const review = reviews.length ? `<section><p class="eyebrow warning">MANUAL REVIEW</p><h2>Payments requiring review</h2><div class="orders-list" role="table">
    <div class="order-row review-row order-head" role="row"><span>ORDER</span><span>UPDATED</span><span>STATUS</span><span>MP ORDER ID</span><span>MP PAYMENT ID</span><span>LAST ERROR / FAILURES</span></div>
    ${reviews.map(reviewRow).join('')}</div></section>` : '<section><p class="eyebrow">PAYMENTS</p><p class="empty">NO PAYMENTS REQUIRE MANUAL REVIEW</p></section>';
  return layout('Orders', `<section><p class="eyebrow">ORDERS</p><h1>Orders</h1>${body}</section>${review}`);
}

function detailSection(title, rows) {
  return `<section class="detail-section"><h2>${escapeHtml(title)}</h2><dl>${rows.map(([label, entry]) => `<div><dt>${escapeHtml(label)}</dt><dd>${entry}</dd></div>`).join('')}</dl></section>`;
}

function paymentAttempts(attempts) {
  if (!attempts.length) return detailSection('PAYMENT ATTEMPTS', [['STATUS', value(null)]]);
  return `<section class="detail-section attempts"><h2>PAYMENT ATTEMPTS</h2><div class="items">${attempts.map(attempt => `<div class="attempt">
    <dl><div><dt>ATTEMPT ID</dt><dd class="mono">${value(attempt.id)}</dd></div><div><dt>STATUS</dt><dd>${value(attempt.status)}</dd></div>
    <div><dt>MP ORDER ID</dt><dd class="mono">${value(attempt.providerOrderId)}</dd></div><div><dt>MP PAYMENT ID</dt><dd class="mono">${value(attempt.providerPaymentId)}</dd></div>
    <div><dt>RECONCILIATION FAILURES</dt><dd>${escapeHtml(attempt.reconciliationFailures || 0)}</dd></div><div><dt>LAST ERROR</dt><dd>${value(attempt.reconciliationLastError)}</dd></div>
    <div><dt>MANUAL REVIEW</dt><dd>${attempt.reconciliationNeedsReview ? 'YES' : 'NO'}</dd></div><div><dt>UPDATED</dt><dd>${dateTime(attempt.updatedAt)}</dd></div></dl></div>`).join('')}</div></section>`;
}

function orderPage(order, attempts = []) {
  const address = order.deliveryAddress || {};
  const shipping = order.shipping || {};
  const items = order.items || [];
  const content = `<a class="back" href="/orders">← ORDERS</a><p class="eyebrow">ORDER</p><h1 class="mono">${escapeHtml(order.id)}</h1>
    ${detailSection('ORDER', [['ID', value(order.id)], ['CREATED AT', dateTime(order.createdAt)], ['STATUS', value(order.status)]])}
    ${detailSection('CUSTOMER', [['NAME', value(order.customer?.name)], ['EMAIL', value(order.customer?.email)], ['PHONE', value(order.customer?.phone)]])}
    <section class="detail-section"><h2>ITEMS</h2><div class="items">${items.map(item => `<div class="item"><span>${value(item.name)}</span><span>${value(item.variantId)}</span><span>× ${escapeHtml(item.quantity)}</span><span>${money(item.unitPrice, order.currency)}</span><strong>${money(item.lineTotal, order.currency)}</strong></div>`).join('') || '<p>—</p>'}</div></section>
    ${detailSection('DELIVERY', [['MODE', value(order.deliveryMode)], ['STREET', value(address.street)], ['NUMBER', value(address.streetNumber)], ['APARTMENT / FLOOR', value(address.apartmentFloor)], ['LOCALITY', value(address.city)], ['PROVINCE', value(address.province)], ['POSTAL CODE', value(address.postalCode)]])}
    ${detailSection('SHIPPING', [['PROVIDER', value(shipping.provider)], ['CARRIER', value(shipping.carrier)], ['SERVICE', value(shipping.service)], ['PRICE', money(shipping.price, order.currency)], ['ESTIMATED HOURS', value(shipping.estimatedHours)], ['SHIPPING STATUS', value(order.shippingStatus)]])}
    ${detailSection('PAYMENT', [['PAYMENT STATUS', value(order.status)], ['PROVIDER', value(order.paymentProvider)], ['PROVIDER ORDER ID', value(order.providerOrderId)], ['PROVIDER PAYMENT ID', value(order.paymentId)]])}
    ${paymentAttempts(attempts)}`;
  return layout(`Order ${order.id}`, content);
}

export function createOpsApp({ orderRepository, logger = console } = {}) {
  if (!orderRepository) throw new TypeError('Order repository is required.');
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    if (!['GET', 'HEAD'].includes(request.method)) return response.status(405).type('text').send('Read only.');
    next();
  });
  app.get('/ops.css', (_request, response) => response.sendFile(resolve(opsDirectory, 'ops.css')));
  app.get('/', (_request, response) => response.redirect('/orders'));
  app.get('/orders', async (_request, response, next) => {
    try { const orders = await orderRepository.listRecent({ limit: 100 });
      const reviews = await orderRepository.listPaymentAttemptsNeedingReview({ limit: 100 });
      response.type('html').send(ordersPage(orders, reviews)); }
    catch (error) { next(error); }
  });
  app.get('/orders/:id', async (request, response, next) => {
    try {
      if (!orderIdPattern.test(request.params.id)) return response.status(404).type('html').send(layout('Not found', '<p class="empty">ORDER NOT FOUND</p>'));
      const order = await orderRepository.findById(request.params.id);
      if (!order) return response.status(404).type('html').send(layout('Not found', '<p class="empty">ORDER NOT FOUND</p>'));
      const attempts = await orderRepository.listPaymentAttemptsForOrder(order.id);
      response.type('html').send(orderPage(order, attempts));
    } catch (error) { next(error); }
  });
  app.use((_request, response) => response.status(404).type('html').send(layout('Not found', '<p class="empty">NOT FOUND</p>')));
  app.use((error, request, response, _next) => {
    logger.error('LAIN Ops request failed', { method: request.method, path: request.path, error: error.name, code: error.code || 'OPS_ERROR' });
    response.status(500).type('html').send(layout('Error', '<p class="empty">OPS UNAVAILABLE</p>'));
  });
  return app;
}
