import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const windows = process.platform === 'win32';
const venvPython = join(root, '.venv', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python');
const python = existsSync(venvPython) ? venvPython : (windows ? 'python' : 'python3');

const backend = spawn(
  python,
  ['-m', 'uvicorn', 'app.main:app', '--reload', '--env-file', '../../.env'],
  { cwd: join(root, 'src', 'backend'), stdio: 'inherit' },
);

backend.on('error', (error) => {
  console.error(`Could not start the backend with ${python}: ${error.message}`);
  process.exitCode = 1;
});
backend.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => backend.kill(signal));
}
