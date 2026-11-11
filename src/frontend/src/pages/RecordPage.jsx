import RecordButton from '../features/record/RecordButton.jsx';
import RecordBackground from '../features/record/RecordBackground.jsx';

function TranscriptPanel() {
  return (
    <section className="record-transcript" aria-labelledby="record-transcript-heading">
      <h2 id="record-transcript-heading">YOUR WORDS WILL APPEAR HERE</h2>
      <p>Live transcription will appear here in a future update.</p>
    </section>
  );
}

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

export default function Record({ backgroundImage, backgroundStatus = 'ready', onOpenSidebar }) {
  return (
    <main className="record-page" aria-label="Record journal">
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
        <RecordButton />
        <TranscriptPanel />
      </div>

      <JournalMascot />

      <span className="record-back">{'←  Back to Main'}</span>
    </main>
  );
}
