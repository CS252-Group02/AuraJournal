import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/Auth.jsx';
import { subscribeAuthChanges } from '../lib/api.js';
import SupportOptions from '../features/reflection-chat/SupportOptions.jsx';
import ChatMessages from '../features/reflection-chat/ChatMessages.jsx';
import ChatComposer from '../features/reflection-chat/ChatComposer.jsx';
import { createChatWorkspace } from '../features/reflection-chat/chatWorkspace.js';

export default function ReflectionChatPage() {
  const { user } = useAuth();
  return <ChatWorkspace key={user.id} />;
}

function ChatWorkspace() {
  const { chatId } = useParams(), navigate = useNavigate();
  const [locale, setLocale] = useState(() => navigator.language?.startsWith('vi') ? 'vi' : 'en');
  const [workspace] = useState(() => createChatWorkspace());
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const drawer = useRef(null), historyButton = useRef(null), deleteDialog = useRef(null), deleteButton = useRef(null);
  useEffect(() => { workspace.list(); return () => workspace.cancelAll(); }, [workspace]);
  useEffect(() => subscribeAuthChanges(() => workspace.clear()), [workspace]);
  useEffect(() => { workspace.open(chatId); drawer.current?.close(); deleteDialog.current?.close(); }, [workspace, chatId]);
  async function newChat() { const id = await workspace.create(); if (id) navigate(`/reflection-chat/${id}`); }
  async function deleteChat() {
    if (await workspace.remove()) { deleteDialog.current?.close(); navigate('/reflection-chat'); }
  }
  function closeDelete() { deleteDialog.current?.close(); deleteButton.current?.focus(); }
  function closeHistory() { drawer.current?.close(); historyButton.current?.focus(); }
  const history = <>
    <h2>Saved chats</h2>
    <button type="button" className="aj-btn" onClick={newChat} disabled={state.creating}>{state.creating ? 'Creating…' : 'New chat'}</button>
    {state.listStatus === 'loading' && <p role="status">Loading chats…</p>}
    {state.listError && <div role="alert"><p>{state.listError}</p><button onClick={() => workspace.list()}>Retry history</button></div>}
    {state.listStatus === 'ready' && !state.chats.length && <p>Your saved conversations will appear here.</p>}
    <ul className="chat-history-list">{state.chats.map(chat => <li key={chat.id}>
      <Link to={`/reflection-chat/${chat.id}`} aria-current={chat.id === chatId ? 'page' : undefined}>{chat.title}</Link>
    </li>)}</ul>
    {state.cursor && <button type="button" onClick={() => workspace.list(true)} disabled={state.listStatus === 'loading'}>Load more chats</button>}
  </>;
  return <main className="aj-page chat-page">
    <header className="chat-header"><div><p className="aj-kicker">A space to think</p><h1>Reflection Chat</h1></div>
      <button ref={historyButton} type="button" className="aj-btn chat-history-toggle" onClick={() => drawer.current?.showModal()}>Saved chats</button>
    </header>
    <div className="chat-workspace">
      <aside className="chat-history" aria-label="Saved conversations">{history}</aside>
      <dialog ref={drawer} className="chat-history-dialog" aria-label="Saved conversations" onCancel={event => { event.preventDefault(); closeHistory(); }}>
        <button type="button" className="aj-btn" onClick={closeHistory}>Close history</button>{history}
      </dialog>
      <section className="chat-conversation" aria-label="Reflection conversation" aria-busy={state.status === 'loading'}>
        {!chatId && <div className="chat-empty"><h2>What would you like to reflect on?</h2><p>Start a private conversation about something you experienced. Chats are saved until you delete them or your account.</p><button className="aj-btn" onClick={newChat} disabled={state.creating}>Start a new chat</button></div>}
        {state.status === 'loading' && <p role="status">Loading conversation…</p>}
        {state.error && <div role="alert"><p>{state.error}</p><button onClick={() => workspace.refresh()}>Reload conversation</button> <Link to="/reflection-chat">Back to chats</Link></div>}
        {state.chatId === chatId && state.detail && <><div className="chat-conversation-header"><h2>{state.detail.chat.title}</h2>
          <button ref={deleteButton} className="aj-btn aj-btn-danger" onClick={() => deleteDialog.current?.showModal()}>Delete chat</button></div>
          <ChatMessages key={chatId} state={state} onOlder={() => workspace.older()} renderSupport={turn => turn.support_kind && <SupportOptions key={`${turn.turn_id}:${locale}`} kind={turn.support_kind} locale={locale} />} />
          <ChatComposer state={state} locale={locale} onLocale={setLocale} onDraft={workspace.setDraft} onSend={workspace.send} />
        </>}
      </section>
      <dialog ref={deleteDialog} className="aj-dialog" aria-labelledby="chat-delete-title" aria-describedby="chat-delete-description"
        onCancel={event => { event.preventDefault(); if (!state.deleting) closeDelete(); }}>
        <h2 id="chat-delete-title">Delete this conversation?</h2>
        <p id="chat-delete-description">This permanently deletes the conversation and its messages. This cannot be undone.</p>
        {state.deleteError && <p role="alert">{state.deleteError}</p>}
        <div className="entry-actions"><button className="aj-btn aj-btn-quiet" autoFocus disabled={state.deleting} onClick={closeDelete}>Cancel</button>
        <button className="aj-btn aj-btn-danger-solid" disabled={state.deleting} onClick={deleteChat}>{state.deleting ? 'Deleting…' : 'Delete conversation'}</button></div>
      </dialog>
    </div>
  </main>;
}
