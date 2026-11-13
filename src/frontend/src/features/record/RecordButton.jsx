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
    ready: capabilities.transcriptionAvailable
      ? 'Audio is sent to the speech service while recording. Final text may be sent for AI proofreading. Your journal is saved only when you choose Save journal.'
      : 'Record locally and write your journal after stopping. Live transcription and automatic proofreading are not connected yet.',
    connecting: 'Preparing your recording…',
    recording: 'Recording… Select Stop when you are finished.',
    finalizing: 'Finishing audio and waiting for final speech results…',
    proofreading: 'Proofreading the confirmed transcript…',
    review: 'Review your draft below. Your changes are the version that will be saved.',
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
      {!captureLayout && <h2 className="record-phase-title">{{ finalizing: 'Finishing recording', proofreading: 'AI proofreading', review: 'Review your journal', saving: 'Saving your journal', saved: 'Journal saved' }[phase]}</h2>}
      {!['ready', 'connecting', 'error'].includes(phase) && <p className="record-duration" aria-live="off">
        {recording ? 'Recording time' : 'Recorded duration'} <span>{duration}</span>
      </p>}
      <p id="record-feedback" className={`record-feedback${error ? ' record-error' : ''}`} role={error ? 'alert' : 'status'}>
        {error || (capture.status === 'requesting_permission' ? 'Allow microphone access in your browser, or select Cancel.' : message)}
      </p>
      {warning && <p className="record-feedback" role="status">{warning}</p>}
      {phase === 'error' && capabilities.transcriptionAvailable && !capture.blob && (
        <button className="record-action" type="button" onClick={() => flow.start({ localOnly: true })}>Record locally instead</button>
      )}
      {phase !== 'ready' && <button className="record-action" type="button" onClick={onReset} disabled={phase === 'saving'}>
        {phase === 'connecting' ? 'Cancel' : phase === 'saved' ? 'Record another journal' : 'Discard take'}
      </button>}
    </div>
  );
}
