import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMercadoPagoEnvironment } from '../server/payments/payment-environment.js';

test('test environment prefers explicit TEST credentials and preserves legacy compatibility', () => {
  assert.deepEqual(resolveMercadoPagoEnvironment({ PAYMENT_ENV: 'test', MERCADOPAGO_TEST_PUBLIC_KEY: 'test-public',
    MERCADOPAGO_TEST_ACCESS_TOKEN: 'test-token', MP_TEST_WEBHOOK_SECRET: 'test-secret',
    MERCADOPAGO_PRODUCTION_PUBLIC_KEY: 'prod-public', MERCADOPAGO_PRODUCTION_ACCESS_TOKEN: 'prod-token' }), {
    environment: 'test', publicKey: 'test-public', accessToken: 'test-token', webhookSecret: 'test-secret'
  });
  assert.equal(resolveMercadoPagoEnvironment({ PAYMENT_ENV: 'test', MERCADOPAGO_PUBLIC_KEY: 'legacy-public' }).publicKey, 'legacy-public');
});

test('production environment selects only production credentials and never falls back to TEST', () => {
  assert.deepEqual(resolveMercadoPagoEnvironment({ PAYMENT_ENV: 'production', MERCADOPAGO_PRODUCTION_PUBLIC_KEY: 'prod-public',
    MERCADOPAGO_PRODUCTION_ACCESS_TOKEN: 'prod-token', MP_PRODUCTION_WEBHOOK_SECRET: 'prod-secret',
    MERCADOPAGO_PUBLIC_KEY: 'test-public', MERCADOPAGO_ACCESS_TOKEN: 'test-token', MP_WEBHOOK_SECRET: 'test-secret' }), {
    environment: 'production', publicKey: 'prod-public', accessToken: 'prod-token', webhookSecret: 'prod-secret'
  });
  assert.deepEqual(resolveMercadoPagoEnvironment({ PAYMENT_ENV: 'production', MERCADOPAGO_PUBLIC_KEY: 'test-public',
    MERCADOPAGO_ACCESS_TOKEN: 'test-token', MP_WEBHOOK_SECRET: 'test-secret' }), {
    environment: 'production', publicKey: '', accessToken: '', webhookSecret: ''
  });
  assert.throws(() => resolveMercadoPagoEnvironment({ PAYMENT_ENV: 'staging' }), /test or production/);
});
