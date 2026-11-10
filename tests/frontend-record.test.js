import assert from 'node:assert/strict';
import test from 'node:test';
import { createAudioRecorder } from '../src/frontend/src/features/record/audioRecorder.js';

function event(type, properties = {}) {
  return Object.assign(new Event(type), properties);
}

function setup(options = {}) {
  const track = Object.assign(new EventTarget(), {
    readyState: 'live', stops: 0,
    stop() { this.readyState = 'ended'; this.stops++; },
    getSettings: () => ({ sampleRate: 48000, channelCount: 1, deviceId: 'private-device' }),
  });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const calls = [], instances = [], revoked = [], created = [], timers = new Map();
  class Recorder extends EventTarget {
    static isTypeSupported(type) { return (options.supported || ['audio/webm;codecs=opus']).includes(type); }
    constructor(input, config) {
      super();
      if (options.constructError) throw new Error('constructor failed');
      assert.equal(input, stream);
      this.mimeType = config?.mimeType || 'audio/mp4';
      this.state = 'inactive';
      instances.push(this);
    }
    start(timeslice) {
      if (options.startError) throw new Error('start failed');
      this.state = 'recording';
      this.timeslice = timeslice;
    }
    chunk(text) { this.dispatchEvent(event('dataavailable', { data: new Blob([text], { type: this.mimeType }) })); }
    stop() {
      if (options.stopError) throw new Error('stop failed');
      this.state = 'inactive';
      if (options.noStopEvent) return;
      queueMicrotask(() => { this.chunk(options.empty ? '' : 'tail'); this.dispatchEvent(event('stop')); });
    }
  }
  const mediaDevices = { getUserMedia: async (constraints) => {
    calls.push(constraints);
    if (options.permission) return options.permission();
    if (options.error) throw { name: options.error };
    return stream;
  } };
  const recorder = createAudioRecorder({ mediaDevices,
    MediaRecorder: options.unsupported ? null : Recorder,
    secureContext: options.secureContext,
    urls: { createObjectURL(blob) {
      if (options.urlError) throw new Error('URL failed');
      created.push(blob); return `blob:recording-${created.length}`;
    }, revokeObjectURL: (url) => revoked.push(url) },
    schedule: (fn) => { const id = timers.size + 1; timers.set(id, fn); return id; },
    cancel: (id) => timers.delete(id),
  });
  return { recorder, calls, instances, track, stream, revoked, created, timers };
}

test('Start captures once; Stop releases tracks and waits for the final chunk with the actual MIME type', async () => {
  const { recorder, calls, instances, track, stream, timers } = setup();
  const states = [];
  const unsubscribe = recorder.subscribe(() => states.push(recorder.getSnapshot().status));
  assert.equal(recorder.getSnapshot().status, 'ready');
  const pending = recorder.start();
  assert.equal(recorder.getSnapshot().status, 'requesting_permission');
  await pending;
  assert.deepEqual(calls, [{ audio: true }]);
  assert.equal(recorder.getStream(), stream);
  assert.equal(instances[0].timeslice, 250);
  assert.deepEqual(recorder.getSnapshot().captureSettings, { sampleRate: 48000, channelCount: 1 });
  instances[0].chunk('header');
  recorder.stop(); recorder.stop();
  assert.equal(recorder.getSnapshot().status, 'stopping');
  assert.equal(track.readyState, 'ended');
  await Promise.resolve();
  const value = recorder.getSnapshot();
  assert.equal(value.status, 'stopped');
  assert.equal(await value.blob.text(), 'headertail');
  assert.equal(value.blob.type, instances[0].mimeType);
  assert.equal(value.mimeType, instances[0].mimeType);
  assert.equal(value.url, 'blob:recording-1');
  assert.equal(recorder.getStream(), null);
  assert.equal(timers.size, 0);
  assert.deepEqual(states, ['requesting_permission', 'recording', 'stopping', 'stopped']);
  unsubscribe(); recorder.reset();
});

for (const [name, message] of [
  ['NotAllowedError', /access was denied/], ['SecurityError', /access was denied/],
  ['NotFoundError', /No microphone/], ['NotReadableError', /Close other apps/], ['AbortError', /could not start/],
]) {
  test(`capture failure ${name} has useful feedback and does not retain media`, async () => {
    const { recorder } = setup({ error: name });
    await recorder.start();
    assert.equal(recorder.getSnapshot().status, 'error');
    assert.match(recorder.getSnapshot().error, message);
    assert.equal(recorder.getStream(), null);
    assert.equal(recorder.getSnapshot().blob, null);
  });
}

test('unsupported browsers and insecure contexts fail without asking for permission', async () => {
  for (const options of [{ unsupported: true }, { secureContext: false }]) {
    const { recorder, calls } = setup(options);
    await recorder.start();
    assert.equal(recorder.getSnapshot().status, 'error');
    assert.equal(calls.length, 0);
  }
});

test('missing mediaDevices and streams without a live audio track are handled', async () => {
  const { recorder, instances } = setup();
  const unsupported = createAudioRecorder({ mediaDevices: {}, MediaRecorder: class {} });
  await unsupported.start();
  assert.equal(unsupported.getSnapshot().status, 'error');
  for (const ended of [false, true]) {
    let stops = 0;
    const track = { readyState: ended ? 'ended' : 'live', stop() { stops++; } };
    const owner = createAudioRecorder({ mediaDevices: { getUserMedia: async () => ({
      getTracks: () => [track], getAudioTracks: () => ended ? [track] : [],
    }) }, MediaRecorder: class {} });
    await owner.start();
    assert.match(owner.getSnapshot().error, /No microphone/);
    assert.equal(stops, ended ? 0 : 1);
  }
  assert.equal(instances.length, 0);
  assert.equal(recorder.getSnapshot().status, 'ready');
});

test('duplicate Start is prevented while asking, recording, stopping, and holding a recording', async () => {
  const { recorder, calls, instances } = setup();
  const first = recorder.start();
  await recorder.start();
  await first;
  await recorder.start();
  recorder.stop(); await recorder.start();
  await Promise.resolve(); await recorder.start();
  assert.equal(calls.length, 1);
  assert.equal(instances.length, 1);
  assert.equal(recorder.getSnapshot().status, 'stopped');
  recorder.reset();
});

test('Reset/unmount discards media, stops capture, removes listeners and ignores late stop events', async () => {
  const { recorder, track, instances, created, timers } = setup();
  await recorder.start();
  instances[0].chunk('private-audio');
  recorder.reset();
  await Promise.resolve();
  instances[0].dispatchEvent(event('error'));
  track.dispatchEvent(event('ended'));
  assert.equal(track.readyState, 'ended');
  assert.equal(recorder.getStream(), null);
  assert.equal(recorder.getSnapshot().status, 'ready');
  assert.equal(recorder.getSnapshot().blob, null);
  assert.equal(created.length, 0);
  assert.equal(timers.size, 0);
});

test('Reset revokes the playback URL; initial Strict Mode cleanup still allows recording', async () => {
  const { recorder, revoked } = setup();
  recorder.reset(); // Initial Strict Mode effect cleanup does not disable the owner.
  await recorder.start(); recorder.stop(); await Promise.resolve();
  recorder.reset(); recorder.reset();
  assert.deepEqual(revoked, ['blob:recording-1']);
  assert.equal(recorder.getSnapshot().url, '');
  assert.equal(recorder.getSnapshot().mimeType, '');
});

test('a permission grant after Reset/unmount stops its tracks immediately', async () => {
  let grant;
  const harness = setup({ permission: () => new Promise(resolve => { grant = resolve; }) });
  const pending = harness.recorder.start();
  harness.recorder.reset();
  grant(harness.stream);
  await pending;
  assert.equal(harness.track.readyState, 'ended');
  assert.equal(harness.instances.length, 0);
  assert.equal(harness.recorder.getSnapshot().status, 'ready');
});

test('a stale permission rejection cannot interrupt a newer recording', async () => {
  let rejectOld, requests = 0;
  let harness;
  harness = setup({ permission: () => ++requests === 1
    ? new Promise((resolve, reject) => { rejectOld = reject; }) : Promise.resolve(harness.stream) });
  const old = harness.recorder.start();
  harness.recorder.reset();
  await harness.recorder.start();
  rejectOld({ name: 'NotAllowedError' }); await old;
  assert.equal(harness.recorder.getSnapshot().status, 'recording');
  assert.equal(harness.track.readyState, 'live');
  harness.recorder.reset();
});

test('constructor/start failures release microphone tracks', async () => {
  for (const options of [{ constructError: true }, { startError: true }]) {
    const { recorder, track } = setup(options);
    await recorder.start();
    assert.equal(track.readyState, 'ended');
    assert.equal(recorder.getStream(), null);
    assert.equal(recorder.getSnapshot().status, 'error');
  }
});

test('format selection honors supported formats and keeps the browser default when needed', async () => {
  for (const supported of [['audio/ogg;codecs=opus'], ['audio/mp4'], []]) {
    const { recorder, instances } = setup({ supported });
    await recorder.start(); recorder.stop(); await Promise.resolve();
    assert.equal(recorder.getSnapshot().blob.type, instances[0].mimeType);
    recorder.reset();
  }
});

test('chunk subscribers consume the same ordered session without another microphone request', async () => {
  const { recorder, instances, calls } = setup();
  const chunks = [];
  const unsubscribe = recorder.subscribeToChunks(chunk => chunks.push(chunk));
  await recorder.start(); instances[0].chunk('first');
  recorder.stop(); await Promise.resolve();
  assert.equal(await new Blob(chunks).text(), 'firsttail');
  assert.equal(calls.length, 1);
  unsubscribe(); recorder.reset();
});

test('device disconnection and recorder errors preserve collected audio with an error', async () => {
  for (const source of ['track', 'recorder']) {
    const { recorder, track, instances } = setup();
    await recorder.start(); instances[0].chunk('captured');
    if (source === 'track') track.dispatchEvent(event('ended'));
    else instances[0].dispatchEvent(event('error'));
    await Promise.resolve();
    assert.equal(recorder.getSnapshot().status, 'error');
    assert.ok(recorder.getSnapshot().blob.size > 0);
    assert.equal(track.readyState, 'ended');
    assert.equal(recorder.getStream(), null);
    recorder.reset();
  }
});

test('missing stop events and thrown stop calls cannot leak a microphone', async () => {
  for (const options of [{ noStopEvent: true }, { stopError: true }]) {
    const { recorder, instances, track, timers } = setup(options);
    await recorder.start(); instances[0].chunk('partial'); recorder.stop();
    for (const callback of timers.values()) callback();
    assert.equal(track.readyState, 'ended');
    assert.equal(recorder.getSnapshot().status, 'error');
    assert.ok(recorder.getSnapshot().blob);
    assert.equal(timers.size, 0);
    recorder.reset();
  }
});

test('empty recordings and object URL failures have recoverable error states', async () => {
  for (const options of [{ empty: true }, { urlError: true }]) {
    const { recorder } = setup(options);
    await recorder.start(); recorder.stop(); await Promise.resolve();
    assert.equal(recorder.getSnapshot().status, 'error');
    assert.equal(recorder.getSnapshot().url, '');
    assert.ok(recorder.getSnapshot().error);
    recorder.reset();
    assert.equal(recorder.getSnapshot().status, 'ready');
  }
});
