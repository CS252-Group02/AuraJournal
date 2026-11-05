import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function loadApi() {
  const source = (await readFile(new URL('../src/frontend/src/api.js', import.meta.url), 'utf8'))
    .replace('import.meta.env.VITE_API_URL', "''");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
}

test('API sends cookies, JSON, and CSRF headers', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://localhost:8000/api/entries');
      assert.equal(options.credentials, 'include');
      assert.equal(options.headers['X-AuraJournal-CSRF'], '1');
      assert.equal(options.body, '{"content":"hello"}');
      return new Response('{"id":"example"}', { status: 201 });
    };
    const { api } = await loadApi();
    assert.deepEqual(await api('/api/entries', { method: 'POST', body: { content: 'hello' } }), { id: 'example' });
  } finally { globalThis.fetch = original; }
});

test('old journal responses cannot update a different session', async () => {
  const original = globalThis.fetch;
  try {
    let release;
    globalThis.fetch = () => new Promise((resolve) => { release = resolve; });
    const { api, changeAuthEpoch } = await loadApi();
    const result = api('/api/entries');
    changeAuthEpoch();
    release(new Response('[{"content":"previous account"}]'));
    await assert.rejects(result, /Session changed/);
  } finally { globalThis.fetch = original; }
});

test('session switches while parsing also discard private content', async () => {
  const original = globalThis.fetch;
  try {
    let release;
    globalThis.fetch = async () => ({ status: 200, ok: true,
      json: () => new Promise((resolve) => { release = resolve; }),
    });
    const { api, changeAuthEpoch } = await loadApi();
    const result = api('/api/entries');
    await Promise.resolve();
    changeAuthEpoch();
    release([{ content: 'previous account' }]);
    await assert.rejects(result, /Session changed/);
  } finally { globalThis.fetch = original; }
});

test('anonymous session checks and wrong passwords do not trigger global logout', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  try {
    const events = [];
    globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
    globalThis.fetch = async () => new Response('{"detail":"Please log in."}', { status: 401 });
    const { api } = await loadApi();
    await assert.rejects(api('/api/auth/me'), { status: 401 });
    await assert.rejects(api('/api/auth/login'), { status: 401 });
    assert.deepEqual(events, []);
    await assert.rejects(api('/api/entries'), { status: 401 });
    assert.deepEqual(events, ['aurajournal:unauthorized']);
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; }
});
