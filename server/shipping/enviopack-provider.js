import { DependencyError, ValidationError } from '../errors.js';

const SERVICE_NAMES = Object.freeze({ N: 'Standard', P: 'Priority', X: 'Express', R: 'Returns' });

export class EnviopackProviderError extends DependencyError {
  constructor(message, { providerStatus = null, code = 'shipping_invalid_provider_response' } = {}) {
    super(message);
    this.code = code;
    this.providerStatus = providerStatus;
  }
}

export class EnviopackProvider {
  constructor({ apiKey = '', secretKey = '', enabled = false, fetchImpl = fetch, timeoutMs = 15000,
    baseUrl = 'https://api.enviopack.com', clock = () => Date.now() } = {}) {
    this.name = 'enviopack';
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.enabled = enabled === true;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
    this.clock = clock;
    this.token = null;
  }

  isConfigured() {
    return this.enabled && typeof this.apiKey === 'string' && this.apiKey.length > 0
      && typeof this.secretKey === 'string' && this.secretKey.length > 0;
  }

  async authenticate() {
    if (!this.isConfigured()) throw new EnviopackProviderError('Enviopack is not configured.', { code: 'shipping_auth_failed' });
    if (this.token && this.token.expiresAt > this.clock()) return this.token.value;
    const body = new URLSearchParams({ 'api-key': this.apiKey, 'secret-key': this.secretKey });
    const payload = await this.request('/auth', { method: 'POST', body, errorCode: 'shipping_auth_failed' });
    const accessToken = payload.token || payload.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new EnviopackProviderError('Enviopack returned a malformed authentication response.', { code: 'shipping_invalid_provider_response' });
    }
    const expiresInSeconds = Number.isFinite(Number(payload.expires_in)) ? Number(payload.expires_in) : 4 * 60 * 60;
    this.token = { value: accessToken, expiresAt: this.clock() + Math.max(0, expiresInSeconds - 60) * 1000 };
    return this.token.value;
  }

  async quoteHomeDelivery({ province, postalCode, weightKg, packages }) {
    if (typeof province !== 'string' || !province) throw new ValidationError('A valid province is required.');
    if (typeof postalCode !== 'string' || !/^\d{4}$/.test(postalCode)) throw new ValidationError('A valid 4-digit postal code is required.');
    if (!Number.isFinite(weightKg) || weightKg <= 0) throw new ValidationError('A valid shipping weight is required.');
    if (!Array.isArray(packages) || packages.length === 0) throw new ValidationError('At least one package is required.');
    const dimensions = packages.map(item => {
      if (![item.heightCm, item.widthCm, item.lengthCm].every(value => Number.isFinite(value) && value > 0)) {
        throw new ValidationError('Valid package dimensions are required.');
      }
      return `${item.heightCm}x${item.widthCm}x${item.lengthCm}`;
    }).join(',');
    const accessToken = await this.authenticate();
    const query = new URLSearchParams({ access_token: accessToken, provincia: province,
      codigo_postal: postalCode, peso: String(weightKg), paquetes: dimensions });
    const payload = await this.request(`/cotizar/precio/a-domicilio?${query}`, { errorCode: 'shipping_quote_failed' });
    if (!Array.isArray(payload)) throw new EnviopackProviderError('Enviopack returned a malformed quote response.', { code: 'shipping_invalid_provider_response' });
    return payload.map((quote, index) => normalizeQuote(quote, index));
  }

  async request(path, { method = 'GET', body, errorCode = 'shipping_quote_failed' } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, signal: controller.signal,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(body ? { body: body.toString() } : {}) });
    } catch (error) {
      throw new EnviopackProviderError(error?.name === 'AbortError' ? 'Enviopack request timed out.' : 'Enviopack network request failed.', { code: errorCode });
    } finally { clearTimeout(timeout); }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new EnviopackProviderError('Enviopack rejected the request.', { providerStatus: response.status, code: errorCode });
    if (payload == null || typeof payload !== 'object') throw new EnviopackProviderError('Enviopack returned a malformed response.', { code: 'shipping_invalid_provider_response' });
    return payload;
  }
}

function normalizeQuote(quote, index) {
  const price = Number(quote?.valor);
  if (!quote || typeof quote !== 'object' || !Number.isFinite(price) || price < 0) {
    throw new EnviopackProviderError('Enviopack returned a malformed shipping method.', { code: 'shipping_invalid_provider_response' });
  }
  const carrierId = typeof quote.correo === 'string' && quote.correo ? quote.correo
    : (quote.correo?.id ? String(quote.correo.id) : 'enviopack');
  const carrier = typeof quote.correo === 'string' && quote.correo ? quote.correo
    : (quote.correo?.nombre ? String(quote.correo.nombre) : 'Enviopack');
  const service = typeof quote.servicio === 'string' ? quote.servicio : '';
  return {
    id: [carrierId, service || 'service', quote.modalidad || 'D', index].join('-'),
    name: SERVICE_NAMES[service] || service || 'Home delivery',
    carrier,
    price,
    estimatedHours: Number.isFinite(Number(quote.horas_entrega)) ? Number(quote.horas_entrega) : null
  };
}
