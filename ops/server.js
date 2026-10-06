export const OPS_HOST = '127.0.0.1';
export const DEFAULT_OPS_PORT = 4000;

export function listenOps(app, { port = DEFAULT_OPS_PORT, onListening } = {}) {
  return app.listen(port, OPS_HOST, onListening);
}
