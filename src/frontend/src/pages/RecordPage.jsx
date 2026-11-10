function RecordButton() {
  return (
    <div className="record-primary">
      <div className="record-orbit">
        <button className="record-trigger" type="button" aria-labelledby="record-label" disabled />
      </div>
      <p className="record-label" id="record-label">Record</p>
    </div>
  );
}

function TranscriptPanel() {
  return (
    <section className="record-transcript" aria-labelledby="record-transcript-heading">
      <h2 id="record-transcript-heading">YOUR WORDS WILL APPEAR HERE</h2>
      <p>Your voice will become words here as you speak.</p>
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

// Static Ready state. The background source can be supplied independently of the UI.
export default function Record({ backgroundImage }) {
  return (
    <main className="record-page" aria-label="Record journal">
      <div className="record-background" aria-hidden="true">
        {backgroundImage && <img className="record-background-image" src={backgroundImage} alt="" />}
      </div>

      <header className="record-header">
        <button className="record-sidebar-toggle" type="button" aria-label="Open sidebar" disabled>
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
