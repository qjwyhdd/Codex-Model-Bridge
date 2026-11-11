import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Backend } from '../src/backend.js';

test('OpenCode session errors reject the pending completion immediately', async () => {
  const backend = new Backend('http://127.0.0.1', 'test', 1000);
  backend.watchEvents = () => {};
  backend.pendingPermissions = async () => [];
  backend.request = async route => {
    if (route === '/session') return { id: 'session-1' };
    if (route.endsWith('/message')) return new Promise(() => {});
    return {};
  };
  const meta = { probe: true };
  const controller = new AbortController();
  const result = backend.complete({ model: { id: 'opencode/test' }, tools: [], choice: 'none', text: 'probe' }, controller.signal, meta);
  await new Promise(resolve => setImmediate(resolve));
  backend.handleEvent({ type: 'session.error', properties: {
    sessionID: 'session-1', error: { data: { message: 'Free usage limit reached' } },
  } });
  const outcome = await Promise.race([result.then(() => 'resolved', error => error.message), new Promise(resolve => setTimeout(() => resolve('still pending'), 100))]);
  controller.abort();
  assert.equal(outcome, 'Free usage limit reached');
});
