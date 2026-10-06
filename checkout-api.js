export async function createCheckout(items, customer, { deliveryAddress, shippingMethodId, idempotencyKey, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl('/api/checkout', {
    method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ items, customer, deliveryAddress, shippingMethodId }),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The checkout request timed out. Please retry.');
    throw new Error('Could not connect to the store. Please retry.');
  } finally { clearTimeout(timeout); }
  const body = await response.json().catch(() => null);
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
