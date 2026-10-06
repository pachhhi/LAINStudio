import { products } from './products.js';
import { formatPrice } from './commerce.js';
import { CartStore } from './cart-store.js';
import { CartService } from './cart-service.js';
import { createCheckout, getShippingQuotes, orderConfirmationUrl } from './checkout-api.js';
import { createSubmitGuard } from './checkout-submit.js';
import { resolveLanguage, translate } from './i18n.js';

const root = document.querySelector('#checkout-root');
const cart = new CartService({ catalog: products, store: new CartStore() });
const language = resolveLanguage();
const t = key => translate(language, key);
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const images = product => Array.isArray(product.images) ? product.images : Object.values(product.images || {});
const checkoutKey = sessionStorage.getItem('lain-checkout-key') || crypto.randomUUID();
sessionStorage.setItem('lain-checkout-key', checkoutKey);
const guardedCheckout = createSubmitGuard((items, customer, shipping) => createCheckout(items, customer, { ...shipping, idempotencyKey: checkoutKey }));
let shippingPrice = null;
let selectedShippingMethodId = null;
let checkoutHasPendingPrice = false;
let shippingRequest = 0;
const provinces = ['Buenos Aires', 'Ciudad Autónoma de Buenos Aires', 'Catamarca', 'Chaco', 'Chubut', 'Córdoba', 'Corrientes', 'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja', 'Mendoza', 'Misiones', 'Neuquén', 'Río Negro', 'Salta', 'San Juan', 'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero', 'Tierra del Fuego', 'Tucumán'];

function render() {
  const items = cart.getItems();
  if (!items.length) {
    root.innerHTML = `<a class="back-link" href="/#store">${t('backToCollection')}</a><section class="checkout-empty"><span>LAIN / CHECKOUT</span><h1>${t('emptyCheckout')}</h1><p>${t('emptyCheckoutCopy')}</p></section>`;
    return;
  }
  const resolved = items.map(item => ({ ...item, product: products.find(product => product.id === item.productId) }));
  const hasPendingPrice = resolved.some(item => item.product.price == null);
  checkoutHasPendingPrice = hasPendingPrice;
  selectedShippingMethodId = null;
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
        <div class="summary-total"><span>Shipping</span><strong id="shipping-total">—</strong></div>
        <div class="summary-total"><span>${t('total')}</span><strong id="checkout-total">${formatPrice(subtotal, currency)}</strong></div>
      </section>
      <form id="checkout-form" class="customer-form">
        <h2>${t('buyerInformation')}</h2>
        <label>${t('name')}<input name="name" autocomplete="name" required maxlength="100"></label>
        <label>EMAIL<input name="email" type="email" autocomplete="email" required maxlength="150"></label>
        <label>${t('phoneOptional')}<input name="phone" type="tel" autocomplete="tel" maxlength="40"></label>
        <fieldset class="delivery-address"><legend>${t('deliveryAddress')}</legend>
          <div class="shipping-address-fields delivery-street">
            <label>${t('street')}<input name="street" autocomplete="address-line1" required maxlength="120"></label>
            <label>${t('streetNumber')}<input name="streetNumber" autocomplete="address-line2" required maxlength="20"></label>
          </div>
          <label>${t('apartmentFloor')} <span>${t('optional')}</span><input name="apartmentFloor" autocomplete="address-line3" maxlength="60"></label>
          <label>${t('city')}<input name="city" autocomplete="address-level2" required maxlength="100"></label>
          <div class="shipping-address-fields">
          <label>${t('province')}<select name="province" autocomplete="address-level1" required><option value="">${t('selectProvince')}</option>${provinces.map(province => `<option>${province}</option>`).join('')}</select></label>
          <label>${t('postalCode')}<input name="postalCode" inputmode="numeric" autocomplete="postal-code" required maxlength="4" pattern="[0-9]{4}"></label>
          </div>
        </fieldset>
        <fieldset class="shipping-methods"><legend>${t('shippingMethod')}</legend><div id="shipping-methods" aria-live="polite"><p class="form-note">${t('enterPostalCode')}</p></div></fieldset>
        <button type="submit" disabled>${t('createOrder')}</button>
        <p class="form-note">${hasPendingPrice ? t('pendingPriceNotice') : t('noPaymentYet')}</p>
        <p id="checkout-status" class="checkout-status" role="status"></p>
      </form>
    </div>`;
  const form = root.querySelector('#checkout-form');
  form.addEventListener('submit', submitCheckout);
  let quoteTimer;
  const scheduleQuote = () => { clearTimeout(quoteTimer); quoteTimer = setTimeout(() => updateShipping(form, subtotal, currency), 300); };
  form.elements.province.addEventListener('change', scheduleQuote);
  form.elements.postalCode.addEventListener('input', scheduleQuote);
  form.addEventListener('input', () => updateCreateButton(form));
  form.addEventListener('change', () => updateCreateButton(form));
}

async function updateShipping(form, subtotal, currency) {
  const province = form.elements.province.value;
  const postalCode = form.elements.postalCode.value.trim();
  const container = form.querySelector('#shipping-methods');
  shippingPrice = null;
  selectedShippingMethodId = null;
  updateTotals(subtotal, currency);
  updateCreateButton(form);
  if (!province || !/^\d{4}$/.test(postalCode)) {
    container.innerHTML = `<p class="form-note">${t('enterPostalCode')}</p>`;
    return;
  }
  const requestId = ++shippingRequest;
  container.innerHTML = `<p class="form-note">${t('calculatingShipping')}</p>`;
  try {
    const result = await getShippingQuotes(postalCode, province, cart.getItems());
    if (requestId !== shippingRequest) return;
    if (!result.available) {
      container.innerHTML = `<p class="form-note">${t('shippingUnavailable')}</p>`;
      return;
    }
    if (!result.methods.length) {
      container.innerHTML = `<p class="form-note">${t('noShippingMethods')}</p>`;
      return;
    }
    container.innerHTML = result.methods.map(method => `<label class="shipping-method"><input type="radio" name="shippingMethod" value="${escapeHtml(method.id)}" data-price="${method.price}"><span><strong>${escapeHtml(method.carrier)} / ${escapeHtml(method.name)}</strong>${method.estimatedHours == null ? '' : `<small>${escapeHtml(t('upToHours').replace('{hours}', method.estimatedHours))}</small>`}</span><b>${formatPrice(method.price, currency)}</b></label>`).join('');
    const selectMethod = event => { selectedShippingMethodId = event.currentTarget.value; shippingPrice = Number(event.currentTarget.dataset.price); updateTotals(subtotal, currency); updateCreateButton(form); };
    container.querySelectorAll('input').forEach(input => input.addEventListener('change', selectMethod));
  } catch (error) {
    const errorKeys = { shipping_auth_failed: 'shippingUnavailable', shipping_quote_failed: 'shippingRetry',
      shipping_invalid_provider_response: 'shippingInvalidResponse', shipping_product_missing_dimensions: 'shippingMissingDimensions',
      shipping_invalid_destination: 'shippingInvalidDestination', shipping_connection_failed: 'shippingConnectionError' };
    if (requestId === shippingRequest) container.innerHTML = `<p class="form-note">${escapeHtml(errorKeys[error.code] ? t(errorKeys[error.code]) : error.message)}</p>`;
  }
}

function updateCreateButton(form) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = checkoutHasPendingPrice || !selectedShippingMethodId || !form.checkValidity();
}

function updateTotals(subtotal, currency) {
  root.querySelector('#shipping-total').textContent = shippingPrice == null ? '—' : formatPrice(shippingPrice, currency);
  root.querySelector('#checkout-total').textContent = formatPrice(subtotal == null ? null : subtotal + (shippingPrice || 0), currency);
}

async function submitCheckout(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector('#checkout-status');
  const button = form.querySelector('button');
  button.disabled = true;
  status.textContent = t('creatingOrder');
  try {
    const formData = new FormData(form);
    const customer = { name: formData.get('name'), email: formData.get('email'), phone: formData.get('phone') };
    const deliveryAddress = { street: formData.get('street'), streetNumber: formData.get('streetNumber'),
      apartmentFloor: formData.get('apartmentFloor'), city: formData.get('city'), province: formData.get('province'), postalCode: formData.get('postalCode') };
    const order = await guardedCheckout(cart.getItems(), customer, { deliveryAddress, shippingMethodId: selectedShippingMethodId });
    sessionStorage.removeItem('lain-checkout-key');
    cart.clear();
    window.location.assign(orderConfirmationUrl(order.publicOrderId));
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

render();
