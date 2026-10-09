import { createApp } from './app.js';
import { PostgresOrderRepository } from './orders/postgres-order-repository.js';
import { MercadoPagoProvider } from './payments/mercadopago-provider.js';
import { EnviopackProvider } from './shipping/enviopack-provider.js';
import { PaymentReconciler } from './payments/payment-reconciler.js';
import { resolveMercadoPagoEnvironment } from './payments/payment-environment.js';

const port = Number.parseInt(process.env.PORT || '3000', 10);
const host = process.env.HOST || '0.0.0.0';
const databaseUrl = process.env.DATABASE_URL;

async function start() {
  const orderRepository = PostgresOrderRepository.fromConnectionString(databaseUrl);
  try { await orderRepository.healthCheck(); }
  catch (error) {
    console.error(`LAIN Store startup failed: PostgreSQL is unavailable (${error.code || error.name}).`);
    await orderRepository.close().catch(() => {});
    process.exitCode = 1;
    return;
  }
  let paymentProvider = null;
  let paymentEnvironment = process.env.PAYMENT_ENV;
  let mercadoPagoPublicKey = '';
  let mercadoPagoAccessToken = '';
  let webhookSecret = '';
  const shippingProvider = new EnviopackProvider({ apiKey: process.env.ENVIOPACK_API_KEY, secretKey: process.env.ENVIOPACK_SECRET_KEY,
    enabled: process.env.ENVIOPACK_ENABLED === 'true' });
  try {
    if (process.env.PAYMENT_PROVIDER === 'mercadopago') {
      ({ environment: paymentEnvironment, publicKey: mercadoPagoPublicKey, accessToken: mercadoPagoAccessToken,
        webhookSecret } = resolveMercadoPagoEnvironment(process.env));
      if (!mercadoPagoPublicKey) throw new Error('Mercado Pago public key is required.');
      if (paymentEnvironment === 'production' && !webhookSecret) throw new Error('Mercado Pago production webhook secret is required.');
      paymentProvider = new MercadoPagoProvider({ accessToken: mercadoPagoAccessToken, environment: process.env.PAYMENT_ENV });
    } else if (process.env.PAYMENT_PROVIDER !== 'none') throw new Error('Unsupported payment provider.');
  } catch (error) {
    console.error(`LAIN Store startup failed: ${error.message}`); await orderRepository.close(); process.exitCode = 1; return;
  }
  const app = createApp({ orderRepository, paymentProvider, paymentPublicKey: mercadoPagoPublicKey,
    paymentEnvironment, webhookSecret, publicBaseUrl: process.env.PUBLIC_BASE_URL || '', shippingProvider });
  const reconciler = paymentProvider ? new PaymentReconciler({ orderRepository, orderService: app.locals.orderService, paymentProvider }) : null;
  const server = app.listen(port, host, () => {
    console.log(`LAIN Store listening on ${host}:${port} (${paymentProvider ? `mercadopago ${paymentEnvironment}` : 'payments disabled'}, ${shippingProvider.isConfigured() ? 'enviopack enabled' : 'shipping disabled'})`);
    reconciler?.start();
  });
  const shutdown = () => server.close(() => Promise.resolve(reconciler?.stop()).then(() => orderRepository.close()).finally(() => process.exit(0)));
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}

start();
