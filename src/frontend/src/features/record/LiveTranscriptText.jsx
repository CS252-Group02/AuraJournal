import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { carriesInterim, createWordAnimations, reconcileTokens } from './transcriptPresentation.js';

const preference = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

const Segment = memo(function Segment({ segment, animate, caret, carried = false, reduced }) {
  const text = segment.is_final ? segment.text.trim() : segment.text;
  const committed = useRef(null), applied = useRef(null), nodes = useRef(new Map());
  const [animations] = useState(createWordAnimations);
  // Reconcile against the last committed view; abandoned React renders have no side effects.
  const view = useMemo(() => reconcileTokens(committed.current, text), [text]);
  useLayoutEffect(() => () => {
    animations.cancel(); applied.current = null;
  }, [animations]);
  useLayoutEffect(() => {
    committed.current = view;
    animations.retain(new Set(view.tokens.map(token => token.key)));
    if (!animate || reduced) animations.cancel();
    else if (applied.current !== view && !(carried && !applied.current) &&
        (!segment.is_final || applied.current)) {
      for (const change of view.changes) animations.reveal(change.key, nodes.current.get(change.key), change.kind);
    }
    applied.current = view;
  }, [view, animate, reduced, carried, segment.is_final, animations]);
  const lastWord = view.tokens.findLast(token => token.word)?.key;
  return <span className="record-live-segment" data-final={segment.is_final}>
    {view.tokens.map(token => token.word
      ? <span key={token.key} ref={node => { if (node) nodes.current.set(token.key, node); else nodes.current.delete(token.key); }}
        className={`record-live-word${caret && token.key === lastWord ? ' has-caret' : ''}`}>{token.text}</span>
      : <Fragment key={token.key}>{token.text}</Fragment>)}
  </span>;
});

export default function LiveTranscriptText({ finals, interim, animate, caret }) {
  const previousInterim = useRef(null);
  const [reduced, setReduced] = useState(() => Boolean(preference()?.matches));
  useEffect(() => {
    const query = preference();
    const update = () => setReduced(Boolean(query?.matches));
    update(); query?.addEventListener('change', update);
    return () => query?.removeEventListener('change', update);
  }, []);
  const carried = carriesInterim(previousInterim.current, finals, interim);
  useLayoutEffect(() => {
    if (interim) previousInterim.current = interim;
    else if (!finals.length) previousInterim.current = null;
    // Keep one previous draft across a partial final's separate segment events.
  }, [interim, finals]);
  const visibleFinals = finals.filter(segment => segment.text.trim());
  // One keyed sibling list lets the SAME Segment move from interim to final.
  // Separate final/interim child slots would remount it despite matching IDs.
  const visible = interim ? [...visibleFinals, interim] : visibleFinals;
  return visible.map((segment, index) => <Fragment key={segment.segment_id}>
    {index > 0 && (segment.is_final || segment.text) ? ' ' : ''}
    <Segment segment={segment} animate={animate} caret={!segment.is_final && caret && Boolean(segment.text.trim())}
      carried={!segment.is_final && carried} reduced={reduced} />
  </Fragment>);
}
