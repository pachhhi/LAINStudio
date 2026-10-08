import { formatPrice } from './commerce.js';
import { getPublicOrder } from './checkout-api.js';
import { resolveLanguage, translate } from './i18n.js';

const root = document.querySelector('#order-root');
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const publicOrderId = new URLSearchParams(window.location.search).get('id') || '';
const validPublicOrderId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicOrderId);
const language = resolveLanguage();
const t = key => translate(language, key);

const statusCopy = {
  pending: [t('orderCreated'), t('orderPending')], awaiting_payment: [t('orderCreated'), t('orderAwaiting')],
  processing: [t('paymentProcessing'), t('orderProcessing')], paid: [t('paymentApproved'), t('orderPaid')],
  failed: [t('paymentNotApproved'), t('orderFailed')], cancelled: [t('orderCancelledLabel'), t('orderCancelled')],
  partially_refunded: [t('paymentPartiallyRefunded'), t('orderPartiallyRefunded')], refunded: [t('paymentRefunded'), t('orderRefunded')],
  chargeback: [t('paymentChargeback'), t('orderChargeback')]
};

function renderError(title, message) {
  root.setAttribute('aria-busy', 'false');
  root.innerHTML = `<section class="checkout-empty"><span>LAIN / ORDER</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="back-link" href="/#store">${t('returnStore')}</a></section>`;
}

function renderUnconfirmedOrder(order) {
  const copy = statusCopy[order.status] || [t('orderCreated'), t('orderPending')];
  root.setAttribute('aria-busy', 'false');
  root.innerHTML = `<section class="checkout-empty order-unconfirmed">
    <span>${copy[0]}</span><h1>${t('paymentNotConfirmed')}</h1><p>${copy[1]}</p>
    <dl><div><dt>${t('publicOrderId')}</dt><dd>${escapeHtml(order.publicOrderId)}</dd></div><div><dt>${t('status')}</dt><dd>${escapeHtml(order.status)}</dd></div></dl>
    <a class="back-link" href="/#store">${t('returnStore')}</a>
  </section>`;
}

function renderOrder(order) {
  root.setAttribute('aria-busy', 'false');
  root.innerHTML = `<section class="checkout-success order-confirmation">
    <span>${t('paymentApproved')}</span><h1>${t('orderReceived')}</h1><p>${t('orderPaid')}</p>
    <dl><div><dt>${t('publicOrderId')}</dt><dd>${escapeHtml(order.publicOrderId)}</dd></div><div><dt>${t('status')}</dt><dd>${escapeHtml(order.status)}</dd></div></dl>
    <section class="order-summary" aria-labelledby="order-items-title"><h2 id="order-items-title">${t('items')}</h2>
      ${order.items.map(item => `<article class="summary-item"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml([item.variantId, item.color].filter(Boolean).join(' / '))}</p><span>${t('qty')} ${item.quantity}</span></div><strong>${formatPrice(item.lineTotal, order.currency)}</strong></article>`).join('')}
      <div class="summary-total"><span>${t('subtotal')}</span><strong>${formatPrice(order.subtotal, order.currency)}</strong></div>
      ${order.shipping ? `<div class="summary-total"><span>${t('shipping')} — ${escapeHtml(order.shipping.carrier)} / ${escapeHtml(order.shipping.service)}</span><strong>${formatPrice(order.shipping.price, order.currency)}</strong></div>` : ''}
      <div class="summary-total"><span>${t('total')}</span><strong>${formatPrice(order.total, order.currency)}</strong></div>
    </section>
    ${order.shipping ? `<dl><div><dt>${t('shippingStatus')}</dt><dd>${escapeHtml(order.shippingStatus)}</dd></div></dl>` : ''}
    <p class="order-next-step"><strong>${t('nextStep')}</strong><br>${t('nextStepCopy')}</p>
    <a href="/#store">${t('returnStore')}</a>
  </section>`;
}

async function loadOrder() {
  if (!validPublicOrderId) return renderError(t('invalidOrder'), t('invalidOrderCopy'));
  try {
    const order = await getPublicOrder(publicOrderId);
    if (order.status !== 'paid') return renderUnconfirmedOrder(order);
    renderOrder(order);
  }
  catch (error) { renderError(t('orderLoadError'), error.message); }
}

loadOrder();
