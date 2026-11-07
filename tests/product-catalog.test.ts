import assert from 'node:assert/strict';
import test from 'node:test';
import type { Product } from '../lib/types.ts';
import { isProductLowStock, selectCatalogProducts } from '../lib/product-catalog.ts';

const product = (id: string, extra: Partial<Product> = {}): Product => ({ id, name: id, type: 'product', price: null, description: '商品资料', faq: [], enabled: true, ...extra });
const ids = (rows: Product[]) => rows.map(row => row.id);

test('待补货支持阈值和手动标记，未知库存不当成零库存，服务不参与', () => {
  assert.equal(isProductLowStock(product('unknown')), false);
  assert.equal(isProductLowStock(product('empty', { stock: null })), false);
  assert.equal(isProductLowStock(product('zero', { stock: 0 })), true);
  assert.equal(isProductLowStock(product('boundary', { stock: 5 })), true);
  assert.equal(isProductLowStock(product('enough', { stock: 6 })), false);
  assert.equal(isProductLowStock(product('custom', { stock: 7, restockThreshold: 7 })), true);
  assert.equal(isProductLowStock(product('zero-threshold', { stock: 1, restockThreshold: 0 })), false);
  assert.equal(isProductLowStock(product('manual', { stock: 100, needsRestock: true })), true);
  assert.equal(isProductLowStock(product('manual-unknown', { needsRestock: true })), true);
  assert.equal(isProductLowStock(product('service', { type: 'service', stock: 0, needsRestock: true })), false);
});

test('库存升降序均将服务与未知库存排在最后，同值保持顺序且不修改原数组', () => {
  const rows = [product('unknown'), product('ten', { stock: 10 }), product('service', { type: 'service', stock: 0 }), product('zero-a', { stock: 0 }), product('zero-b', { stock: 0 }), product('null', { stock: null })];
  assert.deepEqual(ids(selectCatalogProducts(rows, { sort: 'stock-asc' })), ['zero-a', 'zero-b', 'ten', 'unknown', 'service', 'null']);
  assert.deepEqual(ids(selectCatalogProducts(rows, { sort: 'stock-desc' })), ['ten', 'zero-a', 'zero-b', 'unknown', 'service', 'null']);
  assert.deepEqual(ids(rows), ['unknown', 'ten', 'service', 'zero-a', 'zero-b', 'null']);
});

test('价格升降序支持零价与服务，人工报价始终排在末尾', () => {
  const rows = [product('unknown'), product('ten-a', { price: 10 }), product('free', { price: 0 }), product('ten-b', { price: 10, type: 'service' })];
  assert.deepEqual(ids(selectCatalogProducts(rows, { sort: 'price-asc' })), ['free', 'ten-a', 'ten-b', 'unknown']);
  assert.deepEqual(ids(selectCatalogProducts(rows, { sort: 'price-desc' })), ['ten-a', 'ten-b', 'free', 'unknown']);
});

test('待补货筛选、关键词和价格排序可以组合使用', () => {
  const rows = [product('coffee-one', { name: '咖啡 A', stock: 2, price: 18 }), product('tea', { name: '茶', stock: 0, price: 8 }), product('coffee-two', { name: '咖啡 B', stock: 50, price: 28, needsRestock: true }), product('coffee-enough', { name: '咖啡 C', stock: 50, price: 5 }), product('service', { type: 'service', name: '咖啡体验', price: 99 })];
  assert.deepEqual(ids(selectCatalogProducts(rows, { filter: 'restock', query: ' 咖啡 ', sort: 'price-desc' })), ['coffee-two', 'coffee-one']);
  assert.deepEqual(ids(selectCatalogProducts(rows, { filter: 'service' })), ['service']);
  assert.equal(selectCatalogProducts(rows, { filter: 'product' }).length, 4);
});
