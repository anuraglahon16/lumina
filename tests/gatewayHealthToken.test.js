import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * Public /health has to authenticate to the Agent like every other proxy call.
 *
 * It did not. `contractRouter.get('/health')` fetched the Agent's health without
 * `x-internal-token`, while every other call through this file and through
 * proxy.js sends it. That is invisible until INTERNAL_TOKEN is actually set -
 * and then the Agent refuses the call with 403, the catch swallows it, and the
 * public health endpoint reports `degraded` with `ai: down` on a stack where
 * nothing is wrong.
 *
 * Found by running the three services under docker compose with the token
 * configured, which is the first time this code path had ever seen one.
 */

const SRC = new URL('../src/gateway/routes/contract.js', import.meta.url);
const src = fs.readFileSync(SRC, 'utf8');

test('the health proxy sends the internal token', () => {
  const call = src.slice(src.indexOf("contractRouter.get('/health'"), src.indexOf("res.json({", src.indexOf("contractRouter.get('/health'")));
  assert.match(call, /x-internal-token/, 'the /health upstream call must authenticate like the others');
});

test('every upstream call in this file sends it', () => {
  // A whole-file sweep, so the next route added cannot quietly omit it.
  const fetches = [...src.matchAll(/fetch\(\s*AGENT\(([^)]*)\)([\s\S]{0,400}?)\)/g)];
  assert.ok(fetches.length > 0, 'there are upstream calls to check');
  const bare = fetches.filter(([whole]) => !/x-internal-token/.test(whole)).map((m) => m[1]);
  assert.deepEqual(bare, [], `these upstream calls omit the token: ${bare.join(', ')}`);
});

test('the token is only sent when one is configured', () => {
  // Local development runs without a token and must keep working.
  assert.match(src, /process\.env\.INTERNAL_TOKEN \?/, 'the header is conditional on there being a token');
});
