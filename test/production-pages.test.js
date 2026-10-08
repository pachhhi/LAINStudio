import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { CartService } from '../cart-service.js';
import { formatPrice } from '../commerce.js';
import { products } from '../products.js';

const root = new URL('../', import.meta.url);
const pages = ['index.html', 'checkout.html', 'order.html', 'privacy.html', 'terms.html', '404.html'];

test('production pages include viewport, description and favicon metadata', async () => {
  for (const page of pages) {
    const html = await readFile(new URL(page, root), 'utf8');
    assert.match(html, /name="viewport"/i, page);
    assert.match(html, /name="description"/i, page);
    assert.match(html, /rel="icon"/i, page);
  }
});

test('navigation targets and referenced production images exist', async () => {
  for (const path of ['privacy.html', 'terms.html', 'img/lain-icon.png', 'img/lain-bg-skyline-header.webp']) await access(new URL(path, root));
  const productsModule = await import('../products.js');
  for (const product of productsModule.products) {
    const images = Array.isArray(product.images) ? product.images : Object.values(product.images);
    for (const image of images) await access(new URL(`..${image}`, import.meta.url));
  }
  for (const page of pages) {
    const html = await readFile(new URL(page, root), 'utf8');
    assert.equal(html.includes('/studio/'), false, `${page} references the removed Studio route`);
    assert.equal(html.includes('/returns.html'), false, `${page} references the removed Returns page`);
  }
});

test('web product images are bounded for production delivery', async () => {
  const productsModule = await import('../products.js');
  const webImages = productsModule.products.flatMap(product => Array.isArray(product.images) ? [] : Object.values(product.images));
  for (const image of webImages) assert.ok((await stat(new URL(`..${image}`, import.meta.url))).size < 400_000, `${image} is too large`);
});

test('Spanish and English translation catalogs contain the same keys', async () => {
  const { translations } = await import('../i18n.js');
  assert.deepEqual(Object.keys(translations.es).sort(), Object.keys(translations.en).sort());
  assert.equal(Object.values(translations.es).every(Boolean), true);
});

test('checkout loads the official Mercado Pago browser SDK without embedded credentials', async () => {
  const checkout = await readFile(new URL('../checkout.html', import.meta.url), 'utf8');
  assert.match(checkout, /https:\/\/sdk\.mercadopago\.com\/js\/v2/);
  assert.doesNotMatch(checkout, /APP_USR|TEST-[A-Za-z0-9_-]{12,}/);
});

test('real T-shirts are purchasable at the configured ARS price without pending-price data', () => {
  const shirts = products.filter(product => product.id.startsWith('lain-tee-'));
  assert.equal(shirts.length, 6);
  for (const shirt of shirts) {
    assert.equal(shirt.price, 30000);
    assert.equal(shirt.currency, 'ARS');
    assert.equal(shirt.available, true);
    assert.equal(shirt.shipping.weightKg, 0.3);
    assert.deepEqual(shirt.shipping, { weightKg: 0.3, widthCm: 30, lengthCm: 25, heightCm: 5, temporary: true });
    assert.deepEqual(shirt.sizeGuide, { referenceSize: 'L', widthCm: 64, lengthCm: 75, shoulderSleeveCm: 48, temporary: true });
    assert.match(shirt.description.es, /100% algodón/);
    assert.match(shirt.description.en, /100% cotton/);
  }
  assert.match(formatPrice(30000, 'ARS', 'es-AR'), /30\.000/);
  const store = { load: () => [], save: () => true, clear: () => {} };
  const cart = new CartService({ catalog: products, store });
  cart.add({ productId: shirts[0].id, variantId: 'L', quantity: 1 });
  assert.deepEqual(cart.getItems(), [{ productId: shirts[0].id, variantId: 'L', quantity: 1 }]);
  assert.equal(cart.getItems().some(item => products.find(product => product.id === item.productId).price == null), false);
});

test('non-priced artwork remains unavailable instead of blocking checkout', () => {
  const artwork = products.find(product => product.id === 'lain-art-01');
  assert.equal(artwork.price, null);
  assert.equal(artwork.available, false);
});
