import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import path from 'node:path';

// Load ../.env so TEST_DATABASE_URL and secrets are available to tests.
const envFile = path.resolve(import.meta.dirname, '..', '.env');
const env: Record<string, string> = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
}

export default defineConfig({
  test: {
    env: { ...env, NODE_ENV: 'test', SESSION_SECRET: env.SESSION_SECRET ?? 'test-secret-test-secret-test-secret' },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    include: ['test/**/*.test.ts'],
  },
});
