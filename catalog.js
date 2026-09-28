import { products, categories } from './products.js';
import { formatPrice } from './commerce.js';
import { resolveLanguage, setLanguage, translate } from './i18n.js';

const catalogRoot = document.querySelector('#catalog-content');
const cartDialog = document.querySelector('#cart-dialog');
const cartRoot = document.querySelector('#cart-content');
const cartStorageKey = 'lain-store-cart-v1';
let language = setLanguage(resolveLanguage());
let selectedCategory = 'ALL';
let selectedSort = 'featured';
let cart = readCart();

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

function readCart() {
  try {
    const parsed = JSON.parse(localStorage.getItem(cartStorageKey) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => products.some(product => product.id === item.productId)
      && Number.isInteger(item.quantity) && item.quantity > 0);
  } catch {
    return [];
  }
}

function saveCart() {
  localStorage.setItem(cartStorageKey, JSON.stringify(cart));
  updateCartTrigger();
  if (cartDialog.open) renderCart();
}

function updateCartTrigger() {
  const count = cart.reduce((total, item) => total + item.quantity, 0);
  const countNode = document.querySelector('#cart-count');
  if (countNode) countNode.textContent = String(count);
}

function renderCatalog() {
  const categoryControls = ['ALL', ...categories].map(category => `
    <button class="catalog-control" type="button" data-category="${escapeHtml(category)}" aria-pressed="${selectedCategory === category}">${escapeHtml(category.toUpperCase())}</button>
  `).join('');

  catalogRoot.innerHTML = `
    <div class="catalog-heading">
      <div>
        <span class="catalog-kicker">LAIN / WEARING</span>
        <h2>${t('collection')}</h2>
        <p>${t('collectionDescription')}</p>
      </div>
      <div class="catalog-heading-side"><span class="catalog-count">BUENOS AIRES / 2026</span></div>
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
        <button class="cart-trigger" type="button" data-open-cart aria-label="${t('cart')}, ${cart.reduce((total, item) => total + item.quantity, 0)} items">${t('cart')} <span id="cart-count">${cart.reduce((total, item) => total + item.quantity, 0)}</span></button>
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
    <article class="product-card">
      <a class="product-link" href="#collection/${encodeURIComponent(product.slug)}" aria-label="View ${escapeHtml(product.name)}">
        <div class="product-image-frame">
          <img class="product-image-primary${Array.isArray(product.images) ? '' : ' product-image-fit'}" src="${escapeHtml(productImages(product)[0])}" alt="${escapeHtml(product.name)}" loading="lazy">
          ${productImages(product)[1] ? `<img class="product-image-secondary${Array.isArray(product.images) ? '' : ' product-image-fit'}" src="${escapeHtml(productImages(product)[1])}" alt="" loading="lazy">` : ''}
          ${productImages(product).length > 1 ? `<div class="product-image-switcher" role="group" aria-label="Choose product image"><button type="button" data-image-choice="0" aria-label="Show front" aria-pressed="true">FRONT</button><button type="button" data-image-choice="1" aria-label="Show back" aria-pressed="false">BACK</button></div>` : ''}
          ${product.available === false ? `<span class="availability-tag">${t('unavailable')}</span>` : ''}
        </div>
        <div class="product-meta">
          <div><h3 class="product-title">${escapeHtml(product.name)}</h3><span class="product-category">${escapeHtml(product.category)}</span></div>
          <span class="product-price">${money(product.price, product.currency)}</span>
        </div>
      </a>
    </article>
  `).join('')}</div>`;
  results.querySelectorAll('[data-image-choice]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const frame = button.closest('.product-image-frame');
    const index = Number(button.dataset.imageChoice);
    frame.querySelector('.product-image-primary').style.opacity = index === 0 ? '1' : '0';
    frame.querySelector('.product-image-secondary').style.opacity = index === 1 ? '1' : '0';
    frame.querySelectorAll('[data-image-choice]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));
}

function renderNotFound() {
  catalogRoot.innerHTML = `
    <a class="detail-back" href="#store">← BACK TO COLLECTION</a>
    <div class="empty-products"><span class="catalog-kicker">404 / NO SIGNAL</span><h3>This piece isn't here.</h3><p>The item may have moved on. The collection is still open.</p><a class="detail-back" href="#store">VIEW COLLECTION →</a></div>
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
    <a class="detail-back" href="#store">← BACK TO COLLECTION</a>
    <div class="detail-layout">
      <div class="product-gallery">
        <div class="gallery-main"><img id="gallery-main-image" src="${escapeHtml(images[0])}" alt="${escapeHtml(product.name)}"></div>
        ${images.length > 1 ? `<div class="gallery-thumbnails" aria-label="Product images">${images.map((image, index) => `
          <button class="gallery-thumb" type="button" data-image-index="${index}" aria-label="Show image ${index + 1} of ${images.length}" aria-pressed="${index === 0}"><img src="${escapeHtml(image)}" alt=""></button>
        `).join('')}</div>` : ''}
      </div>
      <div class="detail-info">
        <span class="detail-category">${escapeHtml(product.category)}</span>
        <h2 class="detail-name">${escapeHtml(product.name)}</h2>
        <p class="detail-price">${money(product.price, product.currency)}</p>
        <p class="detail-description">${escapeHtml(product.description)}</p>
        <span class="detail-availability ${product.available === false ? 'is-unavailable' : ''}">${product.available === false ? t('unavailable') : t('madeToOrder')}</span>
        ${product.colors?.length ? `<fieldset class="variant-group"><legend>Color / <span id="selected-color">${escapeHtml(selectedColor)}</span></legend><div class="color-options">${product.colors.map((color, index) => `
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
  const existing = cart.find(item => item.productId === product.id && (item.variantId || item.size) === variantId && item.color === color);
  if (existing) existing.quantity = Math.min(10, existing.quantity + quantity);
  else cart.push({ productId: product.id, variantId, color, quantity });
  saveCart();
}

function changeCartQuantity(index, amount) {
  cart[index].quantity += amount;
  if (cart[index].quantity < 1) cart.splice(index, 1);
  else cart[index].quantity = Math.min(10, cart[index].quantity);
  saveCart();
}

function renderCart() {
  if (!cart.length) {
    cartRoot.innerHTML = `
      <div class="cart-topline"><h2 class="cart-heading" id="cart-title">YOUR CART</h2><button class="text-button" type="button" data-close-cart aria-label="Close cart">CLOSE ×</button></div>
      <div class="cart-empty"><h3>YOUR CART IS EMPTY</h3><p>Explore the latest LAIN pieces.</p><a class="text-button" href="#store" data-close-cart>VIEW COLLECTION →</a></div>
    `;
    bindCartClose();
    return;
  }

  const subtotal = cart.reduce((total, item) => {
    const product = products.find(candidate => candidate.id === item.productId);
    return total + product.price * item.quantity;
  }, 0);
  const currency = products.find(product => product.id === cart[0].productId).currency;
  cartRoot.innerHTML = `
    <div class="cart-topline"><h2 class="cart-heading" id="cart-title">YOUR CART <span class="catalog-count">(${cart.reduce((total, item) => total + item.quantity, 0)})</span></h2><button class="text-button" type="button" data-close-cart aria-label="Close cart">CLOSE ×</button></div>
    <div class="cart-items">${cart.map((item, index) => {
      const product = products.find(candidate => candidate.id === item.productId);
      const variant = [item.variantId || item.size, item.color].filter(Boolean).join(' / ');
      return `<article class="cart-item">
        <img src="${escapeHtml(productImages(product)[0])}" alt="${escapeHtml(product.name)}">
        <div><h3 class="cart-item-name">${escapeHtml(product.name)}</h3><p class="cart-item-options">${escapeHtml(variant)}</p>
          <div class="cart-item-bottom"><div class="cart-quantity"><button class="quantity-button" type="button" data-cart-index="${index}" data-cart-change="-1" aria-label="Decrease ${escapeHtml(product.name)} quantity">−</button><span class="quantity-value">${item.quantity}</span><button class="quantity-button" type="button" data-cart-index="${index}" data-cart-change="1" aria-label="Increase ${escapeHtml(product.name)} quantity">+</button></div><span>${money(product.price * item.quantity, product.currency)}</span></div>
          <button class="cart-remove" type="button" data-remove-index="${index}">Remove</button>
        </div>
      </article>`;
    }).join('')}</div>
    <div class="cart-footer"><div class="cart-subtotal"><span>Subtotal</span><strong>${money(subtotal, currency)}</strong></div><button class="checkout-button" type="button" data-checkout>CHECKOUT</button><p class="checkout-message" aria-live="polite"></p></div>
  `;
  bindCartClose();
  cartRoot.querySelectorAll('[data-cart-change]').forEach(button => button.addEventListener('click', () => changeCartQuantity(Number(button.dataset.cartIndex), Number(button.dataset.cartChange))));
  cartRoot.querySelectorAll('[data-remove-index]').forEach(button => button.addEventListener('click', () => {
    cart.splice(Number(button.dataset.removeIndex), 1);
    saveCart();
  }));
  cartRoot.querySelector('[data-checkout]').addEventListener('click', () => {
    cartRoot.querySelector('.checkout-message').textContent = 'Checkout coming soon.';
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

document.querySelectorAll('[data-language]').forEach(button => {
  button.setAttribute('aria-pressed', String(button.dataset.language === language));
  button.addEventListener('click', () => {
    language = setLanguage(button.dataset.language);
    document.querySelectorAll('[data-language]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.language === language)));
    renderRoute();
  });
});

renderRoute();
updateCartTrigger();
