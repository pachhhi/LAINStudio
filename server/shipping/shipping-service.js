import { AppError, ValidationError } from '../errors.js';

class ShippingValidationError extends AppError {
  constructor(message, code) { super(message, { status: 400, code }); }
}

const PROVINCES = Object.freeze({
  'buenos aires': 'B', 'ciudad autonoma de buenos aires': 'C', caba: 'C', catamarca: 'K', chaco: 'H', chubut: 'U',
  cordoba: 'X', corrientes: 'W', 'entre rios': 'E', formosa: 'P', jujuy: 'Y', 'la pampa': 'L', 'la rioja': 'F',
  mendoza: 'M', misiones: 'N', neuquen: 'Q', 'rio negro': 'R', salta: 'A', 'san juan': 'J', 'san luis': 'D',
  'santa cruz': 'Z', 'santa fe': 'S', 'santiago del estero': 'G', 'tierra del fuego': 'V', tucuman: 'T'
});

const normalizeText = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export class ShippingService {
  constructor({ catalogService, provider }) { this.catalogService = catalogService; this.provider = provider; }

  async quote(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ValidationError('Request payload must be an object.');
    const postalCode = typeof payload.postalCode === 'string' ? payload.postalCode.trim() : '';
    if (!/^\d{4}$/.test(postalCode)) throw new ShippingValidationError('A valid 4-digit postal code is required.', 'shipping_invalid_destination');
    const province = typeof payload.province === 'string' ? PROVINCES[normalizeText(payload.province)] : null;
    if (!province) throw new ShippingValidationError('A valid Argentine province is required.', 'shipping_invalid_destination');
    if (!Array.isArray(payload.cart) || payload.cart.length === 0 || payload.cart.length > 50) {
      throw new ValidationError('The cart must contain between 1 and 50 items.');
    }
    if (!this.provider?.isConfigured()) return { available: false, reason: 'shipping_provider_not_configured', methods: [] };
    const packages = [];
    let weightKg = 0;
    for (const item of payload.cart) {
      const resolved = this.catalogService.resolveItem(item);
      const product = this.catalogService.getById(resolved.productId);
      const shipping = product.shipping;
      if (!shipping || ![shipping.weightKg, shipping.widthCm, shipping.heightCm, shipping.lengthCm]
        .every(value => Number.isFinite(value) && value > 0)) {
        throw new ShippingValidationError(`Product ${product.id} does not have shipping metadata.`, 'shipping_product_missing_dimensions');
      }
      weightKg += shipping.weightKg * resolved.quantity;
      for (let count = 0; count < resolved.quantity; count += 1) packages.push({
        widthCm: shipping.widthCm, heightCm: shipping.heightCm, lengthCm: shipping.lengthCm
      });
    }
    const methods = await this.provider.quoteHomeDelivery({ province, postalCode, weightKg, packages });
    return { available: true, methods };
  }

  async select(payload, methodId) {
    if (typeof methodId !== 'string' || !methodId) throw new ShippingValidationError('Select a valid shipping method.', 'shipping_method_invalid');
    const result = await this.quote(payload);
    if (!result.available) throw new ShippingValidationError('Shipping rates are not available.', 'shipping_provider_not_configured');
    const method = result.methods.find(candidate => candidate.id === methodId);
    if (!method) throw new ShippingValidationError('The selected shipping method is no longer available.', 'shipping_method_invalid');
    return { provider: this.provider.name || 'shipping-provider', ...method };
  }
}

export { PROVINCES };
