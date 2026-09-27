/** @typedef {{ id: string, slug: string, name: string, description: string, price: number, currency: string, category: string, images: string[], sizes: string[], colors?: string[], featured?: boolean, available?: boolean, createdAt: string }} Product */

/** @type {Product[]} */
export const products = [
  {
    id: 'lain-tee-01',
    slug: 'lain-tee-01',
    name: 'Signal Tee',
    description: 'Heavyweight cotton, relaxed fit. Finished with a small woven signal mark at the chest and a quiet graphic on the back.',
    price: 38000,
    currency: 'ARS',
    category: 'Tees',
    images: ['/products/signal-tee.svg', '/products/signal-tee-back.svg'],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    colors: ['Black', 'Ash'],
    featured: true,
    available: true,
    createdAt: '2026-09-15'
  },
  {
    id: 'lain-hoodie-01',
    slug: 'lain-hoodie-01',
    name: 'Quiet Frequency Hoodie',
    description: 'Brushed cotton fleece with a generous shape, double-layer hood and tonal embroidery. Made for the hours between signals.',
    price: 89000,
    currency: 'ARS',
    category: 'Hoodies',
    images: ['/products/frequency-hoodie.svg'],
    sizes: ['S', 'M', 'L', 'XL'],
    colors: ['Graphite'],
    featured: true,
    available: true,
    createdAt: '2026-08-28'
  },
  {
    id: 'lain-overshirt-01',
    slug: 'lain-overshirt-01',
    name: 'Field Overshirt',
    description: 'A sturdy cotton layer with two utility pockets, matte hardware and an easy, straight cut. Built to keep its shape.',
    price: 112000,
    currency: 'ARS',
    category: 'Outerwear',
    images: ['/products/field-overshirt.svg'],
    sizes: ['S', 'M', 'L'],
    colors: ['Moss'],
    featured: false,
    available: true,
    createdAt: '2026-07-22'
  },
  {
    id: 'lain-cap-01',
    slug: 'lain-cap-01',
    name: 'Offline Cap',
    description: 'Six-panel cotton twill cap with an adjustable strap and a compact embroidered mark. One size, no noise.',
    price: 29000,
    currency: 'ARS',
    category: 'Accessories',
    images: ['/products/offline-cap.svg'],
    sizes: ['One size'],
    colors: ['Black'],
    featured: false,
    available: true,
    createdAt: '2026-06-10'
  },
  {
    id: 'lain-long-sleeve-01',
    slug: 'lain-long-sleeve-01',
    name: 'Between Long Sleeve',
    description: 'Soft cotton jersey with dropped shoulders and a restrained two-sided print. An everyday layer in a washed bone tone.',
    price: 46000,
    currency: 'ARS',
    category: 'Tees',
    images: ['/products/between-long-sleeve.svg'],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    colors: ['Bone'],
    featured: true,
    available: true,
    createdAt: '2026-05-02'
  },
  {
    id: 'lain-hoodie-02',
    slug: 'lain-hoodie-02',
    name: 'Night Study Hoodie',
    description: 'A substantial fleece pullover with a roomy front pocket and small reflective detail. The last piece from this run.',
    price: 94000,
    currency: 'ARS',
    category: 'Hoodies',
    images: ['/products/night-study-hoodie.svg'],
    sizes: ['M', 'L'],
    colors: ['Ink'],
    featured: false,
    available: false,
    createdAt: '2026-03-18'
  }
];

export const categories = [...new Set(products.map(product => product.category))];