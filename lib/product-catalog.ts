import type { Product } from './types';

export const DEFAULT_RESTOCK_THRESHOLD = 5;
export type CatalogFilter = 'all' | 'product' | 'service' | 'restock';
export type CatalogSort = 'default' | 'stock-asc' | 'stock-desc' | 'price-asc' | 'price-desc';

const knownStock = (product: Product): number | null => product.type === 'product' && typeof product.stock === 'number' && Number.isInteger(product.stock) && product.stock >= 0 ? product.stock : null;

export function isProductLowStock(product: Product): boolean {
  if (product.type !== 'product') return false;
  const stock = knownStock(product);
  const threshold = typeof product.restockThreshold === 'number' && Number.isInteger(product.restockThreshold) && product.restockThreshold >= 0 ? product.restockThreshold : DEFAULT_RESTOCK_THRESHOLD;
  return product.needsRestock === true || (stock !== null && stock <= threshold);
}

export function selectCatalogProducts(products: Product[], options: { filter?: CatalogFilter; sort?: CatalogSort; query?: string } = {}): Product[] {
  const { filter = 'all', sort = 'default' } = options;
  const query = (options.query ?? '').trim().toLowerCase();
  const rows = products.filter(product => (filter === 'all' || (filter === 'restock' ? isProductLowStock(product) : product.type === filter)) && `${product.name} ${product.description}`.toLowerCase().includes(query));
  if (sort === 'default') return rows;
  const value = sort.startsWith('stock-') ? knownStock : (product: Product) => typeof product.price === 'number' && Number.isFinite(product.price) && product.price >= 0 ? product.price : null;
  const direction = sort.endsWith('-desc') ? -1 : 1;
  // 未填写的数据始终排在末尾，相同值保留原有顺序。
  return rows.map((product, index) => ({ product, index })).sort((a, b) => {
    const left = value(a.product); const right = value(b.product);
    if (left === null || right === null) return left === right ? a.index - b.index : left === null ? 1 : -1;
    return direction * (left - right) || a.index - b.index;
  }).map(row => row.product);
}
