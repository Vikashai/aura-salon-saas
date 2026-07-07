'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeNumber, validNumber, sendWhatsApp } = require('../src/notifications');

test('normalizes Indian local numbers', () => assert.equal(normalizeNumber('98765 43210'), '919876543210'));
test('accepts E.164 length', () => assert.equal(validNumber('+91 98765 43210'), '919876543210'));
test('rejects short numbers', () => assert.equal(validNumber('123'), null));

test('builds a Meta template payload', async t => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.test' }] }) };
  };
  t.after(() => { global.fetch = originalFetch; });
  const result = await sendWhatsApp({
    whatsapp_provider: 'meta', meta_whatsapp_token: 'secret', meta_phone_number_id: '123',
    meta_api_version: 'v25.0', meta_template_language: 'en_US',
  }, '9876543210', 'unused', 'salon_booking_reminder', ['Ananya', 'Haircut']);
  assert.equal(result.ok, true);
  assert.equal(result.message, 'wamid.test');
  assert.equal(captured.url, 'https://graph.facebook.com/v25.0/123/messages');
  const payload = JSON.parse(captured.options.body);
  assert.equal(payload.to, '919876543210');
  assert.equal(payload.template.name, 'salon_booking_reminder');
  assert.equal(payload.template.components[0].parameters[0].text, 'Ananya');
});
