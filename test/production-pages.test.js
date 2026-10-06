import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';

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
