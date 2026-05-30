#!/usr/bin/env node
/**
 * Stamps the app's change log into the service-worker config so the
 * "What's new" dialog is driven by `package.json` + `changelog.json` instead
 * of hand-edited duplicates.
 *
 * Run: `npm run changelog:sync` (also runs automatically via `prebuild`).
 *
 * Sources of truth:
 *   - `package.json` `version`     — the authoritative version of THIS build.
 *   - `changelog.json`             — the full release history, newest-first,
 *                                    each `{ version, changes[] }`.
 *
 * What it writes:
 *   - `ngsw-config.json` `appData = { version, releases }` where `version` is
 *     package.json's version (the SW stamps it onto this build's manifest, so
 *     at runtime `currentVersion.appData.version` reports it) and `releases`
 *     is the changelog history. AppUpdateService slices the latest build's
 *     `releases` from the running build's `version` to the newest entry.
 *
 * Guard: the newest changelog entry's version MUST equal package.json's
 * version. If you bump one without the other, the build fails loudly here —
 * a silent mismatch would break the "versions you skipped" slice at runtime.
 *
 * Idempotent: rewrites appData in place, preserving the rest of the config and
 * its key order. Safe to commit the result; it only changes when the version
 * or changelog changes.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PKG_PATH = join(ROOT, 'package.json');
const CHANGELOG_PATH = join(ROOT, 'changelog.json');
const NGSW_PATH = join(ROOT, 'ngsw-config.json');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const pkg = await readJson(PKG_PATH);
const changelog = await readJson(CHANGELOG_PATH);

const version = pkg.version;
if (typeof version !== 'string' || version.length === 0) {
  throw new Error(`package.json has no usable "version" (got ${JSON.stringify(version)}).`);
}

if (!Array.isArray(changelog) || changelog.length === 0) {
  throw new Error('changelog.json must be a non-empty array of { version, changes } entries.');
}

// Validate every entry, and that the newest matches package.json.
const releases = changelog.map((entry, i) => {
  if (!entry || typeof entry.version !== 'string' || !Array.isArray(entry.changes)) {
    throw new Error(
      `changelog.json[${i}] must be { version: string, changes: string[] } (got ${JSON.stringify(entry)}).`,
    );
  }
  return { version: entry.version, changes: entry.changes };
});

const newest = releases[0].version;
if (newest !== version) {
  throw new Error(
    `Version mismatch: package.json is "${version}" but the newest changelog.json entry is "${newest}".\n` +
      `Fix: bump package.json and prepend a matching { "version": "${version}", "changes": [...] } entry to changelog.json (newest first).`,
  );
}

const ngsw = await readJson(NGSW_PATH);
ngsw.appData = { version, releases };

await writeFile(NGSW_PATH, JSON.stringify(ngsw, null, 2) + '\n', 'utf8');

console.log(
  `[changelog:sync] Stamped ngsw-config.json appData → v${version} (${releases.length} release${releases.length === 1 ? '' : 's'}).`,
);
