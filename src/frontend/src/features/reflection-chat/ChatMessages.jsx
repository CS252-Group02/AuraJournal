import { useLayoutEffect, useRef } from 'react';

export default function ChatMessages({ state, onOlder, renderSupport, renderSources }) {
  const scroller = useRef(null), nearBottom = useRef(true), previous = useRef(null);
  const turns = state.detail.turns;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (previous.current) {
      const { height, top } = previous.current;
      element.scrollTop = top + element.scrollHeight - height;
      previous.current = null;
    } else if (nearBottom.current) element.scrollTop = element.scrollHeight;
  }, [turns, state.pending]);
  function older() {
    const element = scroller.current;
    previous.current = { height: element.scrollHeight, top: element.scrollTop };
    onOlder();
  }
  return <div ref={scroller} className="chat-messages" role="region" aria-label="Messages" tabIndex={0}
    onScroll={event => { const el = event.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
    {state.detail.next_before_revision && <button disabled={state.loadingOlder} onClick={older}>Load older messages</button>}
    {!turns.length && <p>Share an experience you would like to think through.</p>}
    {turns.map(turn => <article key={turn.turn_id}>
      <div className="chat-message chat-message-user"><strong>You</strong><p>{turn.message}</p></div>
      <div className="chat-message"><strong>Reflection</strong><p>{turn.reply}</p>{renderSupport?.(turn)}{renderSources?.(turn)}</div>
    </article>)}
    {state.sending && <div className="chat-message chat-message-user"><strong>You · Sending</strong><p>{state.pending.message}</p></div>}
  </div>;
}
