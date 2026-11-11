const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
const READY = { status: 'ready', blob: null, url: '', mimeType: '', captureSettings: null, error: '' };

function captureError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was denied. Allow microphone access in your browser, then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found. Connect a microphone, then try again.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Your microphone could not be opened. Close other apps using it, then try again.';
    case 'NotSupportedError':
      return 'This browser cannot record a format accepted by live transcription. You can record locally instead.';
    default:
      return 'Recording could not start. Check your microphone and try again.';
  }
}

// One owner for permission requests, the live stream, recorder, Blob, and URL.
// Dependencies are injectable so lifecycle/privacy behavior can be tested without hardware.
export function createAudioRecorder({
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorder = globalThis.MediaRecorder,
  urls = globalThis.URL,
  secureContext = globalThis.isSecureContext !== false,
  schedule = globalThis.setTimeout,
  cancel = globalThis.clearTimeout,
} = {}) {
  let snapshot = READY;
  let generation = 0;
  let session = null;
  const listeners = new Set();
  const chunkListeners = new Set();
  const publish = (value) => {
    snapshot = { ...snapshot, ...value };
    listeners.forEach((listener) => listener());
  };
  const stopTracks = (stream) => stream.getTracks().forEach((track) => {
    if (track.readyState !== 'ended') track.stop();
  });

  function finish(current) {
    if (session !== current) return;
    current.cleanup();
    session = null;
    const mimeType = current.recorder.mimeType || current.chunks[0]?.type || current.mimeType;
    const blob = new Blob(current.chunks, { type: mimeType });
    let url = '';
    let error = current.error;
    if (blob.size) {
      try { url = urls.createObjectURL(blob); }
      catch { error = 'Your recording could not be opened for playback. Reset to try again.'; }
    } else {
      error ||= 'No audio was captured. Check your microphone and try again.';
    }
    publish({ status: error ? 'error' : 'stopped', blob: blob.size ? blob : null, url, mimeType, error });
    current.resolveStop(snapshot);
  }

  function stop(error = '') {
    const current = session;
    if (!current) return Promise.resolve(snapshot);
    current.error ||= error;
    if (current.stopping) return current.completion;
    current.stopping = true;
    publish({ status: 'stopping' });
    // Wait for final dataavailable/stop, but never hold a microphone indefinitely.
    current.timer = schedule(() => {
      current.error ||= 'Recording could not finish normally. Any captured audio is kept below.';
      finish(current);
    }, 5000);
    try {
      if (current.recorder.state !== 'inactive') current.recorder.stop();
    } catch {
      current.error ||= 'Recording could not finish normally. Any captured audio is kept below.';
      finish(current);
    } finally {
      stopTracks(current.stream);
    }
    return current.completion;
  }

  async function start({ allowedMimeTypes } = {}) {
    if (session || !['ready', 'error'].includes(snapshot.status) || snapshot.blob) return;
    if (!secureContext) {
      publish({ status: 'error', error: 'Microphone recording needs HTTPS or localhost. Open AuraJournal using a secure connection.' });
      return;
    }
    if (!mediaDevices?.getUserMedia || !MediaRecorder) {
      publish({ status: 'error', error: 'Audio recording is not supported in this browser. Try a browser with microphone recording support.' });
      return;
    }
    const request = ++generation;
    publish({ status: 'requesting_permission', error: '' });
    let stream;
    try {
      const candidates = allowedMimeTypes ? MIME_TYPES.filter(type => allowedMimeTypes.includes(type)) : MIME_TYPES;
      const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
      if (allowedMimeTypes && !mimeType) throw new DOMException('No agreed recording format.', 'NotSupportedError');
      stream = await mediaDevices.getUserMedia({ audio: true });
      if (request !== generation) { stopTracks(stream); return; }
      const tracks = stream.getAudioTracks();
      if (!tracks.length || tracks.some((track) => track.readyState === 'ended')) {
        throw new DOMException('No live audio track.', 'NotFoundError');
      }
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      if (allowedMimeTypes && !allowedMimeTypes.includes(recorder.mimeType || mimeType)) {
        throw new DOMException('Unexpected recording format.', 'NotSupportedError');
      }
      const current = { stream, recorder, mimeType, chunks: [], error: '', stopping: false, timer: null };
      current.completion = new Promise(resolve => { current.resolveStop = resolve; });
      const onData = ({ data }) => {
        if (session !== current || !data.size) return;
        current.chunks.push(data);
        // Ordered container chunks, not independently decodable files or PCM.
        chunkListeners.forEach((listener) => listener(data));
      };
      const onStop = () => finish(current);
      const onError = () => stop('Recording was interrupted. Any captured audio is kept below. Reset to try again.');
      const onEnded = () => stop('The microphone was disconnected. Any captured audio is kept below.');
      current.cleanup = () => {
        cancel(current.timer);
        recorder.removeEventListener('dataavailable', onData);
        recorder.removeEventListener('stop', onStop);
        recorder.removeEventListener('error', onError);
        tracks.forEach((track) => track.removeEventListener('ended', onEnded));
        stopTracks(stream);
      };
      session = current;
      recorder.addEventListener('dataavailable', onData);
      recorder.addEventListener('stop', onStop);
      recorder.addEventListener('error', onError);
      tracks.forEach((track) => track.addEventListener('ended', onEnded));
      recorder.start(250);
      const settings = tracks[0].getSettings?.() || {};
      publish({ status: 'recording', mimeType: recorder.mimeType || mimeType,
        captureSettings: { sampleRate: settings.sampleRate, channelCount: settings.channelCount } });
    } catch (error) {
      if (request !== generation) {
        if (stream) stopTracks(stream);
        return;
      }
      if (session) {
        session.cleanup();
        if (session.recorder.state !== 'inactive') {
          try { session.recorder.stop(); } catch { /* Capture tracks are already stopped. */ }
        }
        session.resolveStop({ ...snapshot, status: 'error', error: captureError(error) });
        session = null;
      } else if (stream) stopTracks(stream);
      publish({ status: 'error', error: captureError(error) });
    }
  }

  function reset() {
    ++generation; // Also invalidates a permission response that arrives after unmount/reset.
    const current = session;
    session = null;
    if (current) {
      current.cleanup();
      if (current.recorder.state !== 'inactive') {
        try { current.recorder.stop(); } catch { /* Tracks are already released. */ }
      }
      current.resolveStop({ ...READY, cancelled: true });
    }
    if (snapshot.url) urls.revokeObjectURL(snapshot.url);
    publish(READY);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    start,
    stop: () => stop(),
    reset,
    // Borrow this same stream for a future encoder; consumers must not stop its tracks.
    getStream: () => session?.stream || null,
    subscribeToChunks: (listener) => { chunkListeners.add(listener); return () => chunkListeners.delete(listener); },
  };
}
