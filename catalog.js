import { products, categories } from './products.js';
import { formatPrice } from './commerce.js';
import { translate } from './i18n.js';
import { initLanguageSelector } from './language-selector.js';
import { CartStore } from './cart-store.js';
import { CartService } from './cart-service.js';

const catalogRoot = document.querySelector('#catalog-content');
const cartDialog = document.querySelector('#cart-dialog');
const cartRoot = document.querySelector('#cart-content');
let language;
let selectedCategory = 'ALL';
let selectedSort = 'featured';
const cartService = new CartService({ catalog: products, store: new CartStore() });

function t(key) { return translate(language, key); }
function money(price, currency) { return formatPrice(price, currency, 'es-AR', t('priceTba')); }

function productImages(product) {
  return Array.isArray(product.images)
    ? product.images
    : Object.values(product.images || {}).filter(Boolean);
}

function productVariants(product) {
  if (product.variants?.length) return product.variants.filter(variant => variant.available !== false);
  return (product.sizes || []).map(size => ({ id: size, size, available: true }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function cartItems() { return cartService.getItems(); }

function cartChanged() {
  updateCartTrigger();
  if (cartDialog.open) renderCart();
}

function updateCartTrigger() {
  const count = cartService.getCount();
  const countNode = document.querySelector('#cart-count');
  if (countNode) countNode.textContent = String(count);
  const trigger = document.querySelector('[data-open-cart]');
  if (trigger) trigger.setAttribute('aria-label', `${t('cart')}, ${count} items`);
}

function renderCatalog() {
  const categoryControls = ['ALL', ...categories].map(category => `
    <button class="catalog-control" type="button" data-category="${escapeHtml(category)}" aria-pressed="${selectedCategory === category}">${escapeHtml(category.toUpperCase())}</button>
  `).join('');

  catalogRoot.innerHTML = `
    <div class="section-header">
      <div>
        <span class="section-header__eyebrow">LAIN / WEARING</span>
        <h2 class="section-header__title">${t('collection')}</h2>
        <p class="section-header__description">${t('collectionDescription')}</p>
      </div>
      <div class="section-header__aside"><span class="section-header__metadata">BUENOS AIRES / 2026</span></div>
    </div>
    <div class="catalog-toolbar" aria-label="Collection controls">
      <div class="category-list" aria-label="Filter by category">${categoryControls}</div>
      <div class="toolbar-actions">
        <label class="sort-label" for="catalog-sort">${t('sort')}</label>
        <select class="sort-select" id="catalog-sort">
          <option value="featured" ${selectedSort === 'featured' ? 'selected' : ''}>${t('featured')}</option>
          <option value="newest" ${selectedSort === 'newest' ? 'selected' : ''}>${t('newest')}</option>
          <option value="price-asc" ${selectedSort === 'price-asc' ? 'selected' : ''}>${t('priceLowHigh')}</option>
          <option value="price-desc" ${selectedSort === 'price-desc' ? 'selected' : ''}>${t('priceHighLow')}</option>
        </select>
        <button class="cart-trigger" type="button" data-open-cart aria-label="${t('cart')}, ${cartService.getCount()} items">${t('cart')} <span id="cart-count">${cartService.getCount()}</span></button>
      </div>
    </div>
    <div id="product-results"></div>
  `;
  renderProducts();
}

function sortProducts(items) {
  const sorted = [...items];
  if (selectedSort === 'newest') sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (selectedSort === 'price-asc') sorted.sort((a, b) => a.price - b.price);
  if (selectedSort === 'price-desc') sorted.sort((a, b) => b.price - a.price);
  if (selectedSort === 'featured') sorted.sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)));
  return sorted;
}

function renderProducts() {
  const results = document.querySelector('#product-results');
  const matching = sortProducts(products.filter(product => selectedCategory === 'ALL' || product.category === selectedCategory));
  if (!matching.length) {
    results.innerHTML = `<div class="empty-products"><h3>${t('nothing')}</h3><p>${t('tryAnotherCategory')}</p></div>`;
    return;
  }
  results.innerHTML = `<div class="product-grid">${matching.map(product => `
    <article class="product-card" data-current-side="front">
        <div class="product-image-frame">
          <a class="product-link product-image-link" href="#collection/${encodeURIComponent(product.slug)}" aria-label="${t('viewProduct')} ${escapeHtml(product.name)}">
          <img class="product-image-primary${product.imageFit === 'contain' ? ' product-image-contain' : ''}" src="${escapeHtml(productImages(product)[0])}" alt="${escapeHtml(product.name)}" loading="lazy">
          ${productImages(product)[1] ? `<img class="product-image-secondary${product.imageFit === 'contain' ? ' product-image-contain' : ''}" data-src="${escapeHtml(productImages(product)[1])}" alt="" width="1254" height="1254">` : ''}
          ${product.available === false ? `<span class="availability-tag">${t('unavailable')}</span>` : ''}
          </a>
          ${productImages(product).length > 1 ? `<div class="product-image-switcher" role="group" aria-label="${t('chooseImage')}"><button type="button" data-image-choice="front" aria-label="${t('showFront')}" aria-pressed="true">${t('front')}</button><button type="button" data-image-choice="back" aria-label="${t('showBack')}" aria-pressed="false">${t('back')}</button></div>` : ''}
        </div>
      <a class="product-link" href="#collection/${encodeURIComponent(product.slug)}" aria-label="${t('viewProduct')} ${escapeHtml(product.name)}">
        <div class="product-meta">
          <div><h3 class="product-title">${escapeHtml(product.name)}</h3><span class="product-category">${escapeHtml(product.category)}</span></div>
          <span class="product-price">${money(product.price, product.currency)}</span>
        </div>
      </a>
    </article>
  `).join('')}</div>`;
  results.querySelectorAll('[data-image-choice]').forEach(button => button.addEventListener('click', () => {
    const card = button.closest('.product-card');
    const secondary = card.querySelector('.product-image-secondary');
    if (button.dataset.imageChoice === 'back' && secondary?.dataset.src && !secondary.src) secondary.src = secondary.dataset.src;
    card.dataset.currentSide = button.dataset.imageChoice;
    card.querySelectorAll('[data-image-choice]').forEach(item => {
      item.setAttribute('aria-pressed', String(item.dataset.imageChoice === card.dataset.currentSide));
    });
  }));
}

function renderNotFound() {
  catalogRoot.innerHTML = `
    <a class="detail-back" href="#store">${t('backToCollection')}</a>
    <div class="empty-products"><span class="catalog-kicker">${t('noSignal')}</span><h3>${t('productNotFound')}</h3><p>${t('productMoved')}</p><a class="detail-back" href="#store">${t('viewCollection')}</a></div>
  `;
}

function renderProduct(product) {
  const images = productImages(product);
  const variants = productVariants(product);
  let selectedImage = 0;
  let selectedVariantId = '';
  let selectedColor = product.colors?.[0] || '';
  let quantity = 1;

  catalogRoot.innerHTML = `
    <a class="detail-back" href="#store">${t('backToCollection')}</a>
    <div class="detail-layout">
      <div class="product-gallery">
        <div class="gallery-main"><img id="gallery-main-image" class="${product.imageFit === 'contain' ? 'product-image-contain' : ''}" src="${escapeHtml(images[0])}" alt="${escapeHtml(product.name)}"></div>
        ${images.length > 1 ? `<div class="gallery-thumbnails" aria-label="Product images">${images.map((image, index) => `
          <button class="gallery-thumb" type="button" data-image-index="${index}" aria-label="Show image ${index + 1} of ${images.length}" aria-pressed="${index === 0}"><img src="${escapeHtml(image)}" alt=""></button>
        `).join('')}</div>` : ''}
      </div>
      <div class="detail-info">
        <span class="detail-category">${escapeHtml(product.category)}</span>
        <h2 class="detail-name">${escapeHtml(product.name)}</h2>
        <p class="detail-price">${money(product.price, product.currency)}</p>
        ${product.description ? `<p class="detail-description">${escapeHtml(product.description)}</p>` : ''}
        <span class="detail-availability ${product.available === false ? 'is-unavailable' : ''}">${product.available === false ? t('unavailable') : t('madeToOrder')}</span>
        ${product.colors?.length ? `<fieldset class="variant-group"><legend>${t('color')} / <span id="selected-color">${escapeHtml(selectedColor)}</span></legend><div class="color-options">${product.colors.map((color, index) => `
          <button class="color-option" type="button" data-color-index="${index}" aria-pressed="${index === 0}">${escapeHtml(color)}</button>
        `).join('')}</div></fieldset>` : ''}
        ${variants.length ? `<fieldset class="variant-group" data-variant-group><legend>${t('size')} / <span id="selected-size">${t('selectSize')}</span></legend><div class="size-options">${variants.map((variant, index) => `
          <button class="size-option" type="button" data-size-index="${index}" aria-pressed="false">${escapeHtml(variant.size || variant.options?.size || variant.id)}</button>
        `).join('')}</div></fieldset>` : ''}
        ${variants.length ? `<button class="size-guide-link" type="button" data-size-guide>${t('sizeGuide')}</button><p class="size-guide-note" id="size-guide-note" hidden>${t('sizeGuidePending')}</p>` : ''}
        <p class="variant-error" id="variant-error" role="alert" hidden>${t('validationRequired')}</p>
        <div class="quantity-row"><span class="quantity-label">${t('quantity')}</span><div class="quantity-control"><button class="quantity-button" type="button" data-quantity="-1" aria-label="${t('decreaseQuantity')}">−</button><span id="detail-quantity" class="quantity-value" aria-live="polite">1</span><button class="quantity-button" type="button" data-quantity="1" aria-label="${t('increaseQuantity')}">+</button></div></div>
        <button class="add-cart-button" type="button" data-add-product ${product.available === false ? 'disabled' : ''}>${product.available === false ? t('unavailable').toUpperCase() : t('addToCart')}</button>
      </div>
    </div>
  `;

  catalogRoot.querySelectorAll('[data-image-index]').forEach(button => button.addEventListener('click', () => {
    selectedImage = Number(button.dataset.imageIndex);
    catalogRoot.querySelector('#gallery-main-image').src = images[selectedImage];
    catalogRoot.querySelectorAll('[data-image-index]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));
  catalogRoot.querySelectorAll('[data-size-index]').forEach(button => button.addEventListener('click', () => {
    const variant = variants[Number(button.dataset.sizeIndex)];
    selectedVariantId = variant.id;
    catalogRoot.querySelector('#selected-size').textContent = variant.size || variant.options?.size || variant.id;
    catalogRoot.querySelector('#variant-error').hidden = true;
    catalogRoot.querySelectorAll('[data-size-index]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));
  catalogRoot.querySelectorAll('[data-color-index]').forEach(button => button.addEventListener('click', () => {
    selectedColor = product.colors[Number(button.dataset.colorIndex)];
    catalogRoot.querySelector('#selected-color').textContent = selectedColor;
    catalogRoot.querySelectorAll('[data-color-index]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));
  catalogRoot.querySelectorAll('[data-quantity]').forEach(button => button.addEventListener('click', () => {
    quantity = Math.max(1, Math.min(10, quantity + Number(button.dataset.quantity)));
    catalogRoot.querySelector('#detail-quantity').textContent = String(quantity);
  }));
  catalogRoot.querySelector('[data-size-guide]')?.addEventListener('click', () => {
    const note = catalogRoot.querySelector('#size-guide-note');
    note.hidden = !note.hidden;
  });
  catalogRoot.querySelector('[data-add-product]').addEventListener('click', () => {
    if (variants.length && !selectedVariantId) {
      catalogRoot.querySelector('#variant-error').hidden = false;
      return;
    }
    addToCart(product, selectedVariantId, selectedColor, quantity);
    openCart();
  });
}

function addToCart(product, variantId, color, quantity) {
  cartService.add({ productId: product.id, variantId, color, quantity });
  cartChanged();
}

function changeCartQuantity(index, amount) {
  cartService.changeQuantity(index, amount);
  cartChanged();
}

function renderCart() {
  const cart = cartItems();
  if (!cart.length) {
    cartRoot.innerHTML = `
      <div class="cart-topline"><h2 class="cart-heading" id="cart-title">${t('yourCart')}</h2><button class="text-button" type="button" data-close-cart aria-label="${t('closeCart')}">${t('close')}</button></div>
      <div class="cart-empty"><h3>${t('cartEmpty')}</h3><p>${t('exploreLatest')}</p><a class="text-button" href="#store" data-close-cart>${t('viewCollection')}</a></div>
    `;
    bindCartClose();
    return;
  }

  const hasPendingPrice = cart.some(item => products.find(product => product.id === item.productId)?.price == null);
  const subtotal = hasPendingPrice ? null : cart.reduce((total, item) => {
    const product = products.find(candidate => candidate.id === item.productId);
    return total + product.price * item.quantity;
  }, 0);
  const currency = products.find(product => product.id === cart[0].productId).currency;
  cartRoot.innerHTML = `
    <div class="cart-topline"><h2 class="cart-heading" id="cart-title">${t('yourCart')} <span class="catalog-count">(${cart.reduce((total, item) => total + item.quantity, 0)})</span></h2><button class="text-button" type="button" data-close-cart aria-label="${t('closeCart')}">${t('close')}</button></div>
    <div class="cart-items">${cart.map((item, index) => {
      const product = products.find(candidate => candidate.id === item.productId);
      const variant = [item.variantId || item.size, item.color].filter(Boolean).join(' / ');
      return `<article class="cart-item">
        <img src="${escapeHtml(productImages(product)[0])}" alt="${escapeHtml(product.name)}">
        <div><h3 class="cart-item-name">${escapeHtml(product.name)}</h3><p class="cart-item-options">${escapeHtml(variant)}</p>
          <div class="cart-item-bottom"><div class="cart-quantity"><button class="quantity-button" type="button" data-cart-index="${index}" data-cart-change="-1" aria-label="Decrease ${escapeHtml(product.name)} quantity">−</button><span class="quantity-value">${item.quantity}</span><button class="quantity-button" type="button" data-cart-index="${index}" data-cart-change="1" aria-label="Increase ${escapeHtml(product.name)} quantity">+</button></div><span>${money(product.price == null ? null : product.price * item.quantity, product.currency)}</span></div>
          <button class="cart-remove" type="button" data-remove-index="${index}">${t('remove')}</button>
        </div>
      </article>`;
    }).join('')}</div>
    <div class="cart-footer"><div class="cart-subtotal"><span>${t('subtotal')}</span><strong>${money(subtotal, currency)}</strong></div><button class="checkout-button" type="button" data-checkout>${t('checkout')}</button><p class="checkout-message" aria-live="polite"></p></div>
  `;
  bindCartClose();
  cartRoot.querySelectorAll('[data-cart-change]').forEach(button => button.addEventListener('click', () => changeCartQuantity(Number(button.dataset.cartIndex), Number(button.dataset.cartChange))));
  cartRoot.querySelectorAll('[data-remove-index]').forEach(button => button.addEventListener('click', () => {
    cartService.remove(Number(button.dataset.removeIndex));
    cartChanged();
  }));
  cartRoot.querySelector('[data-checkout]').addEventListener('click', () => {
    window.location.href = '/checkout.html';
  });
}

function bindCartClose() {
  cartRoot.querySelectorAll('[data-close-cart]').forEach(button => button.addEventListener('click', () => cartDialog.close()));
}

function openCart() {
  renderCart();
  cartDialog.showModal();
}

function renderRoute() {
  const match = window.location.hash.match(/^#collection\/([^/?#]+)/);
  if (!match) {
    renderCatalog();
    return;
  }
  const slug = decodeURIComponent(match[1]);
  const product = products.find(item => item.slug === slug);
  if (!product) renderNotFound();
  else renderProduct(product);
}

catalogRoot.addEventListener('click', event => {
  const categoryButton = event.target.closest('[data-category]');
  if (categoryButton) {
    selectedCategory = categoryButton.dataset.category;
    catalogRoot.querySelectorAll('[data-category]').forEach(button => button.setAttribute('aria-pressed', String(button === categoryButton)));
    renderProducts();
    return;
  }
  if (event.target.closest('[data-open-cart]')) openCart();
});
catalogRoot.addEventListener('change', event => {
  if (event.target.id === 'catalog-sort') {
    selectedSort = event.target.value;
    renderProducts();
  }
});
window.addEventListener('hashchange', renderRoute);
cartDialog.addEventListener('click', event => {
  if (event.target === cartDialog) cartDialog.close();
});

language = initLanguageSelector(nextLanguage => {
    language = nextLanguage;
    renderRoute();
});

renderRoute();
updateCartTrigger();
