// Market and language are intentionally independent. A future market resolver
// can select pricing without changing the UI language.
export const marketConfig = {
  defaultMarket: 'AR',
  markets: {
    AR: { locale: 'es-AR', currency: 'ARS' },
    INTL: { locale: 'en-US', currency: 'USD' }
  }
};

const formatters = new Map();

export function formatPrice(price, currency, locale = 'es-AR', placeholder = 'PRICE TBA') {
  if (price == null) return placeholder;
  const key = `${locale}:${currency}`;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.NumberFormat(locale, {
      style: 'currency', currency, maximumFractionDigits: 0
    }));
  }
  return formatters.get(key).format(price);
}
