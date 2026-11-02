import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath;

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
