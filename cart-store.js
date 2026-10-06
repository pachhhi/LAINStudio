const CART_STORAGE_KEY = 'lain-store-cart-v1';

export class CartStore {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  load() {
    try {
      const value = JSON.parse(this.storage.getItem(CART_STORAGE_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  save(items) {
    try {
      this.storage.setItem(CART_STORAGE_KEY, JSON.stringify(items));
      return true;
    } catch {
      return false;
    }
  }

  clear() {
    try {
      this.storage.removeItem(CART_STORAGE_KEY);
    } catch {
      // A disabled storage mechanism should not break checkout completion.
    }
  }
}

export { CART_STORAGE_KEY };
