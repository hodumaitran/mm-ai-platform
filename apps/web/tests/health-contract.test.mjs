import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWebEnvironment } from '../next.config.ts';
import { GET } from '../src/app/api/health/route.ts';

test('web health handler returns the expected response contract', async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: 'web', status: 'ok' });
});

test('web configuration uses the private API default', () => {
  const environment = validateWebEnvironment({});
  assert.equal(environment.apiBaseUrl.href, 'http://127.0.0.1:3001/api/v1');
});

test('web configuration rejects non-HTTP API URLs', () => {
  assert.throws(
    () => validateWebEnvironment({ API_BASE_URL: 'file:///private/config' }),
    /credential-free loopback HTTP URL/,
  );
});
