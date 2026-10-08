import pg from 'pg';
import { runMigrations } from '../server/db/migrate.js';

const TEST_NAME_PATTERN = /test/i;

export function requireSafeTestDatabase(environment = process.env) {
  const value = environment.TEST_DATABASE_URL;
  if (!value) throw new Error('TEST_DATABASE_URL is required. Copy .env.test.example to .env.test and provide test-only credentials.');
  let url;
  try { url = new URL(value); }
  catch { throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('TEST_DATABASE_URL must use postgres:// or postgresql://.');
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!databaseName || !TEST_NAME_PATTERN.test(databaseName) || ['postgres', 'template0', 'template1'].includes(databaseName.toLowerCase())) {
    throw new Error(`Refusing unsafe test database name "${databaseName || '<empty>'}": its name must contain "test".`);
  }
  if (environment.DATABASE_URL) {
    let development;
    try { development = new URL(environment.DATABASE_URL); } catch { development = null; }
    if (development && development.href === url.href) throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL.');
    if (development && decodeURIComponent(development.pathname.replace(/^\//, '')) === databaseName
      && development.hostname === url.hostname && development.port === url.port) {
      throw new Error('TEST_DATABASE_URL resolves to the same database as DATABASE_URL.');
    }
  }
  return { connectionString: url.href, databaseName, url };
}

async function databaseExists(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try { await pool.query('SELECT 1'); return true; }
  catch (error) { if (error.code === '3D000') return false; throw error; }
  finally { await pool.end().catch(() => {}); }
}

async function createDatabase({ url, databaseName }) {
  const maintenanceUrl = new URL(url.href);
  maintenanceUrl.pathname = '/postgres';
  const pool = new pg.Pool({ connectionString: maintenanceUrl.href, max: 1 });
  try {
    const existing = await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName]);
    if (existing.rowCount) return;
    const identifier = `"${databaseName.replaceAll('"', '""')}"`;
    await pool.query(`CREATE DATABASE ${identifier}`);
    console.log(`Created PostgreSQL test database ${databaseName}.`);
  } catch (error) {
    if (error.code === '42501') throw new Error(`Database ${databaseName} does not exist and the configured PostgreSQL role lacks CREATEDB privilege.`);
    throw error;
  } finally { await pool.end(); }
}

export async function prepareTestDatabase(environment = process.env) {
  const safe = requireSafeTestDatabase(environment);
  if (!(await databaseExists(safe.connectionString))) await createDatabase(safe);
  // Revalidate immediately before the only schema-changing operation.
  requireSafeTestDatabase(environment);
  await runMigrations(safe.connectionString, 'up');
  console.log(`PostgreSQL test database ready: ${safe.databaseName}.`);
  return safe;
}
