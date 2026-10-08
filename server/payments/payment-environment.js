export function resolveMercadoPagoEnvironment(environment = process.env) {
  const paymentEnvironment = environment.PAYMENT_ENV;
  if (!['test', 'production'].includes(paymentEnvironment)) throw new Error('PAYMENT_ENV must be test or production.');
  if (paymentEnvironment === 'production') return {
    environment: paymentEnvironment,
    publicKey: environment.MERCADOPAGO_PRODUCTION_PUBLIC_KEY || '',
    accessToken: environment.MERCADOPAGO_PRODUCTION_ACCESS_TOKEN || '',
    webhookSecret: environment.MP_PRODUCTION_WEBHOOK_SECRET || ''
  };
  return {
    environment: paymentEnvironment,
    publicKey: environment.MERCADOPAGO_TEST_PUBLIC_KEY || environment.MERCADOPAGO_PUBLIC_KEY || environment.MP_PUBLIC_KEY || '',
    accessToken: environment.MERCADOPAGO_TEST_ACCESS_TOKEN || environment.MERCADOPAGO_ACCESS_TOKEN || environment.MP_ACCESS_TOKEN || '',
    webhookSecret: environment.MP_TEST_WEBHOOK_SECRET || environment.MP_WEBHOOK_SECRET || ''
  };
}
