import { products } from './products.js';
import { formatPrice } from './commerce.js';
import { CartStore } from './cart-store.js';
import { CartService } from './cart-service.js';
import { createCheckout, createHostedCheckout, createPayment, getPaymentConfig, getPublicOrder, getShippingQuotes, orderConfirmationUrl } from './checkout-api.js';
import { canSubmitCheckout, createSubmitGuard, normalizeShippingPrice, resolveDeliverySelection } from './checkout-submit.js';
import { CheckoutAttemptStore } from './checkout-attempt.js';
import { resolveLanguage, translate } from './i18n.js';

const root = document.querySelector('#checkout-root');
const cart = new CartService({ catalog: products, store: new CartStore() });
const language = resolveLanguage();
const t = key => translate(language, key);
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const images = product => Array.isArray(product.images) ? product.images : Object.values(product.images || {});
const attemptStore = new CheckoutAttemptStore();
let checkoutAttempt;
let paymentBrickController = null;
let paymentBrickSignature = '';
let paymentBrickGeneration = 0;
let paymentBrickTimer = null;
let paymentConfigPromise = null;
const logPayment = (event, details = {}) => console.info(`[LAIN checkout] ${event}`, details);
const guardedCheckout = createSubmitGuard((items, customer, delivery) => createCheckout(items, customer, { ...delivery, idempotencyKey: checkoutAttempt.checkoutKey }));
const guardedIntegratedPayment = createSubmitGuard(processIntegratedPayment);
const guardedHostedPayment = createSubmitGuard(processHostedPayment);
let shippingPrice = null;
let checkoutHasPendingPrice = false;
let shippingRequest = 0;
const provinces = ['Buenos Aires', 'Ciudad Autónoma de Buenos Aires', 'Catamarca', 'Chaco', 'Chubut', 'Córdoba', 'Corrientes', 'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja', 'Mendoza', 'Misiones', 'Neuquén', 'Río Negro', 'Salta', 'San Juan', 'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero', 'Tierra del Fuego', 'Tucumán'];
const enviopackChoice = (currency, checked = false) => `<label class="shipping-method"><input type="radio" name="shippingSelection" value="enviopack" data-enviopack-intent${checked ? ' checked' : ''}><span><strong>${t('enviopackDelivery')}</strong><small>${t('enviopackDeliveryCopy')}</small></span><b>—</b></label>`;

function render() {
  const items = cart.getItems();
  if (!items.length) {
    root.innerHTML = `<a class="back-link" href="/#store">${t('backToCollection')}</a><section class="checkout-empty"><span>LAIN / CHECKOUT</span><h1>${t('emptyCheckout')}</h1><p>${t('emptyCheckoutCopy')}</p></section>`;
    return;
  }
  checkoutAttempt = attemptStore.load(items);
  if (checkoutAttempt.order) {
    renderPayment(checkoutAttempt.order);
    return;
  }
  const resolved = items.map(item => ({ ...item, product: products.find(product => product.id === item.productId) }));
  const hasPendingPrice = resolved.some(item => item.product.price == null);
  checkoutHasPendingPrice = hasPendingPrice;
  shippingPrice = null;
  const subtotal = hasPendingPrice ? null : resolved.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  const currency = resolved[0].product.currency;
  root.innerHTML = `
    <a class="back-link" href="/#store">${t('backToStore')}</a>
    <div class="checkout-header"><span>LAIN / CHECKOUT</span><h1>${t('prepareOrder')}</h1><p>${t('validateNotice')}</p></div>
    <div class="checkout-layout">
      <section class="order-summary" aria-labelledby="summary-title"><h2 id="summary-title">${t('orderSummary')}</h2>
        ${resolved.map(item => `<article class="summary-item"><img src="${escapeHtml(images(item.product)[0])}" alt=""><div><h3>${escapeHtml(item.product.name)}</h3><p>${escapeHtml([item.variantId, item.color].filter(Boolean).join(' / '))}</p><span>${t('qty')} ${item.quantity}</span></div><strong>${formatPrice(item.product.price == null ? null : item.product.price * item.quantity, item.product.currency)}</strong></article>`).join('')}
        <div class="summary-total"><span>${t('subtotal')}</span><strong>${formatPrice(subtotal, currency)}</strong></div>
        <div class="summary-total"><span>${t('shipping')}</span><strong id="shipping-total">—</strong></div>
        <div class="summary-total"><span>${t('total')}</span><strong id="checkout-total">${formatPrice(subtotal, currency)}</strong></div>
      </section>
      <div id="checkout-form" class="customer-form">
        <h2>${t('buyerInformation')}</h2>
        <label>${t('name')}<input name="name" autocomplete="name" required maxlength="100"></label>
        <label>EMAIL<input name="email" type="email" autocomplete="email" required maxlength="150"></label>
        <label>${t('phoneOptional')}<input name="phone" type="tel" autocomplete="tel" maxlength="40"></label>
        <fieldset id="shipping-method-options" class="shipping-methods"><legend>${t('shippingMethod')}</legend>
          <label class="shipping-method"><input type="radio" name="shippingSelection" value="coordinate" data-pickup><span><strong>${t('coordinateDelivery')}</strong><small>${t('coordinateDeliveryCopy')}</small></span><b>${formatPrice(0, currency)}</b></label>
          <div id="shipping-methods" aria-live="polite">${enviopackChoice(currency)}</div>
        </fieldset>
        <fieldset id="delivery-address" class="delivery-address" hidden><legend>${t('deliveryAddress')}</legend>
          <div class="shipping-address-fields delivery-street">
            <label>${t('street')}<input name="street" autocomplete="address-line1" required maxlength="120" disabled></label>
            <label>${t('streetNumber')}<input name="streetNumber" autocomplete="address-line2" required maxlength="20" disabled></label>
          </div>
          <label>${t('apartmentFloor')} <span>${t('optional')}</span><input name="apartmentFloor" autocomplete="address-line3" maxlength="60" disabled></label>
          <label>${t('city')}<input name="city" autocomplete="address-level2" required maxlength="100" disabled></label>
          <div class="shipping-address-fields">
          <label>${t('province')}<select name="province" autocomplete="address-level1" required disabled><option value="">${t('selectProvince')}</option>${provinces.map(province => `<option>${province}</option>`).join('')}</select></label>
          <label>${t('postalCode')}<input name="postalCode" inputmode="numeric" autocomplete="postal-code" required maxlength="4" pattern="[0-9]{4}" disabled></label>
          </div>
        </fieldset>
        <fieldset class="shipping-methods" aria-labelledby="payment-title">
          <legend id="payment-title">${t('payment')}</legend>
          <label class="shipping-method"><input type="radio" name="paymentFlow" value="card"${checkoutAttempt.paymentFlow !== 'checkout_pro' ? ' checked' : ''}><span><strong>${t('creditCard')}</strong><small>${t('creditCardCopy')}</small></span></label>
          <label class="shipping-method"><input type="radio" name="paymentFlow" value="checkout_pro"${checkoutAttempt.paymentFlow === 'checkout_pro' ? ' checked' : ''}><span><strong>${t('payWithMercadoPago')}</strong><small>${t('payWithMercadoPagoCopy')}</small></span></label>
          <div id="cardPaymentBrick_container" aria-live="polite"></div>
          <button id="checkout-pro-button" type="button" hidden>${t('payWithMercadoPago')}</button>
          <p id="payment-status" class="checkout-status" role="status"></p>
        </fieldset>
      </div>
    </div>`;
  const form = root.querySelector('#checkout-form');
  let quoteTimer;
  const scheduleQuote = () => { clearTimeout(quoteTimer); quoteTimer = setTimeout(() => updateShipping(form, subtotal, currency), 300); };
  form.querySelector('[name="province"]').addEventListener('change', scheduleQuote);
  form.querySelector('[name="postalCode"]').addEventListener('input', scheduleQuote);
  form.querySelector('#shipping-method-options').addEventListener('change', event => {
    if (!event.target.matches('input[name="shippingSelection"]') || !event.target.checked) return;
    const address = form.querySelector('#delivery-address');
    const pickup = event.target.matches('[data-pickup]');
    if (pickup) shippingRequest += 1;
    checkoutAttempt = attemptStore.rotateCheckoutKey(checkoutAttempt, pickup ? 'coordinate' : 'home_delivery');
    shippingPrice = pickup ? 0 : (event.target.matches('[data-enviopack]') ? normalizeShippingPrice(event.target.dataset.price) : null);
    address.hidden = pickup;
    address.querySelectorAll('input, select').forEach(field => { field.disabled = pickup; });
    updateTotals(subtotal, currency);
    updateCreateButton(form);
    schedulePaymentBrick(form, subtotal, currency);
  });
  form.querySelectorAll('input[name="paymentFlow"]').forEach(input => input.addEventListener('change', async event => {
    if (!event.target.checked || checkoutAttempt.order) return;
    checkoutAttempt = attemptStore.selectPaymentFlow(checkoutAttempt, event.target.value);
    await syncPaymentMethod(form, subtotal, currency);
  }));
  form.querySelector('#checkout-pro-button').addEventListener('click', () => guardedHostedPayment({ form }));
  form.addEventListener('input', () => { updateCreateButton(form); schedulePaymentBrick(form, subtotal, currency); });
  form.addEventListener('change', () => { updateCreateButton(form); schedulePaymentBrick(form, subtotal, currency); });
}

async function updateShipping(form, subtotal, currency) {
  if (form.querySelector('[data-pickup]:checked')) return;
  const province = form.querySelector('[name="province"]').value;
  const postalCode = form.querySelector('[name="postalCode"]').value.trim();
  const container = form.querySelector('#shipping-methods');
  shippingPrice = null;
  updateTotals(subtotal, currency);
  updateCreateButton(form);
  if (!province || !/^\d{4}$/.test(postalCode)) {
    container.innerHTML = `${enviopackChoice(currency, true)}<p class="form-note">${t('enterPostalCode')}</p>`;
    return;
  }
  const requestId = ++shippingRequest;
  container.innerHTML = `${enviopackChoice(currency, true)}<p class="form-note">${t('calculatingShipping')}</p>`;
  try {
    const result = await getShippingQuotes(postalCode, province, cart.getItems());
    if (requestId !== shippingRequest) return;
    if (!result.available) {
      container.innerHTML = `${enviopackChoice(currency, true)}<p class="form-note">${t('shippingUnavailable')}</p>`;
      return;
    }
    if (!result.methods.length) {
      container.innerHTML = `${enviopackChoice(currency, true)}<p class="form-note">${t('noShippingMethods')}</p>`;
      return;
    }
    container.innerHTML = result.methods.map((method, index) => { const price = normalizeShippingPrice(method.price); return `<label class="shipping-method"><input type="radio" name="shippingSelection" value="${escapeHtml(method.id)}" data-price="${price}" data-enviopack${index === 0 ? ' checked' : ''}><span><strong>${escapeHtml(method.carrier)} / ${escapeHtml(method.name)}</strong>${method.estimatedHours == null ? '' : `<small>${escapeHtml(t('upToHours').replace('{hours}', method.estimatedHours))}</small>`}</span><b>${formatPrice(price, currency)}</b></label>`; }).join('');
    shippingPrice = normalizeShippingPrice(result.methods[0].price);
    checkoutAttempt = attemptStore.rotateCheckoutKey(checkoutAttempt, 'home_delivery');
    updateTotals(subtotal, currency); updateCreateButton(form); schedulePaymentBrick(form, subtotal, currency);
  } catch (error) {
    const errorKeys = { shipping_auth_failed: 'shippingUnavailable', shipping_quote_failed: 'shippingRetry',
      shipping_invalid_provider_response: 'shippingInvalidResponse', shipping_product_missing_dimensions: 'shippingMissingDimensions',
      shipping_invalid_destination: 'shippingInvalidDestination', shipping_connection_failed: 'shippingConnectionError' };
    if (requestId === shippingRequest) container.innerHTML = `${enviopackChoice(currency, true)}<p class="form-note">${escapeHtml(errorKeys[error.code] ? t(errorKeys[error.code]) : error.message)}</p>`;
  }
}

function updateCreateButton(form) {
  const selectedShipping = form.querySelector('input[name="shippingSelection"]:checked');
  const delivery = resolveDeliverySelection({ pickupSelected: selectedShipping?.matches('[data-pickup]') === true,
    shippingMethodId: selectedShipping?.matches('[data-enviopack]') === true ? selectedShipping.value : null });
  return canSubmitCheckout({ hasPendingPrice: checkoutHasPendingPrice, deliveryMode: delivery.deliveryMode,
    selectedShippingMethodId: delivery.shippingMethodId, formValid: [...form.querySelectorAll('input, select')]
      .filter(field => !field.disabled).every(field => field.checkValidity()) });
}

function updateTotals(subtotal, currency) {
  root.querySelector('#shipping-total').textContent = shippingPrice == null ? '—' : formatPrice(shippingPrice, currency);
  root.querySelector('#checkout-total').textContent = formatPrice(subtotal == null ? null : subtotal + (shippingPrice || 0), currency);
}

function checkoutData(form) {
  const formData = new FormData();
  form.querySelectorAll('input[name], select[name]').forEach(field => { if (!field.disabled && (field.type !== 'radio' || field.checked)) formData.set(field.name, field.value); });
  const selectedShipping = form.querySelector('input[name="shippingSelection"]:checked');
  const delivery = resolveDeliverySelection({ pickupSelected: selectedShipping?.matches('[data-pickup]') === true,
    shippingMethodId: selectedShipping?.matches('[data-enviopack]') === true ? selectedShipping.value : null });
  const customer = { name: formData.get('name'), email: formData.get('email'), phone: formData.get('phone') };
  const deliveryAddress = delivery.deliveryMode === 'home_delivery' ? { street: formData.get('street'), streetNumber: formData.get('streetNumber'),
    apartmentFloor: formData.get('apartmentFloor'), city: formData.get('city'), province: formData.get('province'), postalCode: formData.get('postalCode') } : null;
  return { customer, delivery: { ...delivery, deliveryAddress } };
}

async function unmountPaymentBrick() {
  paymentBrickGeneration += 1;
  paymentBrickSignature = '';
  if (!paymentBrickController) return;
  const controller = paymentBrickController;
  paymentBrickController = null;
  await Promise.resolve(controller.unmount()).catch(() => {});
}

function schedulePaymentBrick(form, subtotal, currency) {
  clearTimeout(paymentBrickTimer);
  paymentBrickTimer = setTimeout(() => syncPaymentMethod(form, subtotal, currency), 250);
}

async function syncPaymentMethod(form, subtotal, currency) {
  const hosted = checkoutAttempt.paymentFlow === 'checkout_pro';
  const button = form.querySelector('#checkout-pro-button');
  const container = form.querySelector('#cardPaymentBrick_container');
  button.hidden = !hosted;
  container.hidden = hosted;
  button.disabled = hosted && !updateCreateButton(form);
  if (hosted) { await unmountPaymentBrick(); return; }
  return syncPaymentBrick(form, subtotal, currency);
}

async function syncPaymentBrick(form, subtotal, currency, authoritativeAmount = null) {
  const status = form.querySelector('#payment-status');
  if (!updateCreateButton(form)) {
    await unmountPaymentBrick();
    status.textContent = '';
    return;
  }
  const { customer } = checkoutData(form);
  const amount = authoritativeAmount ?? subtotal + shippingPrice;
  const signature = JSON.stringify({ amount, email: customer.email });
  if (paymentBrickController && paymentBrickSignature === signature) return;
  await unmountPaymentBrick();
  const generation = paymentBrickGeneration;
  try {
    paymentConfigPromise ||= getPaymentConfig();
    const config = await paymentConfigPromise;
    if (generation !== paymentBrickGeneration) return;
    if (typeof window.MercadoPago !== 'function') throw new Error(t('paymentSdkUnavailable'));
    logPayment('Mercado Pago SDK loaded', { loaded: true });
    logPayment('payment config loaded', { provider: config.provider, environment: config.environment, publicKeyAvailable: Boolean(config.publicKey) });
    const mercadoPago = new window.MercadoPago(config.publicKey, { locale: language === 'es' ? 'es-AR' : 'en-US' });
    const controller = await mercadoPago.bricks().create('cardPayment', 'cardPaymentBrick_container', {
      initialization: { amount, payer: { email: customer.email } },
      customization: { visual: { style: { theme: 'dark', customVariables: { baseColor: '#75ff38', formBackgroundColor: '#0c0b0b', inputBackgroundColor: '#151515', formHorizontalPadding: '0px' } }, texts: { formSubmit: `${t('payNow')} — ${formatPrice(amount, currency)}` } } },
      callbacks: {
        onReady: () => { status.textContent = ''; },
        onSubmit: cardData => guardedIntegratedPayment(cardData, { form, subtotal, currency, mountedAmount: amount }),
        onError: error => {
          logPayment('Card Payment Brick error', { type: error?.type || 'unknown', message: error?.message || 'unknown' });
          status.textContent = t('paymentFormError');
        }
      }
    });
    if (generation !== paymentBrickGeneration) return Promise.resolve(controller.unmount()).catch(() => {});
    paymentBrickController = controller;
    paymentBrickSignature = signature;
    logPayment('Card Payment Brick created', { amount, currency });
  } catch (error) {
    if (generation !== paymentBrickGeneration) return;
    logPayment('payment step error', { message: error.message });
    status.textContent = error.message;
  }
}

async function processIntegratedPayment(cardData, { form, subtotal, currency, mountedAmount }) {
  const status = form.querySelector('#payment-status');
  status.textContent = t('creatingOrder');
  try {
    let order = checkoutAttempt.order;
    if (!order) {
      const { customer, delivery } = checkoutData(form);
      order = await guardedCheckout(cart.getItems(), customer, delivery);
      logPayment('order created or recovered', { publicOrderId: order.publicOrderId, status: order.status, total: order.total, currency: order.currency });
      checkoutAttempt = attemptStore.attachOrder(checkoutAttempt, { id: order.id, publicOrderId: order.publicOrderId,
        total: order.total, currency: order.currency, status: order.status, customer: { email: customer.email } });
    }
    if (order.total !== mountedAmount) {
      status.textContent = t('paymentAmountChanged');
      setTimeout(() => syncPaymentBrick(form, subtotal, currency, order.total), 0);
      return;
    }
    form.querySelectorAll('input[name], select[name]').forEach(field => { field.disabled = true; });
    status.textContent = t('processingPayment');
    logPayment('sending tokenized payment', { publicOrderId: order.publicOrderId });
    const updated = await createPayment(order.id, cardData, { idempotencyKey: checkoutAttempt.paymentKey });
    logPayment('payment response received', { publicOrderId: updated.publicOrderId, status: updated.status });
    if (['paid', 'processing', 'awaiting_payment'].includes(updated.status)) return finishPayment(updated);
    if (updated.status === 'failed') {
      checkoutAttempt = attemptStore.rotatePaymentKey(checkoutAttempt);
      status.textContent = t('paymentRejectedRetry');
      return;
    }
    if (updated.status === 'cancelled') { status.textContent = t('orderCancelled'); return; }
    status.textContent = t('paymentStatusUnknown');
  } catch (error) {
    const order = checkoutAttempt.order;
    const recovered = order ? await recoverPaymentStatus(order) : null;
    if (recovered && ['paid', 'processing', 'awaiting_payment'].includes(recovered.status)) return finishPayment(recovered);
    if (recovered?.status === 'failed') checkoutAttempt = attemptStore.rotatePaymentKey(checkoutAttempt);
    if (recovered?.status === 'cancelled') { status.textContent = t('orderCancelled'); return; }
    status.textContent = error.statusDetail ? `Payment rejected: ${error.statusDetail}`
      : (recovered?.status === 'failed' ? t('paymentRejectedRetry') : error.message);
  }
}

async function processHostedPayment({ form = null, existingOrder = null }) {
  const scope = form || root;
  const status = scope.querySelector('#payment-status');
  const button = scope.querySelector('#checkout-pro-button');
  if (form && !updateCreateButton(form)) return;
  button.disabled = true;
  status.textContent = t('creatingOrder');
  try {
    let order = existingOrder || checkoutAttempt.order;
    if (!order) {
      const { customer, delivery } = checkoutData(form);
      order = await guardedCheckout(cart.getItems(), customer, delivery);
      checkoutAttempt = attemptStore.attachOrder(checkoutAttempt, { id: order.id, publicOrderId: order.publicOrderId,
        total: order.total, currency: order.currency, status: order.status });
      logPayment('order created or recovered', { publicOrderId: order.publicOrderId, status: order.status, total: order.total, currency: order.currency });
    }
    form?.querySelectorAll('input[name], select[name]').forEach(field => { field.disabled = true; });
    status.textContent = t('redirectingToMercadoPago');
    const hosted = await createHostedCheckout(order.id, { idempotencyKey: checkoutAttempt.paymentKey });
    logPayment('hosted checkout created or recovered', { publicOrderId: hosted.order.publicOrderId, status: hosted.order.status });
    window.location.assign(hosted.checkoutUrl);
  } catch (error) {
    const order = checkoutAttempt.order;
    const recovered = order ? await recoverPaymentStatus(order) : null;
    if (recovered?.status === 'paid') return finishPayment(recovered);
    status.textContent = recovered && ['processing', 'awaiting_payment'].includes(recovered.status)
      ? t('hostedPaymentPending') : error.message;
    if (!recovered || recovered.status === 'failed') button.disabled = false;
  }
}

function finishPayment(order) {
  cart.clear();
  attemptStore.clear();
  window.location.assign(orderConfirmationUrl(order.publicOrderId));
}

async function recoverPaymentStatus(order) {
  try { return await getPublicOrder(order.publicOrderId); }
  catch { return null; }
}

async function renderPayment(order) {
  if (paymentBrickController) {
    await Promise.resolve(paymentBrickController.unmount()).catch(() => {});
    paymentBrickController = null;
  }
  const hostedFlow = checkoutAttempt.paymentFlow === 'checkout_pro';
  root.innerHTML = `<a class="back-link" href="/#store">${t('backToStore')}</a>
    <section class="payment-step" aria-labelledby="payment-title">
      <h1 id="payment-title">${t('payment')}</h1>
      <dl><div><dt>${t('publicOrderId')}</dt><dd>${escapeHtml(order.publicOrderId)}</dd></div><div><dt>${t('total')}</dt><dd>${formatPrice(order.total, order.currency)}</dd></div></dl>
      <div id="cardPaymentBrick_container" aria-live="polite"${hostedFlow ? ' hidden' : ''}></div>
      ${hostedFlow ? `<div class="customer-form"><button id="checkout-pro-button" type="button">${t('payWithMercadoPago')}</button></div>` : ''}
      <p id="payment-status" class="checkout-status" role="status">${t('loadingPayment')}</p>
    </section>`;
  const status = root.querySelector('#payment-status');
  if (hostedFlow) {
    status.textContent = t('hostedPaymentPending');
    root.querySelector('#checkout-pro-button').addEventListener('click', () => guardedHostedPayment({ existingOrder: order }));
    return;
  }
  try {
    logPayment('Mercado Pago SDK loaded', { loaded: typeof window.MercadoPago === 'function' });
    const config = await getPaymentConfig();
    logPayment('payment config loaded', { provider: config.provider, environment: config.environment, publicKeyAvailable: Boolean(config.publicKey) });
    if (typeof window.MercadoPago !== 'function') throw new Error(t('paymentSdkUnavailable'));
    const mercadoPago = new window.MercadoPago(config.publicKey, { locale: language === 'es' ? 'es-AR' : 'en-US' });
    paymentBrickController = await mercadoPago.bricks().create('cardPayment', 'cardPaymentBrick_container', {
      initialization: { amount: order.total, payer: { email: order.customer?.email || undefined } },
      customization: { visual: { style: { theme: 'dark', customVariables: { baseColor: '#75ff38', formBackgroundColor: '#0c0b0b', inputBackgroundColor: '#151515' } }, texts: { formSubmit: t('payNow') } } },
      callbacks: {
        onReady: () => { status.textContent = ''; },
        onSubmit: async cardData => {
          status.textContent = t('processingPayment');
          logPayment('sending tokenized payment', { publicOrderId: order.publicOrderId });
          try {
            const updated = await createPayment(order.id, cardData, { idempotencyKey: checkoutAttempt.paymentKey });
            logPayment('payment response received', { publicOrderId: updated.publicOrderId, status: updated.status });
            if (['paid', 'processing', 'awaiting_payment'].includes(updated.status)) return finishPayment(updated);
            if (updated.status === 'failed') {
              checkoutAttempt = attemptStore.rotatePaymentKey(checkoutAttempt);
              status.textContent = t('paymentRejectedRetry');
              return;
            }
            if (updated.status === 'cancelled') { status.textContent = t('orderCancelled'); return; }
            status.textContent = t('paymentStatusUnknown');
          } catch (error) {
            const recovered = await recoverPaymentStatus(order);
            if (recovered && ['paid', 'processing', 'awaiting_payment'].includes(recovered.status)) return finishPayment(recovered);
            if (recovered?.status === 'failed') checkoutAttempt = attemptStore.rotatePaymentKey(checkoutAttempt);
            if (recovered?.status === 'cancelled') { status.textContent = t('orderCancelled'); return; }
            status.textContent = error.statusDetail
              ? `Payment rejected: ${error.statusDetail}`
              : (recovered?.status === 'failed' ? t('paymentRejectedRetry') : error.message);
          }
        },
        onError: error => {
          logPayment('Card Payment Brick error', { type: error?.type || 'unknown', message: error?.message || 'unknown' });
          status.textContent = t('paymentFormError');
        }
      }
    });
    logPayment('Card Payment Brick created', { publicOrderId: order.publicOrderId });
  } catch (error) {
    logPayment('payment step error', { message: error.message });
    status.textContent = error.message;
  }
}

render();
