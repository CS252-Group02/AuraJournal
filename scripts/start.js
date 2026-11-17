import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath;
const windows = process.platform === 'win32';
const venvDir = join(root, '.venv');
const python = join(venvDir, windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python');
const requirements = join(root, 'src', 'backend', 'requirements.txt');
const backendDir = join(root, 'src', 'backend');

if (!npmCli) {
  console.error('Run this script with `npm start` from the project root.');
  process.exit(1);
}

let activeChild;
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    activeChild?.kill(signal);
  });
}

function runNpm(args) {
  return new Promise((resolve, reject) => {
    activeChild = spawn(process.execPath, [npmCli, ...args], {
      cwd: root,
      stdio: 'inherit',
    });
    activeChild.once('error', reject);
    activeChild.once('exit', (code, signal) => {
      activeChild = undefined;
      resolve({ code, signal });
    });
  });
}

function runCommand(command, args, cwd) {
  return new Promise((resolve) => {
    activeChild = spawn(command, args, { cwd, stdio: 'inherit' });
    activeChild.once('error', (error) => {
      activeChild = undefined;
      resolve({ code: 1, error });
    });
    activeChild.once('exit', (code, signal) => {
      activeChild = undefined;
      resolve({ code, signal });
    });
  });
}

async function runStep(label, command, args, cwd = root) {
  console.log(`${label}...`);
  const result = await runCommand(command, args, cwd);
  if (result.error) console.error(`${label} could not start: ${result.error.message}`);
  else if (result.code !== 0) console.error(`${label} failed; app startup stopped.`);
  return result.code === 0;
}

async function prepareBackend() {
  if (!existsSync(python)) {
    console.error('The project Python environment was not found. Create `.venv` and install `src/backend/requirements.txt` before running `npm start`.');
    return false;
  }

  const requirementNames = readFileSync(requirements, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1])
    .filter(Boolean);
  const dependencyCheck = spawnSync(python, [
    '-c',
    `import importlib.metadata, sys
installed = {d.metadata["Name"].lower().replace("_", "-").replace(".", "-") for d in importlib.metadata.distributions()}
missing = [name for name in sys.argv[1:] if name.lower().replace("_", "-").replace(".", "-") not in installed]
if missing:
    print("Missing Python packages: " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)`,
    ...requirementNames,
  ], { cwd: backendDir, encoding: 'utf8', stdio: ['ignore', 'ignore', 'inherit'] });
  if (dependencyCheck.error || dependencyCheck.status !== 0) {
    if (dependencyCheck.error) console.error(`Could not check the project Python environment: ${dependencyCheck.error.message}`);
    console.error('Install the backend requirements into `.venv` (see the setup instructions in README.md), then run `npm start` again.');
    return false;
  }

  if (!await runStep('Applying database migrations', python, [
    '-m', 'alembic', 'upgrade', 'head',
  ], backendDir)) {
    console.error('Check that PostgreSQL is running and the repository-root .env is configured.');
    return false;
  }
  return true;
}

for (const packagePath of [
  join(root, 'node_modules', 'concurrently', 'package.json'),
  join(root, 'node_modules', 'vite', 'package.json'),
]) {
  if (!existsSync(packagePath)) {
    console.log('Installing npm dependencies...');
    const result = await runNpm(['ci']);
    if (result.code !== 0) process.exit(result.code ?? 1);
    break;
  }
}

if (!await prepareBackend()) process.exit(1);

const result = await runNpm([
  'exec', '--', 'concurrently',
  '--names', 'backend,frontend',
  '--prefix', 'name',
  '--kill-others',
  'node scripts/start-backend.js',
  'npm run dev',
]);

if (result.signal === 'SIGINT') process.exitCode = 0;
else process.exitCode = result.code ?? 1;
