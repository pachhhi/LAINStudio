/** @typedef {{ id: string, slug: string, name: string, type?: string, description?: string, price: number|null, currency: string, category: string, images: string[]|Record<string, string>, imageFit?: 'cover'|'contain', sizes?: string[], variants?: { id: string, size?: string, available?: boolean, options?: object }[], colors?: string[], featured?: boolean, available?: boolean, shipping: { weightKg:number, widthCm:number, heightCm:number, lengthCm:number }|null, createdAt: string }} Product */

// TODO: Testing-only logistics. Replace every value with measured weight and dimensions before production.
const TEST_TSHIRT_SHIPPING = Object.freeze({ weightKg: 0.35, heightCm: 5, widthCm: 25, lengthCm: 30 });

/** @type {Product[]} */
export const products = [
  {
    id: 'lain-tee-02',
    slug: 'lain-tee-02',
    name: 'LAIN T-shirt',
    description: '',
    price: null,
    currency: 'ARS',
    category: 'wearing',
    images: { front: '/img/outfit/web/lain-frente.webp', back: '/img/outfit/web/lain-espalda.webp' },
    sizes: [],
    variants: ['S', 'M', 'L', 'XL'].map(size => ({ id: size, size, available: true })),
    colors: [],
    featured: true,
    available: false,
    shipping: TEST_TSHIRT_SHIPPING,
    createdAt: '2026-09-28'
  },
  {
    id: 'lain-tee-01',
    slug: 'lain-tee-01',
    name: 'PHANTOMA T-shirt',
    description: '',
    price: null,
    currency: 'ARS',
    category: 'wearing',
    images: { front: '/img/outfit/web/phantoma1.webp', back: '/img/outfit/web/phantoma.webp' },
    sizes: [],
    variants: ['S', 'M', 'L', 'XL'].map(size => ({ id: size, size, available: true })),
    colors: [],
    featured: true,
    available: false,
    shipping: TEST_TSHIRT_SHIPPING,
    createdAt: '2026-09-15'
  },
  {
    id: 'lain-tee-03',
    slug: 'lain-tee-03',
    name: 'LAIN WIRED T-shirt',
    description: '',
    price: null,
    currency: 'ARS',
    category: 'wearing',
    images: { front: '/img/outfit/web/lain-wired-frente.webp', back: '/img/outfit/web/lain-wired-espalda.webp' },
    sizes: [],
    variants: ['S', 'M', 'L', 'XL'].map(size => ({ id: size, size, available: true })),
    colors: [],
    featured: true,
    available: false,
    shipping: TEST_TSHIRT_SHIPPING,
    createdAt: '2026-09-28'
  },
  {
    id: 'lain-tee-04',
    slug: 'lain-tee-04',
    name: 'LAIN POSTER T-shirt',
    description: '',
    price: null,
    currency: 'ARS',
    category: 'wearing',
    images: { front: '/img/outfit/web/lain-poster-frente.webp', back: '/img/outfit/web/lain-poster-espalda.webp' },
    sizes: [],
    variants: ['S', 'M', 'L', 'XL'].map(size => ({ id: size, size, available: true })),
    colors: [],
    featured: true,
    available: false,
    shipping: TEST_TSHIRT_SHIPPING,
    createdAt: '2026-09-28'
  },
  {
    id: 'lain-tee-06',
    slug: 'lain-tee-06',
    name: 'LAIN POSTER WHITE T-shirt',
    description: '',
    price: null,
    currency: 'ARS',
    category: 'wearing',
    images: { front: '/img/outfit/web/lain-poster-frente-blanco.webp', back: '/img/outfit/web/lain-poster-espalda-blanco.webp' },
    sizes: [],
    variants: ['S', 'M', 'L', 'XL'].map(size => ({ id: size, size, available: true })),
    colors: [],
    featured: true,
    available: false,
    shipping: TEST_TSHIRT_SHIPPING,
    createdAt: '2026-09-28'
  },
  {
    id: 'lain-tee-05',
    slug: 'lain-tee-05',
    name: 'ROOT ARCH T-shirt',
    description: '',
    price: null,
    currency: 'ARS',
    category: 'wearing',
    images: { front: '/img/outfit/web/root-arch-frente.webp', back: '/img/outfit/web/root-arch-espalda.webp' },
    sizes: [],
    variants: ['S', 'M', 'L', 'XL'].map(size => ({ id: size, size, available: true })),
    colors: [],
    featured: true,
    available: false,
    shipping: TEST_TSHIRT_SHIPPING,
    createdAt: '2026-09-28'
  },
  {
    id: 'lain-art-01',
    slug: 'lain-art-01',
    name: 'LAIN Framed Artwork',
    type: 'artwork',
    description: '',
    price: null,
    currency: 'ARS',
    category: 'Artwork',
    images: { artwork: '/img/outfit/web/lain-frame.webp' },
    imageFit: 'cover',
    featured: true,
    available: false,
    shipping: null,
    createdAt: '2026-09-28'
  }
];

export const categories = [...new Set(products.map(product => product.category))];
