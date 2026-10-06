import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryOrderRepository } from '../server/orders/order-repository.js';

const order = { id: 'one', publicOrderId: 'public-one', status: 'pending', customer: { name: 'A' }, items: [{ quantity: 1 }], version: 1 };

test('repository clones writes, reads and updates without mutation leaks', () => {
  const repository = new InMemoryOrderRepository(); const saved = repository.save(order);
  order.customer.name = 'mutated'; saved.items[0].quantity = 99;
  assert.equal(repository.findById('one').customer.name, 'A'); assert.equal(repository.findById('one').items[0].quantity, 1);
  const read = repository.findById('one'); read.status = 'paid'; assert.equal(repository.findById('one').status, 'pending');
  repository.update('one', 1, value => ({ ...value, status: 'cancelled' })); assert.equal(repository.findById('one').status, 'cancelled');
});

test('repository rejects duplicate IDs and handles missing records', () => {
  const repository = new InMemoryOrderRepository(); repository.save(order);
  assert.throws(() => repository.save(order), /already exists/);
  assert.equal(repository.findById('missing'), null); assert.equal(repository.update('missing', 1, value => value), null);
  assert.deepEqual(repository.findByPublicOrderId('public-one'), repository.findById('one'));
  assert.equal(repository.findByPublicOrderId('missing'), null);
  assert.throws(() => repository.save({ ...order, id: 'two' }), /Public order/);
});

test('idempotency reservation is atomic within one process', () => {
  const repository = new InMemoryOrderRepository();
  assert.equal(repository.reserveIdempotency('key', 'a').created, true);
  assert.equal(repository.reserveIdempotency('key', 'a').created, false);
  assert.equal(repository.reserveIdempotency('key', 'b').conflict, true);
});

test('repository internals are not exposed and clone serialization failures are explicit', () => {
  const repository = new InMemoryOrderRepository();
  assert.equal(repository.orders, undefined); assert.equal(repository.idempotency, undefined);
  assert.throws(() => repository.save({ id: 'bad', callback: () => {} }), /clone/i);
});

test('repository lists newest orders first and returns detached values', () => {
  const repository = new InMemoryOrderRepository();
  repository.save({ ...order, id: 'old', publicOrderId: 'public-old', customer: { name: 'A' }, createdAt: '2026-01-01T00:00:00.000Z' });
  repository.save({ ...order, id: 'new', publicOrderId: 'public-new', customer: { name: 'A' }, createdAt: '2026-02-01T00:00:00.000Z' });
  const listed = repository.listRecent(); assert.deepEqual(listed.map(value => value.id), ['new', 'old']);
  listed[0].customer.name = 'changed'; assert.equal(repository.findById('new').customer.name, 'A');
});
