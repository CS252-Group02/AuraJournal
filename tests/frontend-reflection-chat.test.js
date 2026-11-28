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

async function loadWorkspace(api) {
  const result = await build({ entryPoints: ['src/frontend/src/features/reflection-chat/chatWorkspace.js'], bundle: true,
    write: false, platform: 'node', format: 'esm', define: { 'import.meta.env.VITE_API_URL': '""' } });
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  return module.createChatWorkspace(api);
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('history pagination merges chats and conversation switching discards late reads', async () => {
  const late = deferred(), signals = [];
  const workspace = await loadWorkspace({ list: async cursor => ({ chats: [{ ...fixtures.chat, id: cursor || 'a' }], next_cursor: cursor ? null : 'b' }),
    read: (id, before, signal) => { signals.push(signal); return id === 'a' ? late.promise : Promise.resolve(fixtures.empty_detail); } });
  await workspace.list(); await workspace.list(true);
  assert.deepEqual(workspace.getSnapshot().chats.map(chat => chat.id), ['a', 'b']);
  const first = workspace.open('a'); await workspace.open('b');
  late.resolve({ ...fixtures.empty_detail, chat: { ...fixtures.chat, title: 'Stale' } }); await first;
  assert.ok(signals[0].aborted); assert.equal(workspace.getSnapshot().detail.chat.title, 'New reflection');
  workspace.setDraft('private'); await workspace.open('a');
  await workspace.open('b'); assert.equal(workspace.getSnapshot().draft, 'private');
  workspace.clear(); assert.equal(workspace.getSnapshot().draft, ''); assert.deepEqual(workspace.getSnapshot().chats, []);
});
