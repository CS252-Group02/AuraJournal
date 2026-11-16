import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { contentLength, transcriptSegments, transcriptText, validContent } from './transcriptState.js';
import AudioPlayback from './AudioPlayback.jsx';
import LiveTranscriptText from './LiveTranscriptText.jsx';
import { createTranscriptScroll } from './transcriptScroll.js';

export default function TranscriptView({ model }) {
  const { phase, transcript, editorText, originalTranscript, unconfirmedText, proposedDraft,
    incomplete, capture, saveUnknown, savedEntry, capabilities, flow } = model;
  const { finalizedTranscript, interimTranscript } = transcriptText(transcript);
  const segments = useMemo(() => transcriptSegments(transcript), [transcript]);
  const [scroller] = useState(() => createTranscriptScroll());
  const area = useRef(null), editor = useRef(null), following = useRef(true), programmaticScroll = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const review = ['review', 'saving', 'saved'].includes(phase);
  const count = contentLength(editorText);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => {
      scroller.cancel();
      if (query.matches && following.current && area.current) scroller.follow(area.current, true);
    };
    query?.addEventListener('change', update);
    return () => { query?.removeEventListener('change', update); scroller.cancel(); };
  }, [scroller]);
  useEffect(() => {
    if (phase === 'ready' || phase === 'connecting') {
      scroller.cancel();
      following.current = true;
      programmaticScroll.current = true;
      setShowLatest(false);
      area.current?.scrollTo({ top: 0, behavior: 'instant' });
    }
    if (review) scroller.cancel();
  }, [phase, review, scroller]);
  useLayoutEffect(() => {
    if (following.current && !review) scrollToLatest();
  }, [finalizedTranscript, interimTranscript, phase, review]);
  useEffect(() => { if (phase === 'review') editor.current?.focus({ preventScroll: true }); }, [phase]);
  function followLatest() {
    following.current = true; setShowLatest(false);
    scrollToLatest();
  }
  function scrollToLatest() {
    if (!area.current) return;
    programmaticScroll.current = true;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    scroller.follow(area.current, Boolean(reducedMotion));
  }
  function pauseFollowing() {
    const el = area.current;
    // Cancel an in-flight smooth scroll before wheel/touch/keyboard/scrollbar input.
    programmaticScroll.current = false;
    following.current = false;
    scroller.cancel();
    setShowLatest(el.scrollHeight > el.clientHeight);
  }
  return (
    <section className="record-transcript" aria-label={review ? 'Review your journal' : 'Live transcript'}>
      {!review && (
        <>
          <span className="visually-hidden" aria-live="polite" aria-atomic="false">{finalizedTranscript}</span>
          <div className="record-live" ref={area} role="region" aria-label="Live transcript" tabIndex={0}
            onWheel={pauseFollowing} onTouchStart={pauseFollowing} onPointerDown={pauseFollowing}
            onKeyDown={event => {
              if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) pauseFollowing();
            }}
            onScroll={() => {
              if (programmaticScroll.current) return;
              const el = area.current;
              // A late event from a cancelled smooth scroll must not resume following.
              // Once paused, only the explicit Follow latest action resumes it.
              if (el.scrollHeight - el.scrollTop - el.clientHeight >= 48) following.current = false;
              setShowLatest(!following.current);
            }}>
            <LiveTranscriptText {...segments} animate={phase === 'recording' && model.transcriptionActive}
              caret={phase === 'recording' && model.transcriptionActive} />
            {!finalizedTranscript && !interimTranscript && <p className="record-transcript-hint">
              {phase === 'recording' && model.transcriptionActive ? 'Listening for your words…'
                : phase === 'recording' ? 'Live transcription is unavailable. Your audio is still recording; stop to review and write your journal.'
                  : phase === 'finalizing' ? 'Finishing your take. If no speech is confirmed, you can write your journal in review.'
                    : 'Your transcript will appear here as you record.'}
            </p>}
          </div>
          {showLatest && <button type="button" className="record-action" onClick={followLatest}>Follow latest text</button>}
          {phase === 'proofreading' && <button className="record-action" type="button" onClick={flow.useOriginal}>Review original now</button>}
        </>
      )}
      {review && (
        <>
          {phase === 'saved' ? <p className="record-saved-text">{editorText}</p> : (
            <>
              {incomplete && <p id="record-incomplete" className="record-draft-help">
                {originalTranscript ? 'Transcription is incomplete. Compare the confirmed text and any unconfirmed phrase with your audio before saving.'
                  : 'No speech was confirmed. Listen to your audio when available and write your journal below.'}
              </p>}
              <label className="visually-hidden" htmlFor="record-draft">Review and edit your journal</label>
              <textarea id="record-draft" ref={editor} className="record-editor" value={editorText}
                onChange={event => flow.edit(event.target.value)} readOnly={phase === 'saving' || saveUnknown}
                aria-describedby={`record-draft-help${incomplete ? ' record-incomplete' : ''}`} aria-invalid={count > 5000} />
              <p id="record-draft-help" className="record-draft-help">
                {count}/5000 characters. {count > 5000 ? 'Shorten the draft before saving. Your full text has been kept.' : 'Only the text in this editor will be saved.'}
              </p>
              <button className="record-action record-save" type="button" onClick={flow.save}
                disabled={phase === 'saving' || !validContent(editorText) || (saveUnknown && !capabilities.idempotentSaveAvailable)}>
                {phase === 'saving' ? 'Saving…' : saveUnknown ? 'Retry same save' : 'Save journal'}
              </button>
            </>
          )}
          <details className="record-original">
            <summary>{proposedDraft ? 'Compare with original transcript' : 'Original confirmed transcript'}</summary>
            <p>{originalTranscript || 'No speech was confirmed. You can write your journal manually.'}</p>
            {incomplete && <p>Transcription was incomplete; the original above contains confirmed text only.</p>}
            {unconfirmedText && <p className="record-interim">Unconfirmed last phrase: {unconfirmedText}</p>}
          </details>
          {(phase === 'saved' || saveUnknown) && <Link className="record-journal-link" to={phase === 'saved' && savedEntry?.id ? `/journal/${encodeURIComponent(savedEntry.id)}` : '/'}
            target={saveUnknown ? '_blank' : undefined} rel={saveUnknown ? 'noopener noreferrer' : undefined}>
            {phase === 'saved' ? savedEntry?.id ? 'View journal' : 'View journals' : 'Check journals in a new tab'}
          </Link>}
          {saveUnknown && <p className="record-draft-help">The draft is locked while the save result is uncertain. {capabilities.idempotentSaveAvailable
            ? 'You can safely retry this save.' : 'Automatic retry is unavailable. Check your journals before discarding this draft.'}</p>}
        </>
      )}
      {capture.url && <AudioPlayback key={capture.url} url={capture.url} />}
    </section>
  );
}
