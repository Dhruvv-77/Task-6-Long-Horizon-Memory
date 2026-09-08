const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('../src/auth.js');

test('login returns a session token', () => {
  const result = auth.login('ada');
  assert.equal(result.user, 'ada');
  assert.ok(auth.session(result.token));
});

test('logout clears the session', () => {
  assert.equal(typeof auth.logout, 'function');
  assert.equal(auth.logout('t-ada'), true);
  assert.equal(auth.session('t-ada'), false);
});
