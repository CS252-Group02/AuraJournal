import { useEffect, useRef, useState } from 'react';
import { useAudioRecorder } from './useAudioRecorder.js';

function AudioPlayback({ url }) {
  const audio = useRef(null);
  const active = useRef(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const element = audio.current;
    active.current = true;
    element.src = url;
    return () => {
      active.current = false;
      element.pause();
      element.removeAttribute('src');
      element.load();
    };
  }, [url]);

  async function replay() {
    setError('');
    try {
      audio.current.currentTime = 0;
      await audio.current.play();
    } catch {
      if (active.current) setError('Playback could not start. Try the audio controls again or reset your recording.');
    }
  }

  return (
    <div className="record-playback">
      <audio
        ref={audio}
        src={url}
        controls
        preload="metadata"
        aria-label="Your recorded audio"
        onPlay={() => { setPlaying(true); setError(''); }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => { setPlaying(false); setError('This audio could not be played. Try replaying it or reset to record again.'); }}
      />
      <button type="button" className="record-action" onClick={replay} disabled={playing}>Replay recording</button>
      {error && <p className="record-feedback record-error" role="alert">{error}</p>}
    </div>
  );
}

export default function RecordButton() {
  const { status, url, blob, error, recorder } = useAudioRecorder();
  const recording = status === 'recording';
  const waiting = status === 'requesting_permission' || status === 'stopping';
  const canStart = (status === 'ready' || status === 'error') && !blob;
  const label = recording ? 'Stop' : status === 'requesting_permission' ? 'Allow microphone' : status === 'stopping' ? 'Stopping…' : 'Record';
  const message = {
    ready: 'Ready when you are. Your audio stays in this browser.',
    requesting_permission: 'Allow microphone access in your browser to begin.',
    recording: 'Recording… Select Stop when you are finished.',
    stopping: 'Finishing your recording…',
    stopped: 'Recording ready. Listen below or reset to start again.',
  }[status];

  return (
    <div className="record-primary" data-recording-state={status}>
      <div className="record-orbit">
        <button
          className={`record-trigger${recording ? ' is-recording' : ''}`}
          type="button"
          aria-label={recording ? 'Stop recording' : 'Start recording'}
          aria-describedby="record-feedback"
          disabled={waiting || (!recording && !canStart)}
          onClick={recording ? recorder.stop : recorder.start}
        />
      </div>
      <p className="record-label" id="record-label">{label}</p>
      <p id="record-feedback" className={`record-feedback${error ? ' record-error' : ''}`} role={error ? 'alert' : 'status'}>{error || message}</p>
      {url && <AudioPlayback key={url} url={url} />}
      {status !== 'ready' && (
        <button type="button" className="record-action" onClick={recorder.reset}>
          {status === 'requesting_permission' ? 'Cancel' : 'Reset'}
        </button>
      )}
    </div>
  );
}
