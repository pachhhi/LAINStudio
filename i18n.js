export const translations = {
  en: {
    language: 'Language',
    english: 'English',
    spanish: 'Spanish',
    store: 'STORE',
    studio: 'STUDIO',
    about: 'ABOUT',
    clothingDigitalWork: 'CLOTHING & DIGITAL WORK',
    exploreStore: 'EXPLORE STORE',
    aboutLain: 'ABOUT LAIN',
    collection: 'Current collection',
    collectionDescription: 'Objects to wear. Made to stay with you.',
    sort: 'SORT',
    featured: 'Featured',
    newest: 'Newest',
    priceLowHigh: 'Price: Low to High',
    priceHighLow: 'Price: High to Low',
    cart: 'CART',
    nothing: 'Nothing in this frequency.',
    tryAnotherCategory: 'Try another category to find your next piece.',
    backToCollection: '← BACK TO COLLECTION',
    unavailable: 'Unavailable',
    available: 'Available',
    priceTba: 'PRICE TBA',
    productImage: 'Product image',
    front: 'FRONT',
    back: 'BACK',
    viewImage: 'Show image',
    close: 'CLOSE ×',
    yourCart: 'YOUR CART',
    cartEmpty: 'YOUR CART IS EMPTY',
    exploreLatest: 'Explore the latest LAIN pieces.',
    viewCollection: 'VIEW COLLECTION →',
    subtotal: 'Subtotal',
    checkout: 'CHECKOUT',
    checkoutComingSoon: 'Checkout coming soon.',
    remove: 'Remove',
    quantity: 'Quantity',
    decreaseQuantity: 'Decrease quantity',
    increaseQuantity: 'Increase quantity',
    size: 'SIZE',
    sizeGuide: 'SIZE GUIDE',
    sizeGuidePending: 'Size measurements will be added when available.',
    selectSize: 'SELECT A SIZE',
    madeToOrder: 'MADE TO ORDER',
    addToCart: 'ADD TO CART',
    productNotFound: 'This piece isn\'t here.',
    validationRequired: 'Select a size before adding this product.'
  },
  es: {}
};

const languageStorageKey = 'lain-language';
const supportedLanguages = ['en', 'es'];

export function resolveLanguage() {
  const stored = localStorage.getItem(languageStorageKey);
  if (supportedLanguages.includes(stored)) return stored;
  const browserLanguages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return browserLanguages.some(language => language?.toLowerCase().startsWith('es')) ? 'es' : 'en';
}

export function setLanguage(language) {
  const nextLanguage = supportedLanguages.includes(language) ? language : 'en';
  localStorage.setItem(languageStorageKey, nextLanguage);
  document.documentElement.lang = nextLanguage;
  return nextLanguage;
}

export function translate(language, key) {
  return translations[language]?.[key] || translations.en[key] || key;
}

export function languageLabel(language) {
  return translate(language, language === 'es' ? 'spanish' : 'english');
}
