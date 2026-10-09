export function createSubmitGuard(operation) {
  let inFlight = null;
  return (...args) => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(() => operation(...args)).finally(() => { inFlight = null; });
    return inFlight;
  };
}

export function canSubmitCheckout({ hasPendingPrice, deliveryMode, selectedShippingMethodId, formValid }) {
  return !hasPendingPrice && formValid && (deliveryMode === 'coordinate'
    || (deliveryMode === 'home_delivery' && Boolean(selectedShippingMethodId)));
}

export function resolveDeliverySelection({ pickupSelected, shippingMethodId }) {
  return pickupSelected
    ? { deliveryMode: 'coordinate', shippingMethodId: null }
    : { deliveryMode: 'home_delivery', shippingMethodId: shippingMethodId || null };
}

export function normalizeShippingPrice(value) {
  return Math.round(Number(value));
}
