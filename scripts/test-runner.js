import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { prepareTestDatabase } from './test-database.js';

const mode = process.argv[2] || 'unit';
const postgresFile = 'test/postgres-order-repository.test.js';

async function testFiles() {
  const files = (await readdir(new URL('../test/', import.meta.url)))
    .filter(name => name.endsWith('.test.js'))
    .map(name => `test/${name}`)
    .sort();
  if (mode === 'postgres') return [postgresFile];
  if (mode === 'all') return files;
  return files.filter(file => file !== postgresFile);
}

function run(files) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(signal ? `Tests terminated by ${signal}.` : `Tests failed with exit code ${code}.`)));
  });
}

try {
  if (mode === 'all' || mode === 'postgres' || mode === 'setup') await prepareTestDatabase();
  if (mode !== 'setup') await run(await testFiles());
} catch (error) {
  console.error(`Test environment failed: ${error.message}`);
  process.exitCode = 1;
}
