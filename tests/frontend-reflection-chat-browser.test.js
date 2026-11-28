import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { launchBrowser } from './helpers/browser.js';

const fixtures = JSON.parse(readFileSync(new URL('../docs/fixtures/reflection-chat.json', import.meta.url)));
const contextual = JSON.parse(readFileSync(new URL('./fixtures/reflection-chat-context.json', import.meta.url)));
function installFixture(f) {
  const original = window.fetch, chats = new Map(); let sequence = 0;
  const control = window.__chat = { calls: [], outcome: 'reflection', fail: 0, hold: false, release: null, conflict: false, supportFail: false };
  control.savedFor = message => [...chats.values()].flatMap(chat => chat.turns).filter(turn => turn.message === message).length;
  const json = (data, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, location.origin), path = parsed.pathname, method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : null;
    if (!path.startsWith('/api/')) return original(url, options);
    control.calls.push({ path, method, body });
    if (path === '/api/auth/me') return json({ id: 'chat-user', email: 'chat@example.test' });
    if (path === '/api/auth/login') { chats.clear(); return json({ id: 'other-user', email: 'other@example.test' }); }
    if (path === '/api/entries') return json([]);
    if (path === '/api/auth/logout') return json({}, 204);
    if (path === '/api/reflection-chats/support') return control.supportFail ? json({}, 503) : json({ ...f.support, country: parsed.searchParams.get('country') });
    if (path === '/api/reflection-chats' && method === 'GET') {
      if (control.holdHistory) {
        control.historyAborted = false;
        options.signal?.addEventListener('abort', () => { control.historyAborted = true; }, { once: true });
        await new Promise(resolve => { control.releaseHistory = resolve; });
      }
      if (control.failHistory) { control.failHistory = false; return json({ detail: 'History unavailable' }, 503); }
      if (parsed.searchParams.has('cursor')) {
        const id = '00000000-0000-4000-8000-000000000999';
        chats.set(id, { chat: { ...f.chat, id, title: 'Archived chat', revision: 2 },
          turns: [{ ...f.turn_responses.reflection, turn_id: 'archive-latest', message: 'Latest archive message', revision: 2 }], next_before_revision: 2 });
        return json({ chats: [chats.get(id).chat], next_cursor: null });
      }
      return json({ chats: [...chats.values()].filter(item => item.chat.title !== 'Archived chat').map(item => item.chat), next_cursor: 'older' });
    }
    if (path === '/api/reflection-chats' && method === 'POST') {
      const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
      chats.set(id, { chat: { ...f.chat, id }, turns: [], next_before_revision: null }); return json(chats.get(id).chat, 201);
    }
    const match = path.match(/^\/api\/reflection-chats\/([^/]+)(\/turns)?$/);
    if (!match) return json({ detail: 'Not configured' }, 404);
    const id = match[1], detail = chats.get(id);
    if (!detail) return json({ detail: 'Reflection chat not found.' }, 404);
    if (method === 'GET' && parsed.searchParams.has('before_revision')) return json({ ...detail, turns: [{ ...f.turn_responses.reflection, turn_id: 'archive-earliest', message: 'Earlier archive message', revision: 1 }], next_before_revision: null });
    if (method === 'GET') return json(control.clearSources ? { ...detail, turns: detail.turns.map(turn => ({ ...turn, sources: [] })) } : detail);
    if (method === 'DELETE') { chats.delete(id); return json(null, 204); }
    if (method === 'PATCH') {
      if (control.accessConflict) { control.accessConflict = false; detail.chat.journal_access_version++; return json({ detail: 'Journal access changed.' }, 409); }
      detail.chat = { ...detail.chat, use_journals: body.use_journals, journal_access_version: detail.chat.journal_access_version + 1 };
      return json(detail.chat);
    }
    if (match[2] && method === 'POST') {
      // Deliberately scripted: frontend checks must not duplicate backend retrieval.
      const scripted = control.turnScript?.shift();
      if (scripted && scripted.message !== body.message) return json({ detail: 'Unexpected fictional request' }, 400);
      const accessVersion = detail.chat.journal_access_version;
      if (control.hold) await new Promise(resolve => { control.release = resolve; });
      if (control.fail) { const status = control.fail; control.fail = 0; return json({ detail: 'Try again' }, status, { 'Retry-After': '1' }); }
      if (control.conflict) { control.conflict = false; detail.chat.revision++; return json({ detail: 'Conversation changed.' }, 409); }
      if (detail.chat.journal_access_version !== accessVersion) return json({ detail: 'Journal access changed.' }, 409);
      const existing = detail.turns.find(turn => turn.turn_id === body.turn_id); if (existing) return json(existing);
      const turn = { ...f.turn_responses[control.outcome], ...(scripted ? { reply: scripted.reply, sources: scripted.sources } : {}), turn_id: body.turn_id, message: body.message, revision: ++detail.chat.revision };
      detail.turns.push(turn); detail.chat.title = body.message.slice(0, 60); return json(turn);
    }
    return json({}, 400);
  };
}
const binary = process.env.BROWSER_BIN || ['/usr/bin/chromium', '/usr/bin/brave-browser'].find(existsSync);
test('Reflection Chat browser acceptance with fictional local fixtures', { skip: !binary }, async context => {
  const server = await createServer({ configFile: 'src/frontend/vite.config.js', root: 'src/frontend', server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); context.after(() => server.close());
  const browser = await launchBrowser(binary); context.after(() => browser.close());
  const errors = []; browser.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.text));
  await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: `(${installFixture.toString()})(${JSON.stringify(fixtures)})` });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const evaluate = browser.evaluate;
  async function click(selector) { await browser.waitFor(`document.querySelector(${JSON.stringify(selector)})`); await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
  async function button(text, scope = 'document') {
    const expression = `Array.from(${scope}.querySelectorAll('button')).find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
    await browser.waitFor(expression); await evaluate(`${expression}.click()`);
  }
  async function draft(value) {
    await browser.waitFor("document.querySelector('textarea#chat-draft:not(:disabled)')");
    await evaluate(`{ const el = document.querySelector('#chat-draft'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); }`);
  }
  async function waitReply(text) { await browser.waitFor(`document.querySelector('.chat-messages').innerText.includes(${JSON.stringify(text)})`); }
  await browser.call('Page.navigate', { url: origin + '/reflection-chat' });
  await browser.waitFor("document.querySelector('.chat-empty')");
  await click('.account-trigger'); await browser.waitFor("document.querySelector('.account-panel')");
  assert.equal(await evaluate("document.querySelector('.account-panel').innerText.includes('chat@example.test')"), true);
  await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await context.test('saved history and older-message pagination resume conversations', async () => {
    await button('Load more chats', "document.querySelector('.chat-history')");
    await click('.chat-history a[href$="000000000999"]'); await waitReply('Latest archive message');
    await button('Load older messages'); await waitReply('Earlier archive message');
    assert.equal(await evaluate("document.querySelector('.chat-messages').innerText.indexOf('Earlier archive message') < document.querySelector('.chat-messages').innerText.indexOf('Latest archive message')"), true);
    await click('a[aria-label="Reflection Chat"]'); await browser.waitFor("document.querySelector('.chat-empty')");
  });
  await button('Start a new chat'); await browser.waitFor("document.querySelector('#chat-draft')");
  const firstUrl = await evaluate('location.pathname');

  await context.test('composer sends English/Vietnamese and displays all five outcomes as text', async () => {
    await evaluate("document.querySelector('[aria-label=\"Reply language\"]').value='vi';document.querySelector('[aria-label=\"Reply language\"]').dispatchEvent(new Event('change',{bubbles:true}))");
    for (const outcome of ['reflection', 'mood_boundary', 'out_of_scope', 'professional_support', 'urgent_support']) {
      await evaluate(`__chat.outcome=${JSON.stringify(outcome)}`);
      await draft(`Experience ${outcome}`); await button('Send'); await waitReply(fixtures.turn_responses[outcome].reply);
    }
    assert.equal(await evaluate("__chat.calls.filter(c=>c.path.endsWith('/turns')).at(-1).body.locale"), 'vi');
    await evaluate("__chat.outcome='reflection'"); await draft('<img src=x onerror=alert(1)>'); await button('Send');
    await waitReply('<img src=x onerror=alert(1)>'); assert.equal(await evaluate("document.querySelectorAll('.chat-messages img').length"), 0);
  });
  await context.test('support options require explicit country and keep guidance after failure', async () => {
    assert.equal(await evaluate("__chat.calls.filter(c=>c.path.includes('/support')).length"), 0);
    await evaluate("{const el=document.querySelectorAll('[aria-label=\"Support country code\"]').item(1);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'VN');el.dispatchEvent(new Event('input',{bubbles:true}));__chat.supportFail=true;}");
    await button('Find support options', "document.querySelectorAll('.chat-support').item(1)"); await browser.waitFor("document.querySelectorAll('.chat-support').item(1).querySelector('[role=alert]')");
    await evaluate('__chat.supportFail=false'); await button('Find support options', "document.querySelectorAll('.chat-support').item(1)");
    await browser.waitFor("document.querySelector('.chat-support a')");
    assert.equal(await evaluate("document.querySelector('.chat-support a').getAttribute('rel')"), 'noopener noreferrer');
  });
  await context.test('failed retries preserve IDs, prevent duplicates and handle conflicts and cooldowns', async () => {
    await evaluate('__chat.fail=503'); await draft('Retry my reflection'); await button('Send');
    await browser.waitFor("document.querySelector('[role=alert]')"); await button('Retry message'); await waitReply('Retry my reflection');
    assert.equal(await evaluate("{const calls=__chat.calls.filter(c=>c.path.endsWith('/turns'));calls.at(-1).body.turn_id===calls.at(-2).body.turn_id}"), true);
    await evaluate('__chat.conflict=true'); await draft('Concurrent reflection'); await button('Send');
    await browser.waitFor("document.body.innerText.includes('Review the latest messages')");
    assert.equal(await evaluate("document.querySelector('#chat-draft').value"), 'Concurrent reflection');
    await button('Retry message'); await waitReply('Concurrent reflection');
    await evaluate('__chat.fail=429'); await draft('Cooldown'); await button('Send');
    await browser.waitFor("document.querySelector('.chat-composer').innerText.includes('Try again in')");
    assert.equal(await evaluate("document.querySelector('.chat-composer button').disabled"), true);
    assert.equal(await evaluate("document.querySelector('#chat-draft').value"), 'Cooldown');
    assert.equal(await evaluate("__chat.savedFor('Cooldown')"), 0);
    await browser.waitFor("!document.querySelector('.chat-composer button').disabled"); await button('Retry message'); await waitReply('Cooldown');
    assert.equal(await evaluate("__chat.savedFor('Cooldown')"), 1);
    const cooldownCalls = await evaluate("__chat.calls.filter(call=>call.body?.message==='Cooldown').map(call=>call.body.turn_id)");
    assert.equal(cooldownCalls.length, 2);
    assert.equal(cooldownCalls[0], cooldownCalls[1]);
  });
  await context.test('switching chats discards pending results and preserves in-memory drafts', async () => {
    await evaluate('__chat.hold=true'); await draft('Pending in first chat'); await button('Send');
    await browser.waitFor('__chat.release');
    await button('New chat', "document.querySelector('.chat-history')");
    await browser.waitFor(`location.pathname !== ${JSON.stringify(firstUrl)} && document.querySelector('#chat-draft')`);
    await evaluate('__chat.hold=false;__chat.release()');
    await browser.waitFor("document.querySelector('.chat-messages')");
    assert.equal(await evaluate("document.querySelector('.chat-messages').innerText.includes('Pending in first chat')"), false);
    await draft('Draft in second chat');
    await click(`.chat-history a[href="${firstUrl}"]`); await browser.waitFor("document.querySelector('#chat-draft')?.value==='' && document.querySelector('.chat-messages')?.innerText.includes('Pending in first chat')");
  });
  await context.test('journal consent, citations, missing evidence and opt-out during generation', async () => {
    const toggle = '.chat-journal-access input';
    assert.equal(await evaluate(`document.querySelector('${toggle}').checked`), false);
    await click(toggle); await browser.waitFor(`document.querySelector('${toggle}').checked && !document.querySelector('${toggle}').disabled`);
    await evaluate("__chat.outcome='grounded_reflection'"); await draft('Find my harbor walk'); await button('Send');
    await browser.waitFor("document.querySelector('.chat-sources a')");
    assert.equal(await evaluate("document.querySelector('.chat-sources a').getAttribute('href')"), '/journal/3514c39a-4637-40e5-b332-4b4b423fa82c');
    assert.equal(await evaluate("document.querySelector('.chat-sources a').textContent"), 'Nov 27, 2026');
    await evaluate('__chat.accessConflict=true'); await click(toggle);
    await browser.waitFor("document.body.innerText.includes('changed in another tab')");
    assert.equal(await evaluate(`document.querySelector('${toggle}').checked`), true);
    await evaluate("__chat.hold=true; __chat.release=null"); await draft('Pending journal reflection'); await button('Send'); await browser.waitFor('__chat.release');
    await click(toggle); await browser.waitFor(`!document.querySelector('${toggle}').checked && !document.querySelector('${toggle}').disabled`);
    await evaluate('__chat.hold=false;__chat.release()');
    assert.equal(await evaluate("document.querySelector('#chat-draft').value"), 'Pending journal reflection');
    // Clear citations in the server fixture to represent an edited/deleted source.
    await evaluate("__chat.clearSources=true");
    await button('New chat', "document.querySelector('.chat-history')");
    await browser.waitFor(`location.pathname !== ${JSON.stringify(firstUrl)} && document.querySelector('.chat-journal-access input')`);
    assert.equal(await evaluate(`document.querySelector('${toggle}').checked`), false);
    await click(`.chat-history a[href="${firstUrl}"]`);
    await browser.waitFor(`location.pathname === ${JSON.stringify(firstUrl)} && document.querySelector('#chat-draft')?.value === 'Pending journal reflection' && document.querySelectorAll('.chat-sources a').length === 0`);
    await evaluate("__chat.outcome='reflection';__chat.fail=0"); await draft('No matching journal evidence'); await button('Send'); await waitReply('No matching journal evidence');
    assert.equal(await evaluate("document.querySelectorAll('.chat-sources a').length"), 0);
  });
  await context.test('history pagination remains recoverable after a failed turn', async () => {
    await evaluate('__chat.holdHistory=true;__chat.releaseHistory=null');
    await button('Load more chats', "document.querySelector('.chat-history')"); await browser.waitFor('__chat.releaseHistory');
    await evaluate("__chat.fail=503"); await draft('A failed turn during history loading'); await button('Send');
    await browser.waitFor("document.querySelector('.chat-composer button').textContent==='Retry message'");
    assert.equal(await evaluate('__chat.historyAborted'), false);
    assert.equal(await evaluate("document.querySelector('#chat-draft').value"), 'A failed turn during history loading');
    await evaluate('__chat.holdHistory=false;__chat.releaseHistory()');
    await browser.waitFor("!document.querySelector('.chat-history').innerText.includes('Loading chats…')");
    assert.equal(await evaluate("Boolean(document.querySelector('.chat-history a[href$=\"000000000999\"]'))"), true);
    await evaluate('__chat.holdHistory=true;__chat.releaseHistory=null;__chat.failHistory=true');
    await button('Retry message'); await browser.waitFor('__chat.releaseHistory');
    await evaluate('__chat.holdHistory=false;__chat.releaseHistory()');
    await browser.waitFor("document.querySelector('.chat-history [role=alert]')");
    // Reach the recovery action with actual Tab navigation, then activate it.
    await evaluate("document.querySelector('.chat-history button').focus()");
    for (let step = 0; step < 12; step++) {
      if (await evaluate("document.activeElement.textContent==='Retry history'")) break;
      await browser.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    }
    assert.equal(await evaluate("document.activeElement.textContent"), 'Retry history');
    await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
    await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await browser.waitFor("!document.querySelector('.chat-history [role=alert]') && !document.querySelector('.chat-history').innerText.includes('Loading chats…')");
    await button('Load more chats', "document.querySelector('.chat-history')");
    await browser.waitFor("!document.querySelector('.chat-history').innerText.includes('Loading chats…')");
  });

  for (const scenario of contextual.cases) {
    await context.test(`${scenario.name} contextual replies retain message boundaries and dated citations`, async () => {
      await button('New chat', "document.querySelector('.chat-history')");
      await browser.waitFor("document.querySelector('#chat-draft')?.value==='' && document.querySelector('.chat-journal-access input')?.checked===false");
      await click('.chat-journal-access input');
      await browser.waitFor("document.querySelector('.chat-journal-access input').checked && !document.querySelector('.chat-journal-access input').disabled");
      await evaluate(`__chat.turnScript=${JSON.stringify(scenario.turns)};__chat.outcome='reflection';__chat.clearSources=false`);
      await evaluate(`{ const el=document.querySelector('[aria-label="Reply language"]');el.value=${JSON.stringify(scenario.locale)};el.dispatchEvent(new Event('change',{bubbles:true})); }`);
      const ids = new Set();
      for (const [revision, turn] of scenario.turns.entries()) {
        await draft(turn.message); await button('Send'); await waitReply(turn.reply);
        await browser.waitFor("document.querySelector('#chat-draft')?.value===''");
        const request = await evaluate("__chat.calls.filter(call=>call.path.endsWith('/turns')).at(-1)");
        assert.deepEqual(Object.keys(request.body).sort(), ['expected_revision', 'locale', 'message', 'turn_id']);
        assert.equal(request.body.message, turn.message);
        assert.equal(request.body.locale, scenario.locale);
        assert.equal(request.body.expected_revision, revision);
        assert.match(request.body.turn_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        assert.equal(ids.has(request.body.turn_id), false); ids.add(request.body.turn_id);
        const sources = await evaluate("Array.from(document.querySelector('.chat-messages article:last-of-type').querySelectorAll('.chat-sources a')).map(el=>({href:el.getAttribute('href'),label:el.textContent}))");
        assert.deepEqual(sources.map(source => source.href), turn.sources.map(source => `/journal/${source.entry_id}`));
        if (turn.kind === 'follow_up') assert.equal(sources[0].label, 'Feb 27, 2024');
        if (turn.kind === 'explicit_dates') assert.equal(sources[0].label, 'Feb 29, 2024');
        assert.equal(sources.some(source => source.href.includes(contextual.recent_distractor.entry_id)), false);
      }
      assert.equal(await evaluate('__chat.turnScript.length'), 0);
    });
  }
  await context.test('switching contextual chats isolates consent, drafts, sources and late replies', async () => {
    const oldUrl = await evaluate('location.pathname');
    const late = { ...contextual.cases[0].turns[1], message: 'A private contextual follow-up pending in another chat' };
    await evaluate(`__chat.turnScript=[${JSON.stringify(late)}];__chat.hold=true;__chat.release=null`);
    await draft(late.message); await button('Send'); await browser.waitFor('__chat.release');
    await button('New chat', "document.querySelector('.chat-history')");
    await browser.waitFor(`location.pathname!==${JSON.stringify(oldUrl)} && document.querySelector('.chat-journal-access input')?.checked===false && document.querySelector('#chat-draft')?.value===''`);
    const newUrl = await evaluate('location.pathname');
    await evaluate('__chat.hold=false;__chat.release()');
    await browser.waitFor("document.querySelector('.chat-messages')");
    assert.equal(await evaluate("document.querySelectorAll('.chat-sources a').length"), 0);
    assert.equal(await evaluate(`document.querySelector('.chat-messages').innerText.includes(${JSON.stringify(late.reply)})`), false);
    await draft('Keep this draft only in the new chat');
    await click(`.chat-history a[href="${oldUrl}"]`);
    await browser.waitFor("document.querySelector('.chat-journal-access input')?.checked===true && document.querySelector('.chat-sources a')");
    assert.equal(await evaluate("document.querySelector('#chat-draft').value"), '');
    await click(`.chat-history a[href="${newUrl}"]`);
    await browser.waitFor("document.querySelector('#chat-draft')?.value==='Keep this draft only in the new chat'");
    assert.equal(await evaluate("document.querySelector('.chat-journal-access input').checked"), false);
    assert.equal(await evaluate("document.querySelectorAll('.chat-sources a').length"), 0);
  });
  await context.test('mobile history, keyboard composition, deletion focus, and themes', async () => {
    await browser.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await click('.chat-history-toggle'); await browser.waitFor("document.querySelector('.chat-history-dialog').open");
    await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await browser.waitFor("!document.querySelector('.chat-history-dialog').open");
    assert.equal(await evaluate("document.activeElement===document.querySelector('.chat-history-toggle')"), true);
    await draft('IME text');
    const count = await evaluate("__chat.calls.filter(c=>c.path.endsWith('/turns')).length");
    await evaluate("document.querySelector('#chat-draft').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))");
    assert.equal(await evaluate("__chat.calls.filter(c=>c.path.endsWith('/turns')).length"), count);
    await evaluate("document.querySelector('#chat-draft').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await waitReply('IME text');
    await evaluate("document.documentElement.dataset.theme='dark'");
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await button('Delete chat'); await browser.waitFor("document.querySelector('.aj-dialog').open");
    await button('Cancel', "document.querySelector('.aj-dialog')");
    assert.equal(await evaluate("document.activeElement.textContent"), 'Delete chat');
    await button('Delete chat'); await button('Delete conversation'); await browser.waitFor("location.pathname==='/reflection-chat' && document.querySelector('.chat-empty')");
  });
  await context.test('session expiry discards pending replies and a new account has no inherited draft', async () => {
    await button('Start a new chat'); await browser.waitFor("document.querySelector('#chat-draft')");
    await click('.chat-journal-access input');
    await browser.waitFor("document.querySelector('.chat-journal-access input').checked && !document.querySelector('.chat-journal-access input').disabled");
    await evaluate(`__chat.turnScript=[${JSON.stringify({ ...contextual.cases[0].turns[1], message: 'Private old account message' })}];__chat.hold=true;__chat.release=null;__chat.outcome='reflection'`);
    await draft('Private old account message'); await button('Send'); await browser.waitFor('__chat.release');
    await evaluate("dispatchEvent(new Event('aurajournal:unauthorized'))");
    await browser.waitFor("location.pathname==='/login'");
    await evaluate('__chat.hold=false;__chat.release()');
    assert.equal(await evaluate("document.body.innerText.includes('Private old account message')"), false);
    await evaluate("for (const [id,value] of [['email','other@example.test'],['password','fictional-password']]) { const el=document.getElementById(id);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true})); }");
    await button('Log in'); await browser.waitFor("location.pathname==='/'");
    // Use a same-document route change through the real React Router link.
    await evaluate("document.querySelector('a[href=\"/reflection-chat\"]').click()");
    await browser.waitFor("document.querySelector('.chat-empty')");
    await button('Start a new chat'); await browser.waitFor("document.querySelector('#chat-draft')");
    assert.equal(await evaluate("document.querySelector('#chat-draft').value"), '');
    assert.equal(await evaluate("document.body.innerText.includes('Private old account message')"), false);
    assert.equal(await evaluate("document.querySelector('.chat-journal-access input').checked"), false);
    assert.equal(await evaluate("document.querySelectorAll('.chat-sources a').length"), 0);
    assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(contextual.cases[0].turns[1].reply)})`), false);
  });
  assert.deepEqual(errors, []);
});
