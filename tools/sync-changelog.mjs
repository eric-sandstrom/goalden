#!/usr/bin/env node
/**
 * Stamps the app's change log into the service-worker config so the
 * "What's new" dialog is driven by `package.json` + `CHANGELOG.md` instead
 * of hand-edited duplicates.
 *
 * Run: `npm run changelog:sync` (also runs automatically via `prebuild`).
 *
 * Sources of truth:
 *   - `package.json` `version`     — the authoritative version of THIS build.
 *   - `CHANGELOG.md`               — the full release history, newest-first,
 *                                    maintained automatically by release-please
 *                                    from conventional-commit messages. Each
 *                                    `## <version>` heading starts a release;
 *                                    every `* ...` bullet under it is one change.
 *
 * What it writes:
 *   - `ngsw-config.json` `appData = { version, releases }` where `version` is
 *     package.json's version (the SW stamps it onto this build's manifest, so
 *     at runtime `currentVersion.appData.version` reports it) and `releases`
 *     is the changelog history (`{ version, changes[] }`, newest-first).
 *     AppUpdateService slices the latest build's `releases` from the running
 *     build's `version` to the newest entry.
 *
 * Guard: the newest CHANGELOG.md heading's version MUST equal package.json's
 * version. release-please keeps them in lockstep (its release PR bumps both at
 * once), so a mismatch means a hand-edit went sideways — the build fails loudly
 * here, because a silent mismatch would break the "versions you skipped" slice
 * at runtime.
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
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');
const NGSW_PATH = join(ROOT, 'ngsw-config.json');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const pkg = await readJson(PKG_PATH);
const markdown = await readFile(CHANGELOG_PATH, 'utf8');

const version = pkg.version;
if (typeof version !== 'string' || version.length === 0) {
  throw new Error(`package.json has no usable "version" (got ${JSON.stringify(version)}).`);
}

const releases = parseChangelog(markdown);

if (releases.length === 0) {
  throw new Error(
    'CHANGELOG.md has no release sections. Expected at least one "## <version>" heading ' +
      'followed by "* ..." bullets.',
  );
}

const newest = releases[0].version;
if (newest !== version) {
  throw new Error(
    `Version mismatch: package.json is "${version}" but the newest CHANGELOG.md heading is "${newest}".\n` +
      `These are kept in lockstep by release-please's release PR. If you hand-edited one, ` +
      `align the other (or re-run release-please) before building.`,
  );
}

const ngsw = await readJson(NGSW_PATH);
ngsw.appData = { version, releases };

await writeFile(NGSW_PATH, JSON.stringify(ngsw, null, 2) + '\n', 'utf8');

console.log(
  `[changelog:sync] Stamped ngsw-config.json appData → v${version} (${releases.length} release${releases.length === 1 ? '' : 's'}).`,
);

/**
 * Parse a release-please-style CHANGELOG.md into `{ version, changes[] }[]`,
 * newest-first (the order they appear in the file).
 *
 * Tolerant of both shapes the file takes:
 *   - release-please output:  `## [1.2.0](compare-url) (2026-01-02)`
 *   - a plain seeded heading:  `## 1.0.0`
 * `### Features` / `### Bug Fixes` subsection headings are ignored — every
 * `* ...` (or `- ...`) bullet under a version heading is flattened into that
 * release's `changes`, with trailing commit/PR links and markdown bold
 * stripped so the dialog shows clean prose.
 */
function parseChangelog(md) {
  const releases = [];
  let current = null;

  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    // A version heading: exactly level-2 (`## `), not the `### ` subsections
    // and not the top-level `# Changelog` title.
    const headingMatch = /^##\s+(?!#)\[?([^\]\s]+)\]?/.exec(line);
    if (headingMatch) {
      current = { version: headingMatch[1], changes: [] };
      releases.push(current);
      continue;
    }

    if (!current) continue;

    const bulletMatch = /^[*-]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      const text = cleanBullet(bulletMatch[1]);
      if (text) current.changes.push(text);
    }
  }

  return releases;
}

/** Strip release-please's trailing commit/PR links and issue references,
 *  flatten any remaining markdown links to their text, drop markdown bold, and
 *  collapse whitespace — leaving human-readable change text for the dialog. */
function cleanBullet(text) {
  return text
    .replace(/\s*\(\[[^\]]+\]\([^)]*\)\)/g, '') // commit link: ([abc1234](https://...))
    .replace(/\s*,?\s*(closes|fixes|resolves)\s+\[[^\]]+\]\([^)]*\)/gi, '') // , closes [#11](...)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // any leftover [text](url) -> text
    .replace(/\*\*/g, '') // **scope:** -> scope:
    .replace(/\s+/g, ' ')
    .trim();
}
