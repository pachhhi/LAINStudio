import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { CatalogService } from '../server/catalog/catalog-service.js';
import { createApp } from '../server/app.js';
import { EnviopackProvider, EnviopackProviderError } from '../server/shipping/enviopack-provider.js';
import { ShippingService } from '../server/shipping/shipping-service.js';

const product = { id: 'shirt', available: true, price: 1000, currency: 'ARS',
  shipping: { weightKg: 0.25, widthCm: 20, heightCm: 3, lengthCm: 30 } };
const payload = { postalCode: '1722', province: 'Buenos Aires', cart: [{ productId: 'shirt', quantity: 2 }] };
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('provider reports configured state without making requests', () => {
  assert.equal(new EnviopackProvider().isConfigured(), false);
  assert.equal(new EnviopackProvider({ enabled: true, apiKey: 'key', secretKey: 'secret' }).isConfigured(), true);
});

test('provider authenticates, caches the token and normalizes home delivery quotes', async () => {
  const calls = [];
  const provider = new EnviopackProvider({ enabled: true, apiKey: 'key', secretKey: 'secret', clock: () => 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/auth')) return response(200, { token: 'token', refresh_token: 'refresh' });
      return response(200, [{ correo: 'enviopack', modalidad: 'D', servicio: 'N', valor: 1234.50, horas_entrega: 72,
        fecha_promesa_entrega: '1969-12-31T00:00:00-0300' }]);
    } });
  const input = { province: 'B', postalCode: '1722', weightKg: 0.5, packages: [{ widthCm: 20, heightCm: 3, lengthCm: 30 }] };
  const methods = await provider.quoteHomeDelivery(input);
  await provider.quoteHomeDelivery(input);
  assert.equal(calls.filter(call => call.url.endsWith('/auth')).length, 1);
  assert.match(calls[1].url, /provincia=B/); assert.match(calls[1].url, /peso=0.5/); assert.match(calls[1].url, /paquetes=3x20x30/);
  assert.deepEqual(methods, [{ id: 'enviopack-N-D-0', name: 'Standard', carrier: 'enviopack', price: 1234.5, estimatedHours: 72 }]);
  assert.equal(calls[0].options.body, 'api-key=key&secret-key=secret');
});

test('provider surfaces authentication and quote failures safely', async () => {
  const authFailure = new EnviopackProvider({ enabled: true, apiKey: 'key', secretKey: 'secret', fetchImpl: async () => response(401, {}) });
  await assert.rejects(authFailure.authenticate(), error => error instanceof EnviopackProviderError && error.providerStatus === 401 && error.code === 'shipping_auth_failed');
  let calls = 0;
  const quoteFailure = new EnviopackProvider({ enabled: true, apiKey: 'key', secretKey: 'secret', fetchImpl: async () => {
    calls += 1; return calls === 1 ? response(200, { token: 'token', refresh_token: 'refresh' }) : response(500, {});
  } });
  await assert.rejects(quoteFailure.quoteHomeDelivery({ province: 'B', postalCode: '1722', weightKg: 1,
    packages: [{ widthCm: 1, heightCm: 1, lengthCm: 1 }] }), error => error instanceof EnviopackProviderError && error.providerStatus === 500 && error.code === 'shipping_quote_failed');
});

test('shipping service handles unconfigured provider, validation and catalog failures', async () => {
  const catalogService = new CatalogService([product, { ...product, id: 'missing-metadata', shipping: null }]);
  const unavailable = new ShippingService({ catalogService, provider: null });
  assert.deepEqual(await unavailable.quote(payload), { available: false, reason: 'shipping_provider_not_configured', methods: [] });
  const provider = { isConfigured: () => true, quoteHomeDelivery: async () => [] };
  const service = new ShippingService({ catalogService, provider });
  await assert.rejects(service.quote({ ...payload, postalCode: 'ABC' }), error => error.code === 'shipping_invalid_destination');
  await assert.rejects(service.quote({ ...payload, cart: [] }), /cart/);
  await assert.rejects(service.quote({ ...payload, cart: [{ productId: 'unknown', quantity: 1 }] }), /unavailable/);
  await assert.rejects(service.quote({ ...payload, cart: [{ productId: 'missing-metadata', quantity: 1 }] }), error => error.code === 'shipping_product_missing_dimensions');
});

test('shipping service derives logistics from server catalog and ignores client price and dimensions', async () => {
  let providerInput;
  const provider = { isConfigured: () => true, quoteHomeDelivery: async input => { providerInput = input; return [{ id: 'method' }]; } };
  const service = new ShippingService({ catalogService: new CatalogService([product]), provider });
  const result = await service.quote({ ...payload, cart: [{ productId: 'shirt', quantity: 2, price: 1, weightKg: 99,
    shipping: { weightKg: 99, widthCm: 99, heightCm: 99, lengthCm: 99 } }] });
  assert.equal(result.available, true); assert.equal(providerInput.weightKg, 0.5);
  assert.deepEqual(providerInput.packages, [
    { widthCm: 20, heightCm: 3, lengthCm: 30 }, { widthCm: 20, heightCm: 3, lengthCm: 30 }
  ]);
});

test('shipping service rejects variants and colors that checkout would reject', async () => {
  const provider = { isConfigured: () => true, quoteHomeDelivery: async () => [] };
  const catalogService = new CatalogService([{ id: 'tee', name: 'Tee', price: 1000, currency: 'ARS', available: true,
    variants: [{ id: 'M', available: true }], colors: ['Black'], shipping: { weightKg: 0.3, widthCm: 20, heightCm: 5, lengthCm: 25 } }]);
  const service = new ShippingService({ catalogService, provider });
  await assert.rejects(service.quote({ postalCode: '1722', province: 'Buenos Aires', cart: [{ productId: 'tee', variantId: 'XL', color: 'Black', quantity: 1 }] }), /valid variant/);
  await assert.rejects(service.quote({ postalCode: '1722', province: 'Buenos Aires', cart: [{ productId: 'tee', variantId: 'M', color: 'White', quantity: 1 }] }), /valid color/);
});

test('shipping quote endpoint returns normalized availability and validation errors', async () => {
  const catalogService = new CatalogService([product]);
  const disabled = await request(createApp({ catalogService })).post('/api/shipping/quotes').send(payload).expect(200);
  assert.equal(disabled.body.reason, 'shipping_provider_not_configured');
  const shippingProvider = { isConfigured: () => true, quoteHomeDelivery: async () => [{ id: 'x', name: 'Standard', carrier: 'OCA', price: 100, estimatedHours: null }] };
  const quoted = await request(createApp({ catalogService, shippingProvider })).post('/api/shipping/quotes').send(payload).expect(200);
  assert.deepEqual(quoted.body.methods, [{ id: 'x', name: 'Standard', carrier: 'OCA', price: 100, estimatedHours: null }]);
  await request(createApp({ catalogService, shippingProvider })).post('/api/shipping/quotes').send({ ...payload, postalCode: '12' }).expect(400);
});
