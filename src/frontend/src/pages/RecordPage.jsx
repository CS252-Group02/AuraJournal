import RecordButton from '../features/record/RecordButton.jsx';
import RecordBackground from '../features/record/RecordBackground.jsx';
import TranscriptView from '../features/record/TranscriptView.jsx';
import { useRecordFlow } from '../features/record/useRecordFlow.js';

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
  function reset() {
    if ((model.editorText || model.phase === 'proofreading' || model.saveUnknown) && model.phase !== 'saved' &&
        !window.confirm('Discard this take and unsaved draft? A save with an unknown result may already exist in your journals.')) return;
    model.flow.reset();
  }
  return (
    <main className="record-page" aria-label="Record journal" data-has-record-image={Boolean(backgroundImage)}>
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

      <span className="record-back">{'←  Back to Main'}</span>
    </main>
  );
}
