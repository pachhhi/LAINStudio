import test from 'node:test';
import assert from 'node:assert/strict';
import { CartService } from '../cart-service.js';

const catalog = [{ id: 'one', available: true, variants: [{ id: 'M', available: true }], colors: ['Black'] }];

test('cart service validates persisted entries and owns quantity changes', () => {
  let saved;
  const store = {
    load: () => [{ productId: 'missing', quantity: 2 }, { productId: 'one', variantId: 'M', color: 'Black', quantity: 2 }],
    save: items => { saved = structuredClone(items); }, clear: () => {}
  };
  const cart = new CartService({ catalog, store });
  assert.equal(cart.getCount(), 2);
  cart.add({ productId: 'one', variantId: 'M', color: 'Black', quantity: 9 });
  assert.equal(cart.getCount(), 10);
  cart.changeQuantity(0, -1);
  assert.equal(cart.getCount(), 9);
  assert.deepEqual(saved, cart.getItems());
});
