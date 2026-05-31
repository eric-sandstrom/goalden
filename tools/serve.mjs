// Port-aware `npm start`.
//   - In the MAIN checkout: starts the full dev stack -- Firebase emulator +
//     functions tsc --watch + ng serve -- on the RESERVED port 4200, via
//     concurrently (which forwards SIGINT so the emulator still runs its
//     --export-on-exit on Ctrl+C).
//   - In a git worktree: starts ng serve ONLY, on the worktree's assigned port
//     (4201+; 4200 is reserved for main). The emulator is the single shared
//     instance running from main.
//
// Worktree port resolution: PORT env -> .worktree.json "port" -> first free >= 4201.

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extra = process.argv.slice(2);

function isFree(port) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
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
    // no per-worktree config
  }
  return null;
}

// Is this checkout the primary worktree (main), or a linked worktree?
function isPrimaryCheckout() {
  try {
    const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--show-toplevel'], { encoding: 'utf8' }).trim();
    if (!common || !top) return false;
    return resolve(dirname(common)) === resolve(top);
  } catch {
    return false; // unsure -> treat as a worktree (never auto-start the emulator)
  }
}

if (isPrimaryCheckout()) {
  // MAIN: full dev stack on the reserved port 4200.
  const port = process.env.PORT ? Number(process.env.PORT) : 4200;
  const ng = `ng serve --port ${port}${extra.length ? ' ' + extra.join(' ') : ''}`;
  console.log(`main: starting emulator + functions watch + ng serve on http://localhost:${port}`);
  // Single quoted command string (not an args array) so the shell keeps each
  // concurrently command intact and to avoid the shell-args deprecation warning.
  const cmd = `concurrently -n emu,fn,ng -c blue,magenta,green "npm run emulators" "npm run functions:watch" "${ng}"`;
  const child = spawn(cmd, { cwd: root, stdio: 'inherit', shell: true });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  // WORKTREE: frontend only, on this worktree's assigned port (4201+, never 4200).
  const wanted = configuredPort();
  const port = wanted ?? (await firstFree(4201));
  if (wanted && !(await isFree(wanted))) {
    console.warn(`Port ${wanted} is busy -- ng serve will likely fail. Free it or override with PORT.`);
  }
  console.log(`ng serve on http://localhost:${port}`);
  const cmd = `ng serve --port ${port}${extra.length ? ' ' + extra.join(' ') : ''}`;
  const child = spawn(cmd, { cwd: root, stdio: 'inherit', shell: true });
  child.on('exit', (code) => process.exit(code ?? 0));
}
