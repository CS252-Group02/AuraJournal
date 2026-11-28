import { useEffect, useState } from 'react';

export default function ChatComposer({ state, locale, onLocale, onDraft, onSend }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!state.retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [state.retryAt]);
  const waiting = state.retryAt > now;
  const disabled = state.deleting || state.needsRefresh || state.refreshing || state.sending || state.accessPending || !state.draft.trim() || state.draft.length > 2000 || waiting;
  return <form className="chat-composer" onSubmit={event => { event.preventDefault(); if (!disabled) onSend(locale); }}>
    <label htmlFor="chat-draft">Your message</label>
    <textarea id="chat-draft" value={state.draft} maxLength={2000} rows={4} disabled={state.sending}
      placeholder="What happened?" onChange={event => onDraft(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
          event.preventDefault(); if (!disabled) onSend(locale);
        }
      }} aria-describedby="chat-composer-help" />
    <div className="chat-composer-actions"><label>Reply language <select aria-label="Reply language" value={locale} disabled={state.sending} onChange={event => onLocale(event.target.value)}>
      <option value="en">English</option><option value="vi">Tiếng Việt</option>
    </select></label><span>{state.draft.length}/2000</span><button className="aj-btn" type="submit" disabled={disabled}>{state.sending ? 'Reflecting…' : state.retry ? 'Retry message' : 'Send'}</button></div>
    <p id="chat-composer-help">Enter to send · Shift+Enter for a new line. You choose what your experience means to you.</p>
    {waiting && <p role="status">Try again in {Math.ceil((state.retryAt - now) / 1000)} seconds.</p>}
    {state.sending && <p role="status">Preparing your reflection… Leaving this chat may still allow the reply to be saved.</p>}
  </form>;
}
