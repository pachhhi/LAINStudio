import { EnviopackProvider } from '../server/shipping/enviopack-provider.js';

const provider = new EnviopackProvider({
  apiKey: process.env.ENVIOPACK_API_KEY,
  secretKey: process.env.ENVIOPACK_SECRET_KEY,
  enabled: process.env.ENVIOPACK_ENABLED === 'true'
});

if (!provider.isConfigured()) {
  console.error('Enviopack is not configured.');
  process.exitCode = 1;
} else {
  try {
    const methods = await provider.quoteHomeDelivery({
      province: 'B',
      postalCode: '1722',
      weightKg: 0.5,
      packages: [{ heightCm: 10, widthCm: 20, lengthCm: 30 }]
    });
    console.log(JSON.stringify({ configured: true, postalCode: '1722', province: 'B', methods }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ configured: true, code: error.code, providerStatus: error.providerStatus, message: error.message }));
    process.exitCode = 1;
  }
}
