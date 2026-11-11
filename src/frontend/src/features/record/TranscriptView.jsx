import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { contentLength, transcriptText, validContent } from './transcriptState.js';
import AudioPlayback from './AudioPlayback.jsx';

export default function TranscriptView({ model }) {
  const { phase, transcript, editorText, originalTranscript, unconfirmedText, proposedDraft,
    incomplete, capture, saveUnknown, capabilities, flow } = model;
  const { finalizedTranscript, interimTranscript } = transcriptText(transcript);
  const area = useRef(null), editor = useRef(null), following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const review = ['review', 'saving', 'saved'].includes(phase);
  const count = contentLength(editorText);
  useEffect(() => {
    if (area.current && following.current) area.current.scrollTop = area.current.scrollHeight;
  }, [finalizedTranscript, interimTranscript]);
  useEffect(() => { if (phase === 'review') editor.current?.focus({ preventScroll: true }); }, [phase]);
  function followLatest() {
    following.current = true; setShowLatest(false);
    area.current.scrollTop = area.current.scrollHeight;
  }
  return (
    <section className="record-transcript" aria-label={review ? 'Review your journal' : 'Live transcript'}>
      {!review && (
        <>
          <div className="record-live" ref={area} role="log" aria-live="polite" tabIndex={0}
            onScroll={() => {
              const el = area.current;
              following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              setShowLatest(!following.current);
            }}>
            {finalizedTranscript && <span>{finalizedTranscript}</span>}
            {interimTranscript && <span className="record-interim">{finalizedTranscript ? ' ' : ''}{interimTranscript}</span>}
            {!finalizedTranscript && !interimTranscript && <p className="record-transcript-hint">
              {phase === 'recording' && model.transcriptionActive ? 'Listening for your words…'
                : phase === 'recording' ? 'Recording audio locally. Stop to review and write your journal.' : 'Your words and review draft belong here.'}
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
              <label className="visually-hidden" htmlFor="record-draft">Review and edit your journal</label>
              <textarea id="record-draft" ref={editor} className="record-editor" value={editorText}
                onChange={event => flow.edit(event.target.value)} readOnly={phase === 'saving' || saveUnknown}
                aria-describedby="record-draft-help" aria-invalid={count > 5000} />
              <p id="record-draft-help" className="record-draft-help">
                {count}/5000 characters. {count > 5000 ? 'Shorten the draft before saving. Your full text has been kept.' : 'Only the text in this editor will be saved.'}
              </p>
            </>
          )}
          <details className="record-original">
            <summary>{proposedDraft ? 'Compare with original transcript' : 'Original confirmed transcript'}</summary>
            <p>{originalTranscript || 'No speech was confirmed. You can write your journal manually.'}</p>
            {incomplete && <p>Transcription was incomplete; the original above contains confirmed text only.</p>}
            {unconfirmedText && <p className="record-interim">Unconfirmed last phrase: {unconfirmedText}</p>}
          </details>
          {phase !== 'saved' && (
            <button className="record-action record-save" type="button" onClick={flow.save}
              disabled={phase === 'saving' || !validContent(editorText) || (saveUnknown && !capabilities.idempotentSaveAvailable)}>
              {phase === 'saving' ? 'Saving…' : saveUnknown ? 'Retry same save' : 'Save journal'}
            </button>
          )}
          {(phase === 'saved' || saveUnknown) && <Link className="record-journal-link" to="/"
            target={saveUnknown ? '_blank' : undefined} rel={saveUnknown ? 'noopener noreferrer' : undefined}>
            {phase === 'saved' ? 'View journal' : 'Check journals in a new tab'}
          </Link>}
          {saveUnknown && <p className="record-draft-help">The draft is locked while the save result is uncertain. {capabilities.idempotentSaveAvailable
            ? 'Retry safely using the same request.' : 'Safe retry needs backend idempotency support; check your journals before resetting.'}</p>}
        </>
      )}
      {capture.url && <AudioPlayback key={capture.url} url={capture.url} />}
    </section>
  );
}
