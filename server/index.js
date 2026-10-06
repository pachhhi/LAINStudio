import { createApp } from './app.js';
import { PostgresOrderRepository } from './orders/postgres-order-repository.js';
import { MercadoPagoProvider } from './payments/mercadopago-provider.js';
import { EnviopackProvider } from './shipping/enviopack-provider.js';

const port = Number.parseInt(process.env.PORT || '3000', 10);
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
  const shippingProvider = new EnviopackProvider({ apiKey: process.env.ENVIOPACK_API_KEY, secretKey: process.env.ENVIOPACK_SECRET_KEY,
    enabled: process.env.ENVIOPACK_ENABLED === 'true' });
  try {
    if (process.env.PAYMENT_PROVIDER === 'mercadopago') {
      if (!process.env.MP_PUBLIC_KEY || !process.env.MP_WEBHOOK_SECRET) throw new Error('Mercado Pago public key and webhook secret are required.');
      paymentProvider = new MercadoPagoProvider({ accessToken: process.env.MP_ACCESS_TOKEN, environment: process.env.PAYMENT_ENV,
        notificationUrl: process.env.MP_NOTIFICATION_URL });
    } else if (process.env.PAYMENT_PROVIDER !== 'none') throw new Error('Unsupported payment provider.');
  } catch (error) {
    console.error(`LAIN Store startup failed: ${error.message}`); await orderRepository.close(); process.exitCode = 1; return;
  }
  const server = createApp({ orderRepository, paymentProvider, paymentPublicKey: process.env.MP_PUBLIC_KEY,
    webhookSecret: process.env.MP_WEBHOOK_SECRET, shippingProvider }).listen(port, () => console.log(`LAIN Store running at http://localhost:${port} (${paymentProvider ? 'mercadopago test' : 'payments disabled'}, ${shippingProvider.isConfigured() ? 'enviopack enabled' : 'shipping disabled'})`));
  const shutdown = () => server.close(() => orderRepository.close().finally(() => process.exit(0)));
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}

start();
