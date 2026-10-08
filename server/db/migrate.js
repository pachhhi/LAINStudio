import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL is required to run migrations.');
  return value;
}

function sections(sql) {
  const [upPart, down = ''] = sql.split('-- migrate:down');
  return { up: upPart.replace('-- migrate:up', '').trim(), down: down.trim() };
}

export async function runMigrations(connectionString, direction = 'up') {
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(migrationDirectory)).filter(file => file.endsWith('.sql')).sort();
    if (direction === 'up') {
      for (const file of files) {
        const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
        if (applied.rowCount) continue;
        const { up } = sections(await readFile(join(migrationDirectory, file), 'utf8'));
        await client.query('BEGIN');
        try { await client.query(up); await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]); await client.query('COMMIT'); }
        catch (error) { await client.query('ROLLBACK'); throw error; }
      }
    } else {
      const result = await client.query('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1');
      if (result.rowCount) {
        const file = result.rows[0].name; const { down } = sections(await readFile(join(migrationDirectory, file), 'utf8'));
        await client.query('BEGIN');
        try { await client.query(down); await client.query('DELETE FROM schema_migrations WHERE name = $1', [file]); await client.query('COMMIT'); }
        catch (error) { await client.query('ROLLBACK'); throw error; }
      }
    }
  } finally { client.release(); await pool.end(); }
}

async function main() {
  await runMigrations(databaseUrl(), process.argv[2] === 'down' ? 'down' : 'up');
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  main().catch(error => { console.error(`Migration failed: ${error.message}`); process.exitCode = 1; });
}
