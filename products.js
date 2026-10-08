/** @typedef {{ id: string, slug: string, name: string, type?: string, description?: string|Record<'en'|'es', string>, price: number|null, currency: string, category: string, images: string[]|Record<string, string>, imageFit?: 'cover'|'contain', sizes?: string[], variants?: { id: string, size?: string, available?: boolean, options?: object }[], colors?: string[], sizeGuide?: { referenceSize:string, widthCm:number, lengthCm:number, shoulderSleeveCm:number, temporary?:boolean }, featured?: boolean, available?: boolean, shipping: { weightKg:number, widthCm:number, heightCm:number, lengthCm:number, temporary?:boolean }|null, createdAt: string }} Product */

const TSHIRT_DESCRIPTION = Object.freeze({
  es: 'Remera oversize confeccionada en 100% algodón, de calce amplio y caída relajada. Cuello reforzado y construcción pensada para uso diario.',
  en: 'Oversized T-shirt made from 100% cotton, with a relaxed fit and loose silhouette. Reinforced collar and construction designed for everyday wear.'
});

// TODO before production: replace these temporary folded-package dimensions with measured packaging data.
const TSHIRT_SHIPPING = Object.freeze({ weightKg: 0.3, widthCm: 30, lengthCm: 25, heightCm: 5, temporary: true });
// Temporary garment measurements for the published oversized T-shirt reference size; never use these as package dimensions.
const TSHIRT_SIZE_GUIDE = Object.freeze({ referenceSize: 'L', widthCm: 64, lengthCm: 75, shoulderSleeveCm: 48, temporary: true });

/** @type {Product[]} */
export const products = [
  {
    id: 'lain-tee-02',
    slug: 'lain-tee-02',
    name: 'LAIN T-shirt',
    description: TSHIRT_DESCRIPTION,
    price: 30000,
    currency: 'ARS',
    category: 'wearing',
    images: { front: '/img/outfit/web/lain-frente.webp', back: '/img/outfit/web/lain-espalda.webp' },
    sizes: [],
    variants: ['S', 'M', 'L', 'XL'].map(size => ({ id: size, size, available: true })),
    colors: [],
    sizeGuide: TSHIRT_SIZE_GUIDE,
    featured: true,
    available: true,
    shipping: TSHIRT_SHIPPING,
    createdAt: '2026-09-28'
  },
  {
    id: 'lain-tee-01',
    slug: 'lain-tee-01',
    name: 'PHANTOMA T-shirt',
    description: TSHIRT_DESCRIPTION,
    price: 30000,
    currency: 'ARS',
    category: 'wearing',
    images: { front: '/img/outfit/web/phantoma1.webp', back: '/img/outfit/web/phantoma.webp' },
    sizes: [],
    variants: ['S', 'M', 'L', 'XL'].map(size => ({ id: size, size, available: true })),
    colors: [],
    sizeGuide: TSHIRT_SIZE_GUIDE,
    featured: true,
    available: true,
    shipping: TSHIRT_SHIPPING,
    createdAt: '2026-09-15'
  },
  {
    id: 'lain-tee-03',
    slug: 'lain-tee-03',
    name: 'LAIN WIRED T-shirt',
    description: TSHIRT_DESCRIPTION,
    price: 30000,
    currency: 'ARS',
    category: 'wearing',
    images: { front: '/img/outfit/web/lain-wired-frente.webp', back: '/img/outfit/web/lain-wired-espalda.webp' },
    sizes: [],
    variants: ['S', 'M', 'L', 'XL'].map(size => ({ id: size, size, available: true })),
    colors: [],
    sizeGuide: TSHIRT_SIZE_GUIDE,
    featured: true,
    available: true,
    shipping: TSHIRT_SHIPPING,
    createdAt: '2026-09-28'
  },
  {
    id: 'lain-tee-04',
    slug: 'lain-tee-04',
    name: 'LAIN POSTER T-shirt',
    description: TSHIRT_DESCRIPTION,
    price: 30000,
    currency: 'ARS',
    category: 'wearing',
    images: { front: '/img/outfit/web/lain-poster-frente.webp', back: '/img/outfit/web/lain-poster-espalda.webp' },
    sizes: [],
    variants: ['S', 'M', 'L', 'XL'].map(size => ({ id: size, size, available: true })),
    colors: [],
    sizeGuide: TSHIRT_SIZE_GUIDE,
    featured: true,
    available: true,
    shipping: TSHIRT_SHIPPING,
    createdAt: '2026-09-28'
  },
  {
    id: 'lain-tee-06',
    slug: 'lain-tee-06',
    name: 'LAIN POSTER WHITE T-shirt',
    description: TSHIRT_DESCRIPTION,
    price: 30000,
    currency: 'ARS',
    category: 'wearing',
    images: { front: '/img/outfit/web/lain-poster-frente-blanco.webp', back: '/img/outfit/web/lain-poster-espalda-blanco.webp' },
    sizes: [],
    variants: ['S', 'M', 'L', 'XL'].map(size => ({ id: size, size, available: true })),
    colors: [],
    sizeGuide: TSHIRT_SIZE_GUIDE,
    featured: true,
    available: true,
    shipping: TSHIRT_SHIPPING,
    createdAt: '2026-09-28'
  },
  {
    id: 'lain-tee-05',
    slug: 'lain-tee-05',
    name: 'ROOT ARCH T-shirt',
    description: TSHIRT_DESCRIPTION,
    price: 30000,
    currency: 'ARS',
    category: 'wearing',
    images: { front: '/img/outfit/web/root-arch-frente.webp', back: '/img/outfit/web/root-arch-espalda.webp' },
    sizes: [],
    variants: ['S', 'M', 'L', 'XL'].map(size => ({ id: size, size, available: true })),
    colors: [],
    sizeGuide: TSHIRT_SIZE_GUIDE,
    featured: true,
    available: true,
    shipping: TSHIRT_SHIPPING,
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
