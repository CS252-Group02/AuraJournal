import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const windows = process.platform === 'win32';
const venvPython = join(root, '.venv', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python');
const pathPython = windows ? 'python' : 'python3';
let python = existsSync(venvPython) ? venvPython : pathPython;

function hasUvicorn(candidate) {
  return spawnSync(candidate, ['-c', 'import uvicorn'], {
    stdio: 'ignore', timeout: 10000,
  }).status === 0;
}

// Preserve .venv priority and working PATH interpreters. Only try Conda when
// there is no project .venv and the original PATH interpreter lacks Uvicorn.
if (python === pathPython && !hasUvicorn(pathPython)) {
  const userHome = process.env.USERPROFILE || process.env.HOME;
  const condaCandidates = [
    process.env.CONDA_PREFIX
      ? join(process.env.CONDA_PREFIX, windows ? 'python.exe' : 'bin/python')
      : undefined,
    ...(windows && userHome ? ['miniconda3', 'anaconda3'].map(
      (installation) => join(userHome, installation, 'envs', 'AuraJournal', 'python.exe'),
    ) : []),
  ].filter(Boolean);
  python = condaCandidates.find((candidate) => existsSync(candidate) && hasUvicorn(candidate))
    || pathPython;
}

console.log(`Backend Python: ${python}`);

if (process.argv.includes('--check')) {
  process.exit(hasUvicorn(python) ? 0 : 1);
}

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
