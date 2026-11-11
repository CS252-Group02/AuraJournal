// Adapter for the proposed application protocol. No endpoint is enabled by default.
// The backend must normalize provider-specific events into this contract.
export function createTranscriptionSession({ url, onSegment, onFailure,
  Socket = globalThis.WebSocket, schedule = setTimeout, cancel = clearTimeout,
  connectTimeout = 10000, finalTimeout = 15000, maxBufferedBytes = 1024 * 1024,
}) {
  let socket, sessionId, ready, accepted = [], closed = false, started = false;
  let queue = [], queuedBytes = 0;
  const waiters = new Map();
  function waitFor(type, timeout) {
    return new Promise((resolve, reject) => {
      const timer = schedule(() => fail(new Error(type === 'complete'
        ? 'Final transcription results did not arrive in time.' : 'Live transcription could not connect in time.')), timeout);
      waiters.set(type, { resolve, reject, timer });
    });
  }
  function settle(type, value) {
    const waiter = waiters.get(type);
    if (!waiter) return;
    cancel(waiter.timer); waiters.delete(type); waiter.resolve(value);
  }
  function close(error = new DOMException('Transcription cancelled.', 'AbortError')) {
    if (closed) return;
    closed = true; queue = []; queuedBytes = 0;
    for (const waiter of waiters.values()) { cancel(waiter.timer); waiter.reject(error); }
    waiters.clear();
    if (socket) {
      socket.removeEventListener('message', receive);
      socket.removeEventListener('error', connectionError);
      socket.removeEventListener('close', disconnected);
      socket.close();
    }
  }
  function fail(error) {
    if (closed) return;
    close(error); onFailure?.(error);
  }
  const connectionError = () => fail(new Error('Live transcription is unavailable. Your local audio is still available.'));
  const disconnected = () => fail(new Error('Live transcription disconnected. Stop to review the confirmed text and your audio.'));
  function send(message) {
    if (closed || socket?.readyState !== 1) throw new Error('The transcription connection is closed.');
    socket.send(JSON.stringify({ ...message, session_id: sessionId }));
  }
  function drain() {
    if (!started || closed) return;
    try {
      for (const blob of queue) {
        if (socket.bufferedAmount + blob.size > maxBufferedBytes) throw new Error('Live transcription cannot keep up. Your audio is still recorded locally.');
        // Sending Blob values directly avoids asynchronous conversions reordering chunks.
        socket.send(blob);
      }
      queue = []; queuedBytes = 0;
    } catch (error) { fail(error); }
  }
  function receive({ data }) {
    if (closed) return;
    try {
      const message = JSON.parse(data);
      if (message.type === 'ready' && !sessionId) {
        if (typeof message.session_id !== 'string' || !message.session_id ||
            !Array.isArray(message.accepted_mime_types) || !message.accepted_mime_types.length ||
            !message.accepted_mime_types.every(type => typeof type === 'string' && type.startsWith('audio/'))) throw new Error('Invalid transcription format negotiation.');
        sessionId = message.session_id; accepted = message.accepted_mime_types;
        settle('ready', { acceptedMimeTypes: accepted });
        return;
      }
      if (message.type === 'error') {
        if (sessionId && message.session_id !== sessionId) return;
        const error = new Error('The transcription service could not finish this recording.');
        error.code = message.code;
        fail(error); return;
      }
      if (!sessionId || message.session_id !== sessionId) return;
      if (message.type === 'started') { started = true; settle('started'); drain(); }
      else if (message.type === 'segment') onSegment(message);
      else if (message.type === 'complete') {
        if (!waiters.has('complete') || !Number.isSafeInteger(message.final_count) || message.final_count < 0) throw new Error('Invalid transcription completion.');
        settle('complete', message); close();
      }
    } catch (error) { fail(error); }
  }
  return {
    async open() {
      if (socket || closed) throw new Error('This transcription session cannot be reopened.');
      ready = waitFor('ready', connectTimeout);
      try {
        socket = new Socket(url);
        socket.addEventListener('message', receive);
        socket.addEventListener('error', connectionError);
        socket.addEventListener('close', disconnected);
      } catch (error) { fail(error); }
      return ready;
    },
    async start(mimeType) {
      if (closed) throw new Error('The transcription connection is closed.');
      if (!accepted.includes(mimeType)) throw new Error('This audio format was not accepted by transcription.');
      const result = waitFor('started', connectTimeout);
      try { send({ type: 'start', mime_type: mimeType, language: 'vi' }); } catch (error) { fail(error); }
      return result;
    },
    push(blob) {
      if (closed) return;
      queuedBytes += blob.size;
      if (queuedBytes + (socket?.bufferedAmount || 0) > maxBufferedBytes) {
        fail(new Error('Live transcription cannot keep up. Your audio is still recorded locally.')); return;
      }
      queue.push(blob); drain();
    },
    async finish() {
      if (closed || !started) throw new Error('The transcription session ended before finalization.');
      const result = waitFor('complete', finalTimeout);
      drain();
      if (!closed) { try { send({ type: 'finish' }); } catch (error) { fail(error); } }
      return result;
    },
    close,
  };
}
