const MAX_QUANTITY = 10;

export class CartService {
  constructor({ catalog, store }) {
    this.catalog = catalog;
    this.store = store;
    this.items = this.validate(store.load());
    this.store.save(this.items);
  }

  validate(items) {
    return items.filter(item => {
      const product = this.catalog.find(product => product.id === item.productId);
      if (!product || product.available === false || !Number.isInteger(item.quantity) || item.quantity < 1) return false;
      const variants = product.variants?.length
        ? product.variants
        : (product.sizes || []).map(size => ({ id: size, available: true }));
      if (variants.length && !variants.some(variant => variant.id === (item.variantId || item.size) && variant.available !== false)) return false;
      return !item.color || !product.colors?.length || product.colors.includes(item.color);
    }).map(item => ({
      productId: item.productId,
      quantity: Math.min(item.quantity, MAX_QUANTITY),
      ...(item.variantId || item.size ? { variantId: item.variantId || item.size } : {}),
      ...(item.color ? { color: item.color } : {})
    }));
  }

  getItems() { return this.items.map(item => ({ ...item })); }
  getCount() { return this.items.reduce((total, item) => total + item.quantity, 0); }

  add({ productId, variantId, color, quantity = 1 }) {
    const candidate = this.validate([{ productId, variantId, color, quantity }]);
    if (!candidate.length) throw new TypeError('Invalid cart item.');
    ({ productId, variantId, color, quantity } = candidate[0]);
    const key = item => item.productId === productId && (item.variantId || '') === (variantId || '') && (item.color || '') === (color || '');
    const existing = this.items.find(key);
    if (existing) existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + quantity);
    else this.items.push({ productId, quantity: Math.min(MAX_QUANTITY, quantity), ...(variantId ? { variantId } : {}), ...(color ? { color } : {}) });
    this.persist();
  }

  changeQuantity(index, amount) {
    if (!this.items[index]) return;
    this.items[index].quantity += amount;
    if (this.items[index].quantity < 1) this.items.splice(index, 1);
    else this.items[index].quantity = Math.min(MAX_QUANTITY, this.items[index].quantity);
    this.persist();
  }

  remove(index) {
    if (this.items[index]) this.items.splice(index, 1);
    this.persist();
  }

  clear() { this.items = []; this.store.clear(); }
  persist() { this.store.save(this.items); }
}
