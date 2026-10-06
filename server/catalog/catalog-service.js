import { products } from '../../products.js';
import { ValidationError } from '../errors.js';

export class CatalogService {
  constructor(catalog = products) { this.catalog = catalog; }
  getById(id) {
    return this.catalog.find(product => product.id === id);
  }

  resolveItem(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Each item must be an object.');
    if (typeof input.productId !== 'string' || !input.productId) throw new ValidationError('A valid productId is required.');
    const product = this.getById(input.productId);
    if (!product || product.available === false) throw new ValidationError(`Product ${input.productId} is unavailable.`);
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 10) throw new ValidationError('Quantity must be an integer between 1 and 10.');
    if (!Number.isSafeInteger(product.price) || product.price < 0) throw new ValidationError(`Product ${product.id} does not have a purchasable integer price.`);

    const variants = product.variants?.length
      ? product.variants
      : (product.sizes || []).map(size => ({ id: size, size, available: true }));
    const variant = variants.length ? variants.find(candidate => candidate.id === input.variantId && candidate.available !== false) : null;
    if (variants.length && !variant) throw new ValidationError(`Select a valid variant for ${product.id}.`);
    if (input.color != null && typeof input.color !== 'string') throw new ValidationError('Color must be a string.');
    if (input.color && product.colors?.length && !product.colors.includes(input.color)) throw new ValidationError(`Select a valid color for ${product.id}.`);
    const lineTotal = product.price * input.quantity;
    if (!Number.isSafeInteger(lineTotal)) throw new ValidationError('Order amount exceeds the supported range.');

    return {
      productId: product.id,
      name: product.name,
      quantity: input.quantity,
      unitPrice: product.price,
      lineTotal,
      ...(variant ? { variantId: variant.id } : {}),
      ...(input.color ? { color: input.color } : {})
    };
  }
}
