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

test('sending prevents duplicates and clears draft only after a saved response', async () => {
  const response = deferred(), calls = [];
  const workspace = await loadWorkspace({ read: async () => fixtures.empty_detail, list: async () => fixtures.empty_list,
    send: (id, payload) => { calls.push(payload); return response.promise; } });
  await workspace.open('a'); workspace.setDraft('Một buổi chiều yên tĩnh.');
  const sending = workspace.send('vi'); await workspace.send('vi');
  assert.equal(calls.length, 1); assert.equal(workspace.getSnapshot().draft, 'Một buổi chiều yên tĩnh.');
  assert.equal(calls[0].locale, 'vi'); assert.equal(calls[0].expected_revision, 0);
  response.resolve({ ...fixtures.turn_responses.reflection, turn_id: calls[0].turn_id }); await sending;
  assert.equal(workspace.getSnapshot().draft, ''); assert.equal(workspace.getSnapshot().detail.turns.length, 1);
});

test('retry preserves IDs, edits create new IDs, conflicts refresh before explicit resend', async () => {
  const calls = []; let failure = 503, revision = 0;
  const workspace = await loadWorkspace({ read: async () => ({ ...fixtures.empty_detail, chat: { ...fixtures.chat, revision } }),
    send: async (id, body) => { calls.push(body); throw Object.assign(new Error('Try again'), { status: failure }); } });
  await workspace.open('a'); workspace.setDraft('An experience.'); await workspace.send('en'); await workspace.send('en');
  assert.equal(calls[0].turn_id, calls[1].turn_id);
  workspace.setDraft('A different experience.'); await workspace.send('en'); assert.notEqual(calls[1].turn_id, calls[2].turn_id);
  failure = 409; revision = 2; await workspace.send('en');
  assert.equal(workspace.getSnapshot().detail.chat.revision, 2); assert.equal(calls.length, 4);
  await workspace.send('en'); assert.equal(calls[4].expected_revision, 2);
});

test('account clear and switching cancel turns even if transport ignores abort', async () => {
  const response = deferred(); let signal;
  const workspace = await loadWorkspace({ read: async () => fixtures.empty_detail,
    send: (id, payload, value) => { signal = value; return response.promise; } });
  await workspace.open('a'); workspace.setDraft('private'); const pending = workspace.send('en');
  workspace.clear(); response.resolve(fixtures.turn_responses.reflection); await pending;
  assert.ok(signal.aborted); assert.equal(workspace.getSnapshot().detail, null); assert.equal(workspace.getSnapshot().draft, '');
});

test('429 cooldown blocks sends and conflict reload failure blocks stale revisions', async () => {
  let count = 0, readFails = false, code = 429;
  const workspace = await loadWorkspace({ read: async () => { if (readFails) throw new Error('Offline'); return fixtures.empty_detail; },
    send: async () => { count++; throw Object.assign(new Error('Wait'), { status: code, retryAfter: 10 }); } });
  await workspace.open('a'); workspace.setDraft('hello'); await workspace.send('en'); await workspace.send('en');
  assert.equal(count, 1); assert.ok(workspace.getSnapshot().retryAt > Date.now());
  await workspace.open('b'); workspace.setDraft('hello'); code = 409; readFails = true;
  await workspace.send('en'); await workspace.send('en');
  assert.equal(count, 2); assert.equal(workspace.getSnapshot().needsRefresh, true);
});

test('deletion is confirmed by the server, prevents duplicates, and keeps failed chats', async () => {
  const deletion = deferred(); let calls = 0;
  const workspace = await loadWorkspace({ read: async () => fixtures.empty_detail,
    remove: () => { calls++; return deletion.promise; } });
  await workspace.open('a'); workspace.setDraft('keep');
  const first = workspace.remove(); assert.equal(await workspace.remove(), false); assert.equal(calls, 1);
  deletion.reject(new Error('Offline')); assert.equal(await first, false);
  assert.equal(workspace.getSnapshot().draft, 'keep'); assert.ok(workspace.getSnapshot().detail);
});

test('support links accept HTTPS and call actions and reject executable metadata', async () => {
  const { safeSupportUrl } = await import('../src/frontend/src/features/reflection-chat/supportLinks.js');
  assert.equal(safeSupportUrl('https://example.test/support'), 'https://example.test/support');
  assert.equal(safeSupportUrl('tel:+1234'), 'tel:+1234');
  for (const value of ['javascript:alert(1)', 'data:text/html,bad', '//evil.test', 'https://user:pass@example.test', 'tel:abc', 'https://a.test/\n']) assert.equal(safeSupportUrl(value), null);
});
