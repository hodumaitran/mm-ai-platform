// Loads local development settings and points every test at the isolated test database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

try {
  const text = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2] ?? '';
    }
  }
} catch {
  // CI supplies the variables directly.
}

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl === undefined || !/\/[^/?]*_test(\?|$)/.test(testUrl)) {
  throw new Error('TEST_DATABASE_URL must point to a database whose name ends with _test');
}
process.env.DATABASE_URL = testUrl;
process.env.SESSION_SECRET ??= 'test-only-session-secret-0123456789abcdef';
process.env.NODE_ENV = 'test';
