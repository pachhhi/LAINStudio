import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CatalogService } from './catalog/catalog-service.js';
import { InMemoryOrderRepository } from './orders/order-repository.js';
import { OrderService } from './orders/order-service.js';
import { ValidationError } from './errors.js';
import { verifyMercadoPagoWebhook } from './payments/mercadopago-webhook.js';
import { ShippingService } from './shipping/shipping-service.js';

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function createApp({ orderRepository = new InMemoryOrderRepository(), paymentProvider = null, paymentPublicKey = '', webhookSecret = '', shippingProvider = null, catalogService = new CatalogService(), logger = console } = {}) {
  const app = express();
  const shippingService = new ShippingService({ catalogService, provider: shippingProvider });
  const orderService = new OrderService({ catalogService, orderRepository, paymentProvider, shippingService });
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (request.path.startsWith('/api')) response.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '32kb' }));

  const createOrder = async (request, response, next) => {
    try {
      const idempotencyKey = request.get('Idempotency-Key');
      if (!idempotencyKey) throw new ValidationError('Idempotency-Key header is required.');
      const order = await orderService.createWithShipping(request.body, { idempotencyKey });
      response.status(201).json({ order });
    } catch (error) { next(error); }
  };
  app.post('/api/checkout', createOrder);
  app.post('/api/shipping/quotes', async (request, response, next) => {
    try { response.json(await shippingService.quote(request.body)); }
    catch (error) { next(error); }
  });
  app.get('/api/public/orders/:publicOrderId', async (request, response, next) => {
    try {
    const order = await orderService.getPublicById(request.params.publicOrderId);
    if (!order) return response.status(404).json({ error: 'Order not found.' });
    response.json({ order });
    } catch (error) { next(error); }
  });
  app.post('/api/orders/:id/payments', async (request, response, next) => {
    try {
      const order = await orderService.startPayment(request.params.id, { idempotencyKey: request.get('Idempotency-Key'), paymentData: request.body });
      response.status(200).json({ order });
    } catch (error) { next(error); }
  });
  app.get('/api/payments/config', (_request, response) => response.json({ provider: paymentProvider?.name || 'none', environment: paymentProvider ? 'test' : 'disabled', publicKey: paymentProvider ? paymentPublicKey : '' }));
  app.post('/api/webhooks/mercadopago', async (request, response, next) => {
    try {
      const dataId = String(request.query['data.id'] || '');
      const valid = verifyMercadoPagoWebhook({ xSignature: request.get('x-signature'), xRequestId: request.get('x-request-id'), dataId, secret: webhookSecret });
      if (!valid) return response.status(401).json({ error: 'Invalid webhook signature.', code: 'INVALID_SIGNATURE' });
      if (request.body?.data?.id != null && String(request.body.data.id) !== dataId) return response.status(400).json({ error: 'Webhook payment ID mismatch.', code: 'INVALID_WEBHOOK' });
      if (request.body?.live_mode === true) return response.status(403).json({ error: 'Production webhooks are disabled.', code: 'LIVE_MODE_DISABLED' });
      if (request.body?.type && request.body.type !== 'payment') return response.sendStatus(200);
      const order = await orderService.reconcileProviderPayment(dataId);
      response.status(order ? 200 : 202).json({ received: true });
    } catch (error) { next(error); }
  });
  app.use(['/server', '/test', '/scripts', '/ops', '/package.json', '/package-lock.json'], (_request, response) => response.sendStatus(404));
  app.use('/img/outfit', (request, response, next) => request.path.endsWith('.png') ? response.sendStatus(404) : next());
  app.use('/img/lain-bg-skyline-header.png', (_request, response) => response.sendStatus(404));
  app.use(express.static(rootDirectory, { extensions: ['html'] }));
  app.use('/api', (_request, response) => response.status(404).json({ error: 'API endpoint not found.' }));
  app.use((_request, response) => response.status(404).sendFile(resolve(rootDirectory, '404.html')));
  app.use((error, request, response, next) => {
    if (!request.path.startsWith('/api')) return next(error);
    const malformedJson = error instanceof SyntaxError && error.status === 400 && 'body' in error;
    const status = malformedJson ? 400 : (Number.isInteger(error.status) ? error.status : 500);
    if (status >= 500) logger.error('API request failed', { method: request.method, path: request.path, error: error.message,
      code: error.code || 'INTERNAL_ERROR', ...(error.providerStatus ? { providerStatus: error.providerStatus } : {}),
      ...(error.orderId ? { orderId: error.orderId } : {}), ...(error.paymentAttemptId ? { paymentAttemptId: error.paymentAttemptId } : {}),
      ...(error.providerPaymentId ? { providerPaymentId: error.providerPaymentId } : {}) });
    const message = malformedJson ? 'Invalid JSON request.' : (error.expose ? error.message : 'Internal server error.');
    response.status(status).json({ error: message, code: malformedJson ? 'INVALID_JSON' : (error.code || 'INTERNAL_ERROR') });
  });
  return app;
}
