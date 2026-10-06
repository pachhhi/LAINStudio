export function createSubmitGuard(operation) {
  let inFlight = null;
  return (...args) => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(() => operation(...args)).finally(() => { inFlight = null; });
    return inFlight;
  };
}
