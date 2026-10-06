import { createOpsApp } from './app.js';
import { DEFAULT_OPS_PORT, listenOps, OPS_HOST } from './server.js';
import { PostgresOrderRepository } from '../server/orders/postgres-order-repository.js';

const port = Number.parseInt(process.env.OPS_PORT || String(DEFAULT_OPS_PORT), 10);
const repository = PostgresOrderRepository.fromConnectionString(process.env.DATABASE_URL);

try {
  await repository.healthCheck();
  const server = listenOps(createOpsApp({ orderRepository: repository }), { port,
    onListening: () => console.log(`LAIN Ops running at http://${OPS_HOST}:${port}`) });
  const shutdown = () => server.close(() => repository.close().finally(() => process.exit(0)));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error(`LAIN Ops startup failed: PostgreSQL is unavailable (${error.code || error.name}).`);
  await repository.close().catch(() => {});
  process.exitCode = 1;
}
