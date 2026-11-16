import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

function pythonBootstrapCommand() {
  const candidates = windows
    ? [['py', ['-3']], ['python', []]]
    : [['python3', []], ['python', []]];
  return candidates.find(([command, args]) => (
    spawnSync(command, [...args, '--version'], { stdio: 'ignore' }).status === 0
  ));
}

async function prepareBackend() {
  if (!existsSync(python)) {
    const bootstrap = pythonBootstrapCommand();
    if (!bootstrap) {
      console.error('Python 3 was not found. Install Python 3.10+ and run `npm start` again.');
      return false;
    }
    if (!await runStep('Creating the project Python environment', bootstrap[0], [
      ...bootstrap[1], '-m', 'venv', venvDir,
    ])) return false;
  }

  const requirementsHash = createHash('sha256').update(readFileSync(requirements)).digest('hex');
  const fingerprintPath = join(venvDir, '.requirements.sha256');
  const installedHash = existsSync(fingerprintPath)
    ? readFileSync(fingerprintPath, 'utf8').trim()
    : '';

  if (requirementsHash !== installedHash) {
    if (!await runStep('Installing backend Python requirements', python, [
      '-m', 'pip', 'install', '-r', requirements,
    ])) return false;
    writeFileSync(fingerprintPath, `${requirementsHash}\n`);
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
