import { CatalogService } from '../server/catalog/catalog-service.js';

export const testProducts = [
  {
    id: 'lain-cap-01', name: 'Offline Cap', price: 29000, currency: 'ARS', available: true,
    sizes: ['One size'], colors: ['Black'], shipping: { weightKg: 0.25, heightCm: 12, widthCm: 20, lengthCm: 25 }
  },
  {
    id: 'lain-hoodie-01', name: 'Quiet Frequency Hoodie', price: 89000, currency: 'ARS', available: true,
    sizes: ['S', 'M', 'L', 'XL'], colors: ['Graphite'], shipping: { weightKg: 0.8, heightCm: 10, widthCm: 30, lengthCm: 35 }
  },
  {
    id: 'lain-tee-02', name: 'Unpriced T-shirt', price: null, currency: 'ARS', available: true,
    sizes: ['S', 'M', 'L', 'XL'], colors: [], shipping: { weightKg: 0.35, heightCm: 5, widthCm: 25, lengthCm: 30 }
  }
];

export const createTestCatalog = () => new CatalogService(testProducts);
