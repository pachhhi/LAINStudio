import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('durable order page loads its state from the public order API', async () => {
  const html = await readFile(new URL('../order.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../order.js', import.meta.url), 'utf8');
  const translations = await readFile(new URL('../i18n.js', import.meta.url), 'utf8');
  const checkout = await readFile(new URL('../checkout.js', import.meta.url), 'utf8');
  assert.match(html, /id="order-root"/);
  assert.match(html, /noindex,nofollow/);
  assert.match(script, /getPublicOrder\(publicOrderId\)/);
  assert.match(translations, /ORDER CREATED/);
  assert.match(translations, /PAYMENT APPROVED/);
  assert.match(script, /invalidOrder/);
  assert.match(script, /order\.status !== 'paid'/);
  assert.match(script, /renderUnconfirmedOrder\(order\)/);
  assert.match(script, /order\.deliveryMode === 'coordinate'/);
  assert.match(script, /coordinateDelivery/);
  assert.doesNotMatch(script, /customer\.email|customer\.phone|paymentId|paymentProvider/);
  assert.doesNotMatch(script, /deliveryAddress|streetNumber|apartmentFloor/);
  assert.match(checkout, /renderPayment\(checkoutAttempt\.order\)/);
  assert.match(checkout, /createPayment\(order\.id, cardData/);
  assert.match(checkout, /\['paid', 'processing', 'awaiting_payment'\]/);
  assert.match(checkout, /window\.location\.assign\(orderConfirmationUrl\(order\.publicOrderId\)\)/);
});
