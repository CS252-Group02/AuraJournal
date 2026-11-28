import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const fixtures = JSON.parse(readFileSync(new URL('../docs/fixtures/reflection-chat.json', import.meta.url)));
const loaded = await build({ entryPoints: ['src/frontend/src/features/reflection-chat/chatApi.js'], bundle: true,
  write: false, platform: 'node', format: 'esm', define: { 'import.meta.env.VITE_API_URL': '""' } });
const { createChatApi } = await import(`data:text/javascript;base64,${Buffer.from(loaded.outputFiles[0].text).toString('base64')}`);

test('chat adapters preserve payloads, cancellation and pagination', async () => {
  const calls = [], signal = new AbortController().signal;
  const api = createChatApi(async (...args) => { calls.push(args); return fixtures.empty_detail; });
  await api.create(signal); await api.list('a+b=', signal); await api.read('id', 4, signal);
  await api.send('id', fixtures.turn_request, signal); await api.remove('id', signal);
  await api.support('VN', 'vi', signal);
  assert.deepEqual(calls.map(([path]) => path), ['/api/reflection-chats', '/api/reflection-chats?cursor=a%2Bb%3D',
    '/api/reflection-chats/id?before_revision=4', '/api/reflection-chats/id/turns', '/api/reflection-chats/id',
    '/api/reflection-chats/support?country=VN&locale=vi']);
  assert.deepEqual(calls[0][1].body, {}); assert.deepEqual(calls[4][1].body, {});
  assert.equal(calls[3][1].body, fixtures.turn_request);
  assert.ok(calls.every(([, options]) => options.signal === signal));
});

test('chat adapters preserve server errors including retry metadata', async () => {
  const error = Object.assign(new Error('Wait'), { status: 429, retryAfter: 5 });
  const api = createChatApi(async () => { throw error; });
  await assert.rejects(api.send('id', fixtures.turn_request), actual => actual === error);
});
