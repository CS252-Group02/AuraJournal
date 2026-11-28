import { chatApi } from './chatApi.js';

export function mergeBy(items, added, key) {
  return [...new Map([...items, ...added].map(item => [item[key], item])).values()];
}

// Own request lifetimes separately from React rendering. Tokens also guard
// transports that complete after abort (including the server finishing a turn).
export function createChatWorkspace(api = chatApi) {
  let state = { chats: [], cursor: null, listStatus: 'idle', listError: '', chatId: null,
    detail: null, status: 'idle', error: '', draft: '', sending: false };
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
    if (state.chatId) drafts.set(state.chatId, state.draft);
    cancel('detail'); cancel('turn'); cancel('older');
    update({ chatId: id || null, detail: null, status: id ? 'loading' : 'idle', error: '',
      draft: drafts.get(id) || '', sending: false });
    if (!id) return;
    const task = job('detail');
    try {
      const data = await api.read(id, null, task.signal);
      if (task.current()) update({ detail: data, status: 'ready' });
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
  async function send(locale) {
    const message = state.draft.trim();
    if (state.sending || !state.detail || !message || message.length > 2000) return;
    const id = state.chatId;
    const payload = { turn_id: crypto.randomUUID(), expected_revision: state.detail.chat.revision, message, locale };
    const task = job('turn'); update({ sending: true, pending: payload, error: '' });
    try {
      const turn = await api.send(id, payload, task.signal);
      if (!task.current()) return;
      drafts.delete(id);
      update({ detail: { ...state.detail, chat: { ...state.detail.chat, revision: turn.revision },
        turns: mergeBy(state.detail.turns, [turn], 'turn_id') }, draft: '', sending: false, pending: null });
      list();
    } catch (error) { if (task.current()) update({ sending: false, pending: null, error: error.message }); }
  }
  return { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, getSnapshot: () => state,
    list, open, create, older, send, cancelAll,
    setDraft: draft => update({ draft }),
    clear() { cancelAll(); drafts.clear(); update({ chats: [], detail: null, draft: '', chatId: null }); },
  };
}
