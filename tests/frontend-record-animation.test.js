import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { carriesInterim, createWordAnimations, reconcileTokens } from '../src/frontend/src/features/record/transcriptPresentation.js';
import { createTranscriptScroll } from '../src/frontend/src/features/record/transcriptScroll.js';
import { createTranscript, mergeSegment } from '../src/frontend/src/features/record/transcriptState.js';

const words = view => view.tokens.filter(token => token.word);
const text = view => view.tokens.map(token => token.text).join('');
const segment = (segment_id, order, text, is_final = false, revision = 0) => ({ segment_id, order, text, is_final, revision });

test('new words reveal while unchanged prefixes and repeated updates retain identity', () => {
  const first = reconcileTokens(null, 'Hôm nay tôi');
  assert.equal(first.changes.length, 3);
  assert.ok(first.changes.every(change => change.kind === 'reveal'));
  const second = reconcileTokens(first, 'Hôm nay tôi cảm');
  assert.deepEqual(words(second).slice(0, 3), words(first));
  assert.deepEqual(second.changes, [{ key: words(second).at(-1).key, kind: 'reveal' }]);
  const unchanged = reconcileTokens(second, 'Hôm nay tôi cảm');
  assert.deepEqual(unchanged.tokens, second.tokens);
  assert.deepEqual(unchanged.changes, []);
});

test('corrections preserve matching prefix/suffix and immediately replace the middle', () => {
  const first = reconcileTokens(null, 'Hôm nay tôi buồn lắm.');
  const corrected = reconcileTokens(first, 'Hôm nay tôi vui lắm.');
  assert.equal(text(corrected), 'Hôm nay tôi vui lắm.');
  assert.equal(words(corrected)[0], words(first)[0]);
  assert.equal(words(corrected).at(-1), words(first).at(-1));
  assert.deepEqual(corrected.changes, [{ key: words(corrected)[3].key, kind: 'correction' }]);
  const punctuated = reconcileTokens(corrected, 'Hôm nay tôi vui lắm!');
  assert.equal(punctuated.changes.length, 1);
  assert.equal(punctuated.changes[0].kind, 'correction');
  const deleted = reconcileTokens(punctuated, 'Hôm nay vui lắm!');
  assert.equal(text(deleted), 'Hôm nay vui lắm!');
  assert.deepEqual(deleted.changes, []);
  assert.deepEqual(reconcileTokens(deleted, '').tokens, []);
});

test('Unicode, whitespace, punctuation and actual repetitions are never normalized or deduplicated', () => {
  for (const value of ['  Hôm\tnay\n tôi  vui! ', 'Hôm nay 👍🏽 👨‍👩‍👧‍👦', 'Đúng rồi. Đúng rồi.', '你好，世界！', '']) {
    assert.equal(text(reconcileTokens(null, value)), value);
  }
  const first = reconcileTokens(null, 'Đúng rồi.');
  const second = reconcileTokens(first, 'Đúng rồi. Đúng rồi.');
  assert.equal(second.changes.length, 2);
  assert.equal(text(second), 'Đúng rồi. Đúng rồi.');
  const composed = reconcileTokens(null, 'Hôm');
  assert.equal(reconcileTokens(composed, 'Hôm').changes[0].kind, 'correction');
});

test('interim finalization preserves word keys; carried partial-final suffixes suppress only motion', () => {
  const interim = reconcileTokens(null, 'Hôm nay tôi đọc sách');
  const final = reconcileTokens(interim, 'Hôm nay');
  assert.deepEqual(words(final), words(interim).slice(0, 2));
  assert.deepEqual(final.changes, []);
  const previous = segment('a', 0, 'Hôm nay tôi đọc sách');
  const finals = [segment('a', 0, 'Hôm nay', true, 1)];
  const suffix = segment('b', 1, 'tôi đọc sách');
  assert.equal(carriesInterim(previous, finals, suffix), true);
  assert.equal(carriesInterim(previous, finals, segment('b', 1, 'đọc sách mới')), false);
  assert.equal(carriesInterim(previous, [], suffix), false);
  assert.equal(carriesInterim(previous, finals, previous), false);
  assert.equal(carriesInterim(segment('a', 0, 'again'), finals, segment('b', 1, 'again')), false);
  assert.equal(suffix.text, 'tôi đọc sách');
});

test('rapid revisions retain stable text without accumulating historical token metadata', () => {
  let view = reconcileTokens(null, 'Hôm nay tôi');
  const prefix = words(view);
  for (let index = 0; index < 500; index++) {
    view = reconcileTokens(view, `Hôm nay tôi cảm thấy ${index}.`);
    assert.deepEqual(words(view).slice(0, 3), prefix);
    assert.ok(view.tokens.length < 16);
    assert.ok(view.changes.length <= 3);
  }
  const reset = reconcileTokens(null, 'Hôm nay tôi');
  assert.equal(reset.nextKey, 5);
  assert.equal(reset.changes.length, 3);
});

function animationFixture() {
  const calls = [];
  const node = { animate(frames, options) {
    const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true; this.oncancel?.(); } };
    calls.push(animation); return animation;
  } };
  return { calls, node, animations: createWordAnimations() };
}

test('targeted effects use specified timings, supersede old effects and release completed handles', () => {
  const f = animationFixture();
  f.animations.reveal(1, f.node, 'reveal');
  assert.equal(f.calls[0].options.duration, 160);
  assert.equal(f.calls[0].frames[0].transform, 'translateY(4px)');
  f.animations.reveal(1, f.node, 'correction');
  assert.equal(f.calls[0].cancelled, true);
  assert.equal(f.calls[1].options.duration, 120);
  assert.equal(f.calls[1].frames[0].transform, undefined);
  f.animations.retain(new Set([1]));
  assert.equal(f.calls[1].cancelled, false);
  f.calls[1].onfinish(); f.animations.cancel();
  assert.equal(f.calls[1].cancelled, false); // Finished effects have been released.
});

test('Reset, Stop/reduced motion and unmount can cancel every effect with no delayed work', () => {
  const f = animationFixture();
  f.animations.reveal(1, f.node, 'reveal');
  f.animations.reveal(2, f.node, 'reveal');
  f.animations.retain(new Set([2]));
  assert.equal(f.calls[0].cancelled, true);
  assert.equal(f.calls[1].cancelled, false);
  f.animations.cancel(); f.animations.cancel();
  assert.ok(f.calls.every(animation => animation.cancelled));
  f.animations.reveal(3, {}, 'reveal'); // Missing browser API leaves readable base styles.
  assert.equal(f.calls.length, 2);
});

function scrollFixture() {
  let next = 0;
  const frames = new Map();
  const scroller = createTranscriptScroll({ request: callback => { frames.set(++next, callback); return next; },
    cancel: id => frames.delete(id) });
  return { scroller, frames, step(time) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)); } };
}

test('scroll coalesces rapid destinations into one loop without restarting its 220ms duration', () => {
  const f = scrollFixture(), el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 };
  f.scroller.follow(el); f.step(0); f.step(110);
  assert.equal(el.scrollTop, 700);
  el.scrollHeight = 1200;
  for (let i = 0; i < 100; i++) f.scroller.follow(el);
  assert.equal(f.frames.size, 1);
  f.step(220);
  assert.equal(el.scrollTop, 800); // Original destination completes on schedule.
  f.step(440);
  assert.equal(el.scrollTop, 1000);
  assert.equal(f.frames.size, 0);
});

test('manual scroll, Reset/unmount and reduced motion cancel scroll frames immediately', () => {
  const f = scrollFixture(), el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 };
  f.scroller.follow(el); f.step(0); f.step(50); f.scroller.cancel();
  const paused = el.scrollTop; f.step(220);
  assert.equal(el.scrollTop, paused);
  assert.equal(f.frames.size, 0);
  f.scroller.follow(el); f.scroller.follow(el, true);
  assert.equal(el.scrollTop, 800);
  assert.equal(f.frames.size, 0);
  f.scroller.follow(el);
  assert.equal(f.frames.size, 0);
});

test('scroll clamps its destination when corrections shorten a long transcript', () => {
  const f = scrollFixture(), el = { scrollTop: 300, scrollHeight: 1000, clientHeight: 200 };
  f.scroller.follow(el); f.step(0);
  el.scrollHeight = 400; f.scroller.follow(el); f.step(220);
  assert.equal(el.scrollTop, 200);
  assert.equal(f.frames.size, 0);
});

let viewModule;
async function loadView() {
  if (viewModule) return viewModule;
  const result = await build({ entryPoints: [fileURLToPath(new URL('../src/frontend/src/features/record/TranscriptView.jsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  viewModule = module.exports.default;
  return viewModule;
}

test('live JSX preserves plain text spacing, final-only announcements and decorative caret placement', async () => {
  const View = await loadView();
  let transcript = createTranscript();
  transcript = mergeSegment(transcript, segment('a', 0, '  Hôm  nay.  ', true));
  transcript = mergeSegment(transcript, segment('b', 1, 'tôi\t vui!', false));
  const html = renderToStaticMarkup(React.createElement(View, { model: { phase: 'recording', transcript, editorText: '',
    capture: {}, capabilities: {}, flow: {}, transcriptionActive: true } }));
  assert.equal((html.match(/aria-live="polite"/g) || []).length, 1);
  assert.match(html, /aria-live="polite" aria-atomic="false">Hôm  nay\./);
  assert.match(html, /data-final="true"/);
  assert.match(html, /data-final="false"/);
  assert.equal((html.match(/has-caret/g) || []).length, 1);
  assert.doesNotMatch(html, /textarea|aria-hidden="true"|Unconfirmed:/);
  const visible = html.slice(html.indexOf('<div class="record-live"')).replace(/<[^>]*>/g, '');
  assert.equal(visible, 'Hôm  nay. tôi\t vui!');
});

test('finalization and Review remove the caret and leave existing editing/save UI intact', async () => {
  const View = await loadView();
  const transcript = mergeSegment(createTranscript(), segment('a', 0, 'Draft', false));
  const model = { transcript, editorText: 'Edited journal', originalTranscript: 'Original',
    capture: {}, capabilities: {}, flow: {}, transcriptionActive: true };
  const finishing = renderToStaticMarkup(React.createElement(View, { model: { ...model, phase: 'finalizing' } }));
  assert.doesNotMatch(finishing, /has-caret/);
  const review = renderToStaticMarkup(React.createElement(MemoryRouter, {}, React.createElement(View, { model: { ...model, phase: 'review' } })));
  assert.match(review, /<textarea[^>]*>Edited journal<\/textarea>/);
  assert.match(review, /Save journal/);
  assert.doesNotMatch(review, /has-caret|record-live-word/);
});

async function loadButton() {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../src/frontend/src/features/record/RecordButton.jsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports.default;
}

test('record controls retain visible Start/Stop labels and disclose HTTP processing with a cancel action', async () => {
  const Button = await loadButton();
  const model = { capture: { status: 'ready' }, capabilities: { uploadAvailable: true }, elapsedSeconds: 0, flow: {} };
  const render = updates => renderToStaticMarkup(React.createElement(Button, { model: { ...model, ...updates } }));
  assert.match(render({ phase: 'ready' }), /record-trigger/);
  assert.match(render({ phase: 'ready' }), /Audio is uploaded for transcription after Stop/);
  const recording = render({ phase: 'recording', capture: { status: 'recording' }, elapsedSeconds: 12 });
  assert.match(recording, /aria-label="Stop recording"/);
  assert.match(recording, /is-recording/);
  assert.match(recording, /00:12/);
  const uploading = render({ phase: 'transcribing', capture: { status: 'stopped' } });
  assert.match(uploading, /role="status"/);
  assert.match(uploading, /Uploading and transcribing/);
  assert.match(uploading, /100 seconds/);
  assert.match(uploading, /Cancel transcription/);
  assert.match(uploading, /Discard take/);
});

test('HTTP processing retains playback and an editable review editor while Save is disabled', async () => {
  const View = await loadView();
  const model = { phase: 'transcribing', transcript: createTranscript(), editorText: 'My working draft', originalTranscript: '',
    capture: { url: 'blob:retained-audio' }, capabilities: {}, flow: {} };
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, {}, React.createElement(View, { model })));
  assert.match(html, /<textarea[^>]*>My working draft<\/textarea>/);
  assert.doesNotMatch(html, /readOnly|readonly/);
  assert.match(html, /record-save[^>]*disabled/);
  assert.match(html, /<audio[^>]*src="blob:retained-audio"[^>]*controls/);
  assert.match(html, /Replay recording/);
  assert.doesNotMatch(html, /has-caret|record-live-word|Retry transcription/);
});

test('HTTP retry and proposed replacement remain separate from the current edited journal', async () => {
  const View = await loadView();
  const model = { phase: 'review', transcript: createTranscript(), editorText: 'My corrected draft', originalTranscript: 'Confirmed live text',
    capture: { url: 'blob:kept' }, capabilities: {}, flow: {}, canUpload: true, uploadStatus: 'failed' };
  const render = updates => renderToStaticMarkup(React.createElement(MemoryRouter, {}, React.createElement(View, { model: { ...model, ...updates } })));
  assert.match(render({}), /Retry transcription/);
  assert.match(render({}), /New request.*transcription allowance/);
  const comparison = render({ canUpload: false, uploadStatus: 'succeeded', uploadTranscript: 'Full recognized text' });
  assert.match(comparison, /<textarea[^>]*>My corrected draft<\/textarea>/);
  assert.match(comparison, /Confirmed live text/);
  assert.match(comparison, /Full recognized text/);
  assert.match(comparison, /Replace draft with uploaded transcript/);
  assert.doesNotMatch(comparison, /Retry transcription/);
});
