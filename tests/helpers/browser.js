// Small CDP client for optional real-browser checks, using Node's WebSocket.
// BROWSER_BIN points at a locally installed Chromium/Chrome/Brave executable.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

export async function launchBrowser(binary) {
  const profile = await mkdtemp(join(tmpdir(), 'aurajournal-browser-'));
  const process = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=0',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket, connection;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Browser startup timed out')), 15000);
      let output = '';
      process.stderr.on('data', chunk => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
      process.once('error', error => { clearTimeout(timeout); reject(error); });
      process.once('exit', code => { clearTimeout(timeout); reject(new Error(`Browser exited ${code}: ${output.slice(-1000)}`)); });
    });
    socket = new WebSocket(endpoint);
    await once(socket, 'open');
    let id = 0, sessionId;
    const pending = new Map(), listeners = new Map();
    socket.addEventListener('message', message => {
      const event = JSON.parse(message.data);
      if (event.id) {
        const request = pending.get(event.id);
        if (!request) return;
        clearTimeout(request.timer); pending.delete(event.id);
        if (event.error) request.reject(new Error(event.error.message)); else request.resolve(event.result);
      } else listeners.get(event.method)?.forEach(callback => callback(event.params));
    });
    function call(method, params = {}, target = sessionId) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timed out: ${method}`)); }, 15000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params, ...(target ? { sessionId: target } : {}) }));
      });
    }
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await call('Target.attachToTarget', { targetId, flatten: true }));
    await call('Page.enable');
    await call('Page.bringToFront');
    await call('Runtime.enable');
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await call('Network.enable');
    await call('Network.setBlockedURLs', { urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'] });
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    connection = { call, evaluate,
      on(method, callback) {
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(callback);
      },
      async waitFor(expression) {
        const deadline = Date.now() + 10000;
        do {
          try { if (await evaluate(`Boolean(${expression})`)) return; } catch { /* A document may be navigating. */ }
          await new Promise(resolve => setTimeout(resolve, 30));
        } while (Date.now() < deadline);
        const state = await evaluate('JSON.stringify({url:location.href,active:document.activeElement?.outerHTML.slice(0,400),text:document.body?.innerText.slice(0,800)})').catch(() => 'unavailable');
        throw new Error(`Browser condition timed out: ${expression}; ${state}`);
      },
      async screenshot(path) {
        const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        await writeFile(path, Buffer.from(data, 'base64'));
      },
    };
    return { ...connection, async close() {
      await call('Browser.close', {}, null).catch(() => {});
      socket.close();
      if (process.exitCode === null) { process.kill(); await once(process, 'exit').catch(() => {}); }
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } };
  } catch (error) {
    socket?.close(); process.kill();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
}
