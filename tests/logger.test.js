import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/shared/logger.js';

/**
 * Redaction, which is the one piece of logging that is a security control
 * rather than a convenience.
 *
 * Every log line in this service is structured, and structured logging makes it
 * easy to pass an object without looking at what is in it: a config, a request,
 * a provider error carrying the request that caused it. A key that reaches a log
 * line reaches wherever logs are shipped, and log aggregators are rarely treated
 * as secret stores.
 */

function capture(fn) {
  const lines = [];
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => (lines.push(String(chunk)), true);
  process.stderr.write = (chunk) => (lines.push(String(chunk)), true);
  try {
    fn();
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
  }
  return lines.map((l) => JSON.parse(l));
}

const log = createLogger('test');

test('a key-shaped field name is redacted, whatever the value is', () => {
  const [line] = capture(() => log.error('boom', { api_key: 'sk-ant-REALSECRET', apiKey: 'x', ANTHROPIC_API_KEY: 'y' }));
  assert.equal(line.api_key, '[redacted]');
  assert.equal(line.apiKey, '[redacted]');
  assert.equal(line.ANTHROPIC_API_KEY, '[redacted]');
  assert.ok(!JSON.stringify(line).includes('REALSECRET'));
});

test('authorization, token, secret and password are all covered', () => {
  const [line] = capture(() =>
    log.error('req', { authorization: 'Bearer abc', token: 't', secret: 's', password: 'p', 'x-api-key': 'k' }),
  );
  for (const field of ['authorization', 'token', 'secret', 'password', 'x-api-key']) {
    assert.equal(line[field], '[redacted]', `${field} must not be logged`);
  }
});

test('redaction reaches into nested objects, since whole configs get logged', () => {
  const [line] = capture(() => log.error('cfg', { llm: { model: 'claude-sonnet-5', apiKey: 'sk-ant-DEEP' } }));
  assert.equal(line.llm.model, 'claude-sonnet-5', 'harmless fields survive');
  assert.equal(line.llm.apiKey, '[redacted]');
  assert.ok(!JSON.stringify(line).includes('sk-ant-DEEP'));
});

test('redaction reaches into arrays of objects', () => {
  const [line] = capture(() => log.error('providers', { list: [{ name: 'tavily', api_key: 'tvly-SECRET' }] }));
  assert.equal(line.list[0].name, 'tavily');
  assert.equal(line.list[0].api_key, '[redacted]');
});

test('ordinary fields are never mangled', () => {
  const [line] = capture(() => log.info('request', { path: '/api/query', status: 200, duration_ms: 12 }));
  assert.equal(line.path, '/api/query');
  assert.equal(line.status, 200);
  assert.equal(line.duration_ms, 12);
});

test('every line carries level, service, message and a timestamp', () => {
  const [line] = capture(() => log.error('something_failed', { err: 'nope' }));
  assert.equal(line.level, 'error');
  assert.equal(line.service, 'test');
  assert.equal(line.msg, 'something_failed');
  assert.ok(Date.parse(line.ts), 'ts must be a real timestamp');
});

test('a deeply nested structure terminates instead of recursing forever', () => {
  // A cyclic or very deep object must not take the process down; logging is not
  // worth crashing for.
  let deep = { apiKey: 'sk-ant-BOTTOM' };
  for (let i = 0; i < 20; i += 1) deep = { nested: deep };
  const [line] = capture(() => log.error('deep', deep));
  assert.ok(line, 'it logged rather than throwing');
});

test('a child logger keeps redaction', () => {
  const child = log.child({ job_id: 'j1' });
  const [line] = capture(() => child.error('job', { token: 'should-not-appear' }));
  assert.equal(line.token, '[redacted]');
});
