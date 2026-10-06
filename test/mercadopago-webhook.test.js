import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyMercadoPagoWebhook } from '../server/payments/mercadopago-webhook.js';

function signature({ dataId = 'PAYMENT01', requestId = 'request-1', timestamp = '1704908010', secret = 'webhook-secret' } = {}) {
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${timestamp};`;
  return `ts=${timestamp},v1=${createHmac('sha256', secret).update(manifest).digest('hex')}`;
}

test('validates official Mercado Pago HMAC manifest', () => {
  assert.equal(verifyMercadoPagoWebhook({ xSignature: signature(), xRequestId: 'request-1', dataId: 'PAYMENT01', secret: 'webhook-secret' }), true);
});

test('rejects invalid, malformed and incomplete webhook signatures', () => {
  assert.equal(verifyMercadoPagoWebhook({ xSignature: signature(), xRequestId: 'changed', dataId: 'PAYMENT01', secret: 'webhook-secret' }), false);
  assert.equal(verifyMercadoPagoWebhook({ xSignature: 'bad', xRequestId: 'x', dataId: 'x', secret: 'x' }), false);
  assert.equal(verifyMercadoPagoWebhook({ xSignature: signature(), xRequestId: '', dataId: 'PAYMENT01', secret: 'webhook-secret' }), false);
});

export { signature };
