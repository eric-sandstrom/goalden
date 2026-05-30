// Port-aware `ng serve` wrapper. Each git worktree serves the frontend on its
// own port so multiple dev sessions don't collide on :4200.
//
// Port resolution order:
//   1. PORT env var            - explicit override, e.g. `$env:PORT=4205; npm start`
//   2. .worktree.json "port"   - written by tools/new-session.ps1 per worktree
//   3. first free port from 4200 upward - auto
//
// Run via `npm start`: npm prepends node_modules/.bin to PATH, so `ng` resolves.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function isFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function firstFree(start) {
  for (let p = start; p < start + 100; p++) {
    if (await isFree(p)) return p;
  }
  throw new Error(`No free port found in ${start}..${start + 99}`);
}

function configuredPort() {
  if (process.env.PORT) return Number(process.env.PORT);
  try {
    // Strip a leading UTF-8 BOM (PowerShell's Set-Content -Encoding utf8 writes
    // one) so JSON.parse doesn't throw and silently drop the configured port.
    let raw = readFileSync(join(root, '.worktree.json'), 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const cfg = JSON.parse(raw);
    if (cfg.port) return Number(cfg.port);
  } catch {
    // no per-worktree config - fall through to auto-detect
  }
  return null;
}

const wanted = configuredPort();
const port = wanted ?? (await firstFree(4200));

if (wanted && !(await isFree(wanted))) {
  console.warn(`Port ${wanted} is busy - ng serve will likely fail. ` +
    `Free it, or override with PORT / .worktree.json.`);
}

console.log(`ng serve on http://localhost:${port}`);

// Forward any extra args, e.g. `npm start -- --open`.
const extra = process.argv.slice(2);
const child = spawn('ng', ['serve', '--port', String(port), ...extra], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});
child.on('exit', (code) => process.exit(code ?? 0));
