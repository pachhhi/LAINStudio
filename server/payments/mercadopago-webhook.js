import { createHmac, timingSafeEqual } from 'node:crypto';

function parseSignature(value) {
  if (typeof value !== 'string') return null;
  const parts = Object.fromEntries(value.split(',').map(part => part.trim().split('=', 2)));
  return parts.ts && /^[a-f0-9]{64}$/i.test(parts.v1 || '') ? parts : null;
}

export function verifyMercadoPagoWebhook({ xSignature, xRequestId, dataId, secret }) {
  if (typeof secret !== 'string' || !secret || typeof xRequestId !== 'string' || !xRequestId || typeof dataId !== 'string' || !dataId) return false;
  const signature = parseSignature(xSignature);
  if (!signature) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${xRequestId};ts:${signature.ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest();
  const received = Buffer.from(signature.v1, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
