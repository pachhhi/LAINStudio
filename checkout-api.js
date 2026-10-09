export async function createCheckout(items, customer, { deliveryMode, deliveryAddress, shippingMethodId, idempotencyKey, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response; let body;
  try {
    response = await fetchImpl('/api/checkout', {
    method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ items, customer, deliveryMode, ...(deliveryMode === 'home_delivery' ? { deliveryAddress, shippingMethodId } : {}) }),
      signal: controller.signal
    });
    try { body = await response.json(); }
    catch (error) { if (error.name === 'AbortError' || controller.signal.aborted) throw error; body = null; }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The checkout request timed out. Please retry.');
    throw new Error('Could not connect to the store. Please retry.');
  } finally { clearTimeout(timeout); }
  if (!body || typeof body !== 'object') throw new Error('The store returned an invalid response.');
  if (!response.ok) throw new Error(body.error || `Could not create the order (${response.status}).`);
  if (!body.order || typeof body.order.id !== 'string' || typeof body.order.publicOrderId !== 'string') throw new Error('The store returned an invalid order.');
  return body.order;
}

export async function getShippingQuotes(postalCode, province, cart, { fetchImpl = fetch } = {}) {
  let response;
  try { response = await fetchImpl('/api/shipping/quotes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postalCode, province, cart })
  }); } catch {
    const error = new Error('Could not connect to the shipping service.'); error.code = 'shipping_connection_failed'; throw error;
  }
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new Error('The shipping service returned an invalid response.');
  if (!response.ok) {
    const messages = {
      shipping_auth_failed: 'Shipping rates are not available yet',
      shipping_quote_failed: 'Shipping rates could not be calculated. Please retry.',
      shipping_invalid_provider_response: 'The shipping provider returned an invalid response.',
      shipping_product_missing_dimensions: 'Shipping dimensions are not configured for this product.',
      shipping_invalid_destination: 'Check the province and postal code.'
    };
    const error = new Error(messages[body.code] || body.error || 'Shipping rates could not be calculated.');
    error.code = body.code;
    throw error;
  }
  if (!Array.isArray(body.methods)) throw new Error('The shipping service returned an invalid response.');
  return body;
}

async function paymentRequest(url, options, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response; let body;
  try {
    response = await fetchImpl(url, { ...options, signal: controller.signal });
    try { body = await response.json(); }
    catch (error) { if (error.name === 'AbortError' || controller.signal.aborted) throw error; body = null; }
  }
  catch (error) {
    const result = new Error(error.name === 'AbortError' ? 'The payment request timed out. Check the order status before retrying.' : 'Could not connect to the payment service. Check the order status before retrying.');
    result.code = error.name === 'AbortError' ? 'PAYMENT_TIMEOUT' : 'PAYMENT_CONNECTION_FAILED';
    throw result;
  } finally { clearTimeout(timeout); }
  if (!body || typeof body !== 'object') throw new Error('The payment service returned an invalid response.');
  if (!response.ok) {
    const error = new Error(body.error || `Could not process the payment (${response.status}).`);
    error.code = body.code;
    error.status = response.status;
    if (typeof body.statusDetail === 'string') error.statusDetail = body.statusDetail;
    throw error;
  }
  return body;
}

export async function getPaymentConfig(options = {}) {
  const body = await paymentRequest('/api/payments/config', {}, options);
  if (body.configured !== true || body.provider !== 'mercadopago' || !['test', 'production'].includes(body.environment)
    || typeof body.publicKey !== 'string' || !body.publicKey) {
    throw new Error('Mercado Pago is not configured.');
  }
  return body;
}

export async function createPayment(orderId, cardData, { idempotencyKey, ...options } = {}) {
  const body = await paymentRequest(`/api/orders/${encodeURIComponent(orderId)}/payments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      token: cardData.token,
      paymentMethodId: cardData.payment_method_id,
      installments: cardData.installments,
      ...(cardData.issuer_id ? { issuerId: cardData.issuer_id } : {}),
      ...(cardData.payer?.identification ? { identification: cardData.payer.identification } : {})
    })
  }, options);
  if (!body.order || typeof body.order.status !== 'string') throw new Error('The payment service returned an invalid order.');
  return body.order;
}

export async function createHostedCheckout(orderId, { idempotencyKey, ...options } = {}) {
  const body = await paymentRequest(`/api/orders/${encodeURIComponent(orderId)}/checkout-pro`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: '{}'
  }, options);
  if (!body.order || typeof body.order.status !== 'string' || typeof body.checkoutUrl !== 'string') {
    throw new Error('The payment service returned an invalid hosted checkout.');
  }
  let url;
  try { url = new URL(body.checkoutUrl); } catch { throw new Error('The payment service returned an invalid hosted checkout.'); }
  if (url.protocol !== 'https:' || !['mercadopago.com.ar', 'www.mercadopago.com.ar'].includes(url.hostname)
    || !url.pathname.startsWith('/checkout/')) throw new Error('The payment service returned an invalid hosted checkout.');
  return { order: body.order, checkoutUrl: url.toString() };
}

export function orderConfirmationUrl(publicOrderId) {
  return `/order.html?id=${encodeURIComponent(publicOrderId)}`;
}

export async function getPublicOrder(publicOrderId, { fetchImpl = fetch } = {}) {
  let response;
  try { response = await fetchImpl(`/api/public/orders/${encodeURIComponent(publicOrderId)}`); }
  catch { throw new Error('Could not connect to the store. Please retry.'); }
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new Error('The store returned an invalid response.');
  if (!response.ok) throw new Error(body.error || 'Could not load the order.');
  if (!body.order || typeof body.order.publicOrderId !== 'string') throw new Error('The store returned an invalid order.');
  return body.order;
}
