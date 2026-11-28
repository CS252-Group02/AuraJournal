import { chatApi } from './chatApi.js';

export function mergeBy(items, added, key) {
  return [...new Map([...items, ...added].map(item => [item[key], item])).values()];
}

// Own request lifetimes separately from React rendering. Tokens also guard
// transports that complete after abort (including the server finishing a turn).
export function createChatWorkspace(api = chatApi) {
  let state = { chats: [], cursor: null, listStatus: 'idle', listError: '', chatId: null,
    detail: null, status: 'idle', error: '', draft: '', sending: false, retry: null, retryAt: 0, needsRefresh: false };
  const listeners = new Set(), jobs = new Map(), drafts = new Map();
  function update(patch) { state = { ...state, ...patch }; listeners.forEach(fn => fn()); }
  function cancel(slot) { jobs.get(slot)?.abort(); jobs.delete(slot); }
  function job(slot) {
    cancel(slot);
    const controller = new AbortController(); jobs.set(slot, controller);
    return { signal: controller.signal, current: () => jobs.get(slot) === controller && !controller.signal.aborted };
  }
  function cancelAll() { [...jobs.keys()].forEach(cancel); }
  async function list(more = false) {
    const task = job('list');
    update({ listStatus: 'loading', listError: '' });
    try {
      const data = await api.list(more ? state.cursor : null, task.signal);
      if (task.current()) update({ chats: more ? mergeBy(state.chats, data.chats, 'id') : data.chats,
        cursor: data.next_cursor, listStatus: 'ready' });
    } catch (error) { if (task.current()) update({ listStatus: 'error', listError: error.message }); }
  }
  async function open(id) {
    if (state.chatId) drafts.set(state.chatId, { draft: state.draft, retry: state.retry || state.pending, retryAt: state.retryAt });
    cancel('detail'); cancel('turn'); cancel('older'); cancel('create'); cancel('delete');
    update({ chatId: id || null, detail: null, status: id ? 'loading' : 'idle', error: '',
      draft: drafts.get(id)?.draft || '', retry: drafts.get(id)?.retry || null, retryAt: drafts.get(id)?.retryAt || 0,
      sending: false, pending: null, refreshing: false, loadingOlder: false, creating: false, deleting: false, deleteError: '', needsRefresh: false });
    if (!id) return;
    const task = job('detail');
    try {
      const data = await api.read(id, null, task.signal);
      if (task.current()) {
        const saved = state.retry && data.turns.some(turn => turn.turn_id === state.retry.turn_id);
        update({ detail: data, status: 'ready', ...(saved ? { draft: '', retry: null } : {}) });
        if (saved) drafts.delete(id);
      }
    } catch (error) { if (task.current()) update({ status: 'error', error: error.message }); }
  }
  async function create() {
    if (state.creating) return null;
    const task = job('create'); update({ creating: true, listError: '' });
    try {
      const data = await api.create(task.signal);
      if (!task.current()) return null;
      update({ chats: [data, ...state.chats], creating: false }); return data.id;
    } catch (error) { if (task.current()) update({ creating: false, listError: error.message }); }
    return null;
  }
  async function older() {
    if (!state.detail?.next_before_revision || state.loadingOlder) return;
    const task = job('older'); update({ loadingOlder: true, error: '' });
    try {
      const data = await api.read(state.chatId, state.detail.next_before_revision, task.signal);
      if (task.current()) update({ detail: { ...state.detail,
        turns: mergeBy(data.turns, state.detail.turns, 'turn_id'), next_before_revision: data.next_before_revision }, loadingOlder: false });
    } catch (error) { if (task.current()) update({ loadingOlder: false, error: error.message }); }
  }
  async function refresh() {
    if (!state.chatId) return;
    const task = job('detail');
    update({ refreshing: true, error: '' });
    try {
      const data = await api.read(state.chatId, null, task.signal);
      if (!task.current()) return;
      const saved = state.retry && data.turns.some(turn => turn.turn_id === state.retry.turn_id);
      update({ detail: data, status: 'ready', refreshing: false, needsRefresh: false,
        ...(saved ? { draft: '', retry: null, error: '' } : {}) });
      if (saved) drafts.delete(state.chatId);
    } catch (error) { if (task.current()) update({ refreshing: false, needsRefresh: true, error: error.message }); }
  }
  async function send(locale) {
    const message = state.draft.trim();
    if (state.deleting || state.sending || state.needsRefresh || state.refreshing || state.accessPending || state.retryAt > Date.now() || !state.detail || !message || message.length > 2000) return;
    const id = state.chatId;
    const payload = state.retry?.message === message && state.retry.locale === locale
      ? { ...state.retry, expected_revision: state.detail.chat.revision }
      : { turn_id: crypto.randomUUID(), expected_revision: state.detail.chat.revision, message, locale };
    const task = job('turn'); update({ sending: true, pending: payload, retry: payload, error: '' });
    try {
      const turn = await api.send(id, payload, task.signal);
      if (!task.current()) return;
      drafts.delete(id);
      update({ detail: { ...state.detail, chat: { ...state.detail.chat, revision: turn.revision },
        turns: mergeBy(state.detail.turns, [turn], 'turn_id') }, draft: '', sending: false, pending: null, retry: null });
      list();
    } catch (error) {
      if (!task.current()) return;
      update({ sending: false, pending: null, error: error.message,
        retryAt: error.status === 429 ? Date.now() + (error.retryAfter ?? 30) * 1000 : 0 });
      if (error.status === 409) {
        update({ needsRefresh: true });
        await refresh();
        if (task.current() && state.retry && !state.needsRefresh) update({ error: 'The conversation changed. Review the latest messages, then send again.' });
      }
    }
  }
  async function remove() {
    if (!state.chatId || state.deleting) return false;
    const id = state.chatId, task = job('delete');
    cancel('turn'); cancel('detail'); cancel('older');
    update({ deleting: true, deleteError: '', sending: false, pending: null });
    try {
      await api.remove(id, task.signal);
      if (!task.current()) return false;
      cancel('list'); drafts.delete(id);
      update({ deleting: false, chats: state.chats.filter(chat => chat.id !== id), detail: null, draft: '', retry: null });
      return true;
    } catch (error) {
      if (task.current()) update({ deleting: false, deleteError: error.message, needsRefresh: true });
      return false;
    }
  }
  return { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, getSnapshot: () => state,
    list, open, create, older, send, refresh, remove, cancelAll,
    setDraft: draft => update({ draft, retry: draft.trim() === state.retry?.message ? state.retry : null }),
    clear() { cancelAll(); drafts.clear(); update({ chats: [], detail: null, draft: '', chatId: null, sending: false, pending: null, retry: null, retryAt: 0, creating: false, loadingOlder: false, refreshing: false, needsRefresh: false, error: '' }); },
  };
}
