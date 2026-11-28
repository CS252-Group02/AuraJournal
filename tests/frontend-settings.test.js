import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  DEFAULT_PREFERENCES, PREFERENCES_KEY, applyMotion, microphoneConstraints, normalizePreferences,
  readPreferences, resetPreferenceCache, updatePreferences,
} from '../src/frontend/src/features/settings/preferences.js';
import { prefersReducedMotion } from '../src/frontend/src/lib/motion.js';
import { createAudioRecorder } from '../src/frontend/src/features/record/audioRecorder.js';

function browser(context, initial = []) {
  const data = new Map(initial);
  const values = {
    localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) },
    document: { documentElement: { dataset: {} } },
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    context.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  resetPreferenceCache();
  context.after(resetPreferenceCache);
  return { data, root: values.document.documentElement };
}

test('preferences keep only known values and fall back to defaults', () => {
  assert.deepEqual(normalizePreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(normalizePreferences({ motion: 'full', startWith: 'video', proofread: 'no', showQuote: 0, microphone: 7, extra: true }), DEFAULT_PREFERENCES);
  assert.deepEqual(normalizePreferences({ motion: 'reduced', startWith: 'writing', proofread: false, showQuote: false, showStreak: false, microphone: 'mic-2' }),
    { motion: 'reduced', startWith: 'writing', microphone: 'mic-2', proofread: false, showQuote: false, showStreak: false });
  assert.equal(normalizePreferences({ microphone: 'x'.repeat(513) }).microphone, '');
});

test('preferences survive broken storage and persist updates under one key', context => {
  const { data } = browser(context, [[PREFERENCES_KEY, '{not json'], ['session', 'private']]);
  assert.deepEqual(readPreferences(), DEFAULT_PREFERENCES);
  updatePreferences({ showStreak: false, startWith: 'writing' });
  assert.deepEqual(JSON.parse(data.get(PREFERENCES_KEY)), { ...DEFAULT_PREFERENCES, showStreak: false, startWith: 'writing' });
  assert.equal(data.get('session'), 'private');
  resetPreferenceCache();
  assert.equal(readPreferences().startWith, 'writing');
});

test('reduced animations mark the document and make motion helpers skip animation', context => {
  const { root } = browser(context);
  assert.equal(prefersReducedMotion(), false);
  updatePreferences({ motion: 'reduced' });
  assert.equal(root.dataset.motion, 'reduced');
  assert.equal(prefersReducedMotion(), true);
  updatePreferences({ motion: 'system' });
  assert.equal(root.dataset.motion, undefined);
  applyMotion('reduced');
  assert.equal(root.dataset.motion, 'reduced');
});

test('the chosen microphone is requested as a preference, not a hard requirement', async context => {
  browser(context);
  assert.equal(microphoneConstraints(), true);
  updatePreferences({ microphone: 'usb-mic' });
  assert.deepEqual(microphoneConstraints(), { deviceId: 'usb-mic' });
  const calls = [];
  const recorder = createAudioRecorder({
    mediaDevices: { getUserMedia: async constraints => { calls.push(constraints); throw { name: 'NotAllowedError' }; } },
    MediaRecorder: class { static isTypeSupported() { return true; } },
    audioConstraints: microphoneConstraints,
  });
  await recorder.start();
  assert.deepEqual(calls, [{ audio: { deviceId: 'usb-mic' } }]);
});

async function loadSettings() {
  const result = await build({
    stdin: { contents: 'export { default as Settings, microphoneOptions } from "./pages/SettingsPage.jsx";',
      resolveDir: fileURLToPath(new URL('../src/frontend/src/', import.meta.url)), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    plugins: [{ name: 'settings-context', setup(builder) {
      builder.onLoad({ filter: /[\\/]auth[\\/]Auth\.jsx$/ }, () => ({
        contents: 'export const useAuth = () => ({ user: { id: "settings-user", email: "journal@example.test" }, logout() {} });', loader: 'js',
      }));
      builder.onLoad({ filter: /[\\/]lib[\\/]api\.js$/ }, () => ({
        contents: 'export const api = () => { throw new Error("No requests during render"); }; export const getAuthEpoch = () => 0; export const subscribeAuthChanges = () => () => {};', loader: 'js',
      }));
    } }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}

test('Settings shows each section with labelled controls and safe defaults', async () => {
  const { Settings } = await loadSettings();
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, {}, React.createElement(Settings)));
  for (const heading of ['Settings', 'Look and feel', 'Journaling', 'Home page', 'This device']) assert.match(html, new RegExp(heading));
  for (const group of ['Appearance', 'Animations', 'Start journaling with']) assert.match(html, new RegExp(`role="group" aria-label="${group}"`));
  assert.equal((html.match(/role="switch"/g) || []).length, 3);
  assert.equal((html.match(/aria-checked="true"/g) || []).length, 3);
  assert.match(html, /<label for="settings-microphone">Microphone<\/label>/);
  assert.match(html, /<option value="" selected="">Default microphone<\/option>/);
  assert.match(html, /Nothing saved/);
  assert.doesNotMatch(html, /Week starts/);
});

test('microphone options hide system aliases, number unnamed inputs and keep a saved device', async () => {
  const { microphoneOptions } = await loadSettings();
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default' },
    { kind: 'audioinput', deviceId: 'a', label: '' },
    { kind: 'audioinput', deviceId: 'b', label: 'USB headset' },
    { kind: 'videoinput', deviceId: 'cam', label: 'Camera' },
  ];
  assert.deepEqual(microphoneOptions(devices, 'b'), [{ id: 'a', label: 'Microphone 1' }, { id: 'b', label: 'USB headset' }]);
  assert.deepEqual(microphoneOptions([], 'gone').at(-1), { id: 'gone', label: 'Saved microphone (not connected)' });
});
