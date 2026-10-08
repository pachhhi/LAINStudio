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

function checkoutOrder(order) {
  return { id: order.id, publicOrderId: order.publicOrderId, total: order.total, currency: order.currency,
    status: order.status, createdAt: order.createdAt };
}

export function createApp({ orderRepository = new InMemoryOrderRepository(), paymentProvider = null, paymentPublicKey = '', paymentEnvironment = paymentProvider?.environment || 'test', webhookSecret = '', shippingProvider = null, catalogService = new CatalogService(), logger = console } = {}) {
  const app = express();
  const shippingService = new ShippingService({ catalogService, provider: shippingProvider });
  const orderService = new OrderService({ catalogService, orderRepository, paymentProvider, shippingService });
  app.locals.orderService = orderService;
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
    if (request.path.startsWith('/api')) response.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '32kb' }));

  const createOrder = async (request, response, next) => {
    try {
      const idempotencyKey = request.get('Idempotency-Key');
      if (!idempotencyKey) throw new ValidationError('Idempotency-Key header is required.');
      const order = await orderService.createWithShipping(request.body, { idempotencyKey });
      response.status(201).json({ order: checkoutOrder(order) });
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
      response.status(200).json({ order: checkoutOrder(order) });
    } catch (error) { next(error); }
  });
  app.get('/api/payments/config', (_request, response) => {
    const configured = paymentProvider?.name === 'mercadopago' && typeof paymentPublicKey === 'string' && paymentPublicKey.length > 0;
    response.json({ configured, provider: configured ? 'mercadopago' : 'none', environment: configured ? paymentEnvironment : 'disabled', publicKey: configured ? paymentPublicKey : '' });
  });
  app.post('/api/webhooks/mercadopago', async (request, response, next) => {
    try {
      const dataId = String(request.query['data.id'] || '');
      const valid = verifyMercadoPagoWebhook({ xSignature: request.get('x-signature'), xRequestId: request.get('x-request-id'), dataId, secret: webhookSecret });
      if (!valid) return response.status(401).json({ error: 'Invalid webhook signature.', code: 'INVALID_SIGNATURE' });
      if (request.body?.data?.id != null && String(request.body.data.id) !== dataId) return response.status(400).json({ error: 'Webhook order ID mismatch.', code: 'INVALID_WEBHOOK' });
      if (request.body?.type !== 'order') return response.sendStatus(200);
      if (request.query.type != null && String(request.query.type) !== 'order') {
        return response.status(400).json({ error: 'Webhook topic mismatch.', code: 'INVALID_WEBHOOK' });
      }
      const authenticatedSimulation = request.body?.live_mode === true && /^\d{1,20}$/.test(dataId)
        && typeof request.body?.action === 'string' && request.body.action.startsWith('order.');
      if (authenticatedSimulation) return response.status(202).json({ received: true, simulation: true });
      const validOrderId = paymentEnvironment === 'test' ? /^ORDTST[A-Z0-9]+$/.test(dataId) : /^ORD(?!TST)[A-Z0-9]+$/.test(dataId);
      if (!validOrderId) {
        return response.status(400).json({ error: `Invalid ${paymentEnvironment} order ID.`, code: 'INVALID_PROVIDER_ORDER_ID' });
      }
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
    if (status >= 500) logger.error('API request failed', { method: request.method, path: request.path, error: error.name || 'Error',
      code: error.code || 'INTERNAL_ERROR', ...(error.providerStatus ? { providerStatus: error.providerStatus } : {}),
      ...(error.providerError ? { providerError: error.providerError } : {}),
      ...(error.providerMessage ? { providerMessage: error.providerMessage } : {}),
      ...(error.providerCause?.length ? { providerCause: error.providerCause } : {}),
      ...(error.statusDetail ? { statusDetail: error.statusDetail } : {}),
      ...(error.providerRequestId ? { providerRequestId: error.providerRequestId } : {}),
      ...(error.orderId ? { orderId: error.orderId } : {}), ...(error.paymentAttemptId ? { paymentAttemptId: error.paymentAttemptId } : {}),
      ...(error.providerPaymentId ? { providerPaymentId: error.providerPaymentId } : {}) });
    const message = malformedJson ? 'Invalid JSON request.' : (error.expose ? error.message : 'Internal server error.');
    response.status(status).json({ error: message, code: malformedJson ? 'INVALID_JSON' : (error.code || 'INTERNAL_ERROR'),
      ...(error.statusDetail ? { statusDetail: error.statusDetail } : {}),
      ...(!error.statusDetail && error.providerCause?.[0]?.description ? { statusDetail: error.providerCause[0].description } : {}),
      ...(!error.statusDetail && !error.providerCause?.[0]?.description && error.providerMessage ? { statusDetail: error.providerMessage } : {}) });
  });
  return app;
}
