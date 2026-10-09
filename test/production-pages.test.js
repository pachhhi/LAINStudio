import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { CartService } from '../cart-service.js';
import { formatPrice } from '../commerce.js';
import { products } from '../products.js';
import { siteContact } from '../site-config.js';

const root = new URL('../', import.meta.url);
const pages = ['index.html', 'checkout.html', 'order.html', 'privacy.html', 'terms.html', '404.html'];

test('Railway deployment runs migrations before start and checks application readiness', async () => {
  const config = JSON.parse(await readFile(new URL('../railway.json', import.meta.url), 'utf8'));
  assert.equal(config.build.builder, 'RAILPACK');
  assert.equal(config.build.buildCommand, 'npm ci --omit=dev');
  assert.deepEqual(config.deploy.preDeployCommand, ['npm run db:migrate']);
  assert.equal(config.deploy.startCommand, 'npm start');
  assert.equal(config.deploy.healthcheckPath, '/health');
  assert.equal(config.deploy.restartPolicyType, 'ALWAYS');
});

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

test('store exposes the current outfit garments and excludes removed designs', () => {
  const names = products.map(product => product.name);
  assert.equal(names.some(name => name.includes('ROOT ARCH')), false);
  assert.equal(names.some(name => name.includes('COPLAND')), false);
  assert.equal(names.includes('LAIN POSTER T-shirt'), false);
  assert.equal(names.includes('LAIN POSTER WHITE T-shirt'), true);
  assert.deepEqual(
    ['CAT T-shirt', 'LAIN DEREALIZATION T-shirt', 'THE SMITHS T-shirt', 'ANTI SOCIAL T-shirt', 'APHEX TWIN T-shirt'].filter(name => !names.includes(name)),
    []
  );
});

test('only the requested store cards start with their back design visible', () => {
  assert.deepEqual(
    products.filter(product => product.cardPreviewSide === 'back').map(product => product.name).sort(),
    ['CAT T-shirt', 'LAIN WIRED T-shirt'].sort()
  );
});

test('Spanish and English translation catalogs contain the same keys', async () => {
  const { translations } = await import('../i18n.js');
  assert.deepEqual(Object.keys(translations.es).sort(), Object.keys(translations.en).sort());
  assert.equal(Object.values(translations.es).every(Boolean), true);
});

test('Brand Identity service reuses the existing Studio service structure', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const services = html.match(/<article class="service">[\s\S]*?<\/article>/g) || [];
  assert.equal(services.length, 4);
  const brand = services[3];
  assert.match(brand, /data-i18n="brandIdentityDirection"/);
  assert.match(brand, /class="service__content"/);
  assert.match(brand, /class="service__copy"/);
  assert.match(brand, /class="service__action section-header__eyebrow" href="#contact" data-i18n="startProject"/);
  assert.match(brand, /class="service__metadata"/);
  assert.match(brand, /class="service__status"/);
  assert.match(brand, /class="service__capabilities"/);
});

test('official commercial email is centralized and linked from contact and legal pages', async () => {
  assert.equal(siteContact.email, 'lainstudio@outlook.com.ar');
  const contactScript = await readFile(new URL('../contact.js', import.meta.url), 'utf8');
  const legalScript = await readFile(new URL('../legal.js', import.meta.url), 'utf8');
  assert.match(contactScript, /`mailto:\$\{siteContact\.email\}`/);
  assert.match(legalScript, /mailto:\$\{siteContact\.email\}/);
  assert.equal(contactScript.includes('lainstudio@outlook.com.ar'), false);
  assert.equal(legalScript.includes('lainstudio@outlook.com.ar'), false);
});

test('checkout loads the official Mercado Pago browser SDK without embedded credentials', async () => {
  const checkout = await readFile(new URL('../checkout.html', import.meta.url), 'utf8');
  assert.match(checkout, /https:\/\/sdk\.mercadopago\.com\/js\/v2/);
  assert.doesNotMatch(checkout, /APP_USR|TEST-[A-Za-z0-9_-]{12,}/);
});

test('checkout renders delivery choices only inside the existing Shipping Method section', async () => {
  const checkout = await readFile(new URL('../checkout.js', import.meta.url), 'utf8');
  assert.doesNotMatch(checkout, /<legend>\$\{t\('deliveryMode'\)\}<\/legend>/);
  assert.doesNotMatch(checkout, /name="shippingSelection" value="home_delivery"|<strong>\$\{t\('homeDelivery'\)\}<\/strong>/);
  assert.match(checkout, /id="shipping-method-options" class="shipping-methods"><legend>\$\{t\('shippingMethod'\)\}<\/legend>[\s\S]*name="shippingSelection" value="coordinate"[\s\S]*name="shippingSelection" value="\$\{escapeHtml\(method\.id\)\}"/);
  assert.ok(checkout.indexOf('id="shipping-method-options"') < checkout.indexOf('id="delivery-address"'));
  assert.match(checkout, /data-enviopack-intent/);
  assert.match(checkout, /id="delivery-address" class="delivery-address" hidden/);
});

test('checkout address hidden state overrides its grid layout', async () => {
  const css = await readFile(new URL('../checkout.css', import.meta.url), 'utf8');
  assert.match(css, /\.delivery-address\[hidden\]\s*\{\s*display:\s*none;/);
  const html = await readFile(new URL('../checkout.html', import.meta.url), 'utf8');
  assert.match(html, /checkout\.css\?v=pickup-contract-2/);
  assert.match(html, /checkout\.js\?v=checkout-pro-1/);
});

test('checkout mounts the official payment Brick inline after delivery without a duplicate submit button', async () => {
  const checkout = await readFile(new URL('../checkout.js', import.meta.url), 'utf8');
  assert.ok(checkout.indexOf('id="delivery-address"') < checkout.indexOf('id="cardPaymentBrick_container"'));
  assert.match(checkout, /<fieldset class="shipping-methods" aria-labelledby="payment-title">\s*<legend id="payment-title">\$\{t\('payment'\)\}<\/legend>/);
  assert.doesNotMatch(checkout, /<button type="submit"/);
  assert.match(checkout, /onSubmit: cardData => guardedIntegratedPayment/);
  assert.match(checkout, /order = await guardedCheckout[\s\S]*createPayment\(order\.id, cardData/);
  assert.match(checkout, /order\.total !== mountedAmount/);
  assert.doesNotMatch(checkout, /form\.elements/);
  assert.doesNotMatch(checkout, /payment-environment|payment-notice|testPaymentNotice/);
});

test('real T-shirts are purchasable at the configured ARS price without pending-price data', () => {
  const shirts = products.filter(product => product.id.startsWith('lain-tee-'));
  assert.equal(shirts.length, 9);
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
