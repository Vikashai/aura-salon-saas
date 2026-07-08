'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestOriginGuard, urlCandidates } = require('../src/request-origin');

function run(headers = {}, options = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const req = { method: 'POST', path: '/forgot-password', get: name => normalized[name.toLowerCase()] };
  const result = { next: false, status: null, message: null };
  const res = { status(code) { result.status = code; return this; }, send(message) { result.message = message; return this; } };
  requestOriginGuard({ appBaseUrl: 'https://aura.example.com', production: true, ...options })(req, res, () => { result.next = true; });
  return result;
}

test('accepts the public application origin', () => {
  assert.equal(run({ host: 'internal.host', origin: 'https://aura.example.com' }).next, true);
});

test('accepts Hostinger-style appended and encoded origin values', () => {
  assert.equal(run({ host: 'internal.host', origin: 'proxy=%22https%3A%2F%2Faura.example.com%2F%22, internal' }).next, true);
});

test('accepts an unparseable proxy wrapper only with browser same-origin evidence', () => {
  assert.equal(run({ host: 'aura.example.com', origin: 'hostinger-wrapper', 'sec-fetch-site': 'same-origin' }).next, true);
});

test('rejects browser cross-site submissions before parsing origin', () => {
  const result = run({ host: 'aura.example.com', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  assert.equal(result.status, 403);
  assert.equal(result.message, 'Cross-site request blocked');
});

test('rejects a valid but foreign origin', () => {
  assert.equal(run({ host: 'aura.example.com', origin: 'https://evil.example' }).status, 403);
});

test('rejects malformed origin without same-origin browser evidence', () => {
  assert.equal(run({ host: 'aura.example.com', origin: 'broken' }).message, 'Invalid request origin');
});

test('extracts URLs without proxy punctuation', () => {
  assert.equal(urlCandidates('["https://aura.example.com/path"]').at(-1).host, 'aura.example.com');
});
