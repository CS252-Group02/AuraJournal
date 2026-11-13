import RecordButton from '../features/record/RecordButton.jsx';
import RecordBackground from '../features/record/RecordBackground.jsx';
import TranscriptView from '../features/record/TranscriptView.jsx';
import { useRecordFlow } from '../features/record/useRecordFlow.js';
import { Link } from 'react-router-dom';

function JournalMascot() {
  return (
    <aside className="record-mascot" aria-label="Your journal companion">
      <p className="record-mascot-speech">Whenever you are ready, I am here.</p>
      <div className="record-mascot-art" aria-hidden="true">
        <div className="record-mascot-face">
          <span className="record-mascot-eyes" />
          <span className="record-mascot-blush" />
        </div>
      </div>
    </aside>
  );
}

export default function Record({ backgroundImage, backgroundStatus = 'ready', onOpenSidebar, services }) {
  const model = useRecordFlow(services);
  function confirmDiscard() {
    if (model.phase === 'saving') return false;
    if (!model.hasUnsavedWork) return true;
    const message = model.saveUnknown
      ? 'Discard this draft? The save result is unknown and this journal may already exist. Check your journals before creating another entry.'
      : model.phase === 'recording'
        ? 'Stop recording and discard this take and its transcript?'
        : model.phase === 'connecting'
          ? 'Cancel this recording request?'
          : 'Discard this take and unsaved draft? Your audio and text will be lost.';
    return window.confirm(message);
  }
  function reset() {
    if (!confirmDiscard()) return;
    model.flow.reset();
  }
  function leave(event) {
    // A new tab leaves this take mounted and does not discard any work.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!confirmDiscard()) event.preventDefault();
  }
  return (
    <main className="record-page" aria-label="Record journal" data-record-phase={model.phase} data-has-record-image={Boolean(backgroundImage)}>
      <RecordBackground key={`${backgroundStatus}:${backgroundImage || ''}`} imageUrl={backgroundImage} status={backgroundStatus} />

      <header className="record-header">
        <button className="record-sidebar-toggle" type="button" aria-label="Open sidebar" disabled={!onOpenSidebar} onClick={onOpenSidebar}>
          <span aria-hidden="true">»</span>
        </button>
        <div className="record-brand">
          <h1>{'✦  AuraJournal'}</h1>
          <p>YOUR PRIVATE VOICE JOURNAL</p>
        </div>
      </header>

      <div className="record-content">
        <RecordButton model={model} onReset={reset} />
        <TranscriptView model={model} />
      </div>

      <JournalMascot />

      {model.phase === 'saving'
        ? <span className="record-back" aria-disabled="true">{'←  Back to Main'}</span>
        : <Link className="record-back" to="/" onClick={leave}>{'←  Back to Main'}</Link>}
    </main>
  );
}
