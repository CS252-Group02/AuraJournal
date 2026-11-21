export default function RecordButton({ model, onReset }) {
  const { phase, capture, error, warning, flow, capabilities, elapsedSeconds } = model;
  const captureLayout = ['ready', 'connecting', 'recording', 'error'].includes(phase);
  const duration = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:${String(elapsedSeconds % 60).padStart(2, '0')}`;
  const recording = phase === 'recording' && capture.status === 'recording';
  const waiting = phase === 'connecting' || phase === 'finalizing' || capture.status === 'requesting_permission';
  const canStart = ['ready', 'error'].includes(phase) && !capture.blob;
  const label = recording ? 'Stop' : capture.status === 'requesting_permission' ? 'Allow microphone'
    : phase === 'connecting' ? 'Connecting…' : phase === 'finalizing' ? 'Finalizing…' : 'Record';
  const message = {
    ready: capabilities.transcriptionAvailable ? 'Audio is sent for live transcription. Up to five minutes.'
      : capabilities.uploadAvailable ? 'Audio is uploaded for transcription after Stop.' : '',
    connecting: 'Connecting…',
    recording: 'Recording…',
    finalizing: 'Finishing…',
    transcribing: 'Uploading and transcribing… up to 100 seconds.',
    proofreading: 'Proofreading…',
    review: '',
    saving: 'Saving your journal…',
    saved: 'Journal saved.',
  }[phase];
  return (
    <div className="record-primary" data-recording-state={capture.status} data-record-phase={phase}>
      {captureLayout && <div className="record-orbit">
        <button className={`record-trigger${recording ? ' is-recording' : ''}`} type="button"
          aria-label={recording ? 'Stop recording' : label} aria-describedby="record-feedback"
          disabled={waiting || (!recording && !canStart)} onClick={recording ? flow.stop : () => flow.start()} />
      </div>}
      {captureLayout && <p className="record-label">{label}</p>}
      {!captureLayout && <h2 className="record-phase-title">{{ finalizing: 'Finishing recording', transcribing: 'Transcribing recording', proofreading: 'AI proofreading', review: 'Review your journal', saving: 'Saving your journal', saved: 'Journal saved' }[phase]}</h2>}
      {!['ready', 'connecting', 'error'].includes(phase) && <p className="record-duration" aria-live="off">
        {recording ? 'Recording time' : 'Recorded duration'} <span>{duration}</span>
      </p>}
      <p id="record-feedback" className={`record-feedback${error ? ' record-error' : ''}`} role={error ? 'alert' : 'status'}>
        {error || (capture.status === 'requesting_permission' ? 'Allow microphone access in your browser, or select Cancel.' : message)}
      </p>
      {warning && <p className="record-feedback" role="status">{warning}</p>}
      {phase === 'transcribing' && <button className="record-action" type="button" onClick={flow.cancelUpload}>Cancel transcription</button>}
      {phase === 'error' && capabilities.transcriptionAvailable && !capture.blob && (
        <button className="record-action" type="button" onClick={() => flow.start({ localOnly: true })}>Record locally instead</button>
      )}
      {phase !== 'ready' && <button className="record-action" type="button" onClick={onReset} disabled={phase === 'saving'}>
        {phase === 'connecting' ? 'Cancel' : phase === 'saved' ? 'Record another journal' : 'Discard take'}
      </button>}
    </div>
  );
}
