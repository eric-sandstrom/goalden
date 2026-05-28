import { defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import {
  FixtureDoc,
  FootballDataMatch,
  FootballDataResponse,
  fixtureChanged,
  mapFixture,
} from './lib/fixture-mapper';

export const FOOTBALL_DATA_TOKEN = defineSecret('FOOTBALL_DATA_TOKEN');

/** Pause between competition fetches. Football-data's free tier allows
 *  10 req/min — at 12 comps every 10 min we stay well under, but the
 *  delay keeps us polite and avoids burst-rate-limit edge cases. */
const INTER_REQUEST_DELAY_MS = 200;

interface CompetitionContext {
  readonly id: string;
  readonly season: string;
}

interface CompetitionPollResult {
  readonly compId: string;
  readonly ok: boolean;
  readonly fetched: number;
  readonly written: number;
  readonly error?: string;
}

export interface PollSummary {
  readonly ok: boolean;
  readonly fetched: number;
  readonly written: number;
  readonly competitions: readonly CompetitionPollResult[];
  readonly message?: string;
}

/**
 * Inner poll logic, factored out so both the scheduled `pollFootballData`
 * and the on-demand `devPollFixturesNow` dev callable share the same
 * fetch / diff / write / rollup pipeline without duplication.
 *
 * When `compId` is supplied, polls just that one competition (useful for
 * dev tools or single-comp force-refreshes). Otherwise it iterates every
 * `competitions/{id}` doc where `active == true`, polling each in
 * sequence with a small delay between requests to respect the free-tier
 * rate cap.
 *
 * Per-competition failures don't abort the loop — we log the error and
 * carry on to the next comp. The returned summary lists the outcome of
 * each, so callers can surface partial-success states.
 */
export async function runPollFootballData(
  token: string,
  compId?: string,
): Promise<PollSummary> {
  const db = getFirestore();
  const contexts = await resolveContexts(db, compId);

  if (contexts.length === 0) {
    const message = compId
      ? `Competition ${compId} not found or has no current season`
      : 'No active competitions — toggle some in dev-tools';
    logger.warn(message);
    return { ok: true, fetched: 0, written: 0, competitions: [], message };
  }

  const perComp: CompetitionPollResult[] = [];
  let totalFetched = 0;
  let totalWritten = 0;

  for (let i = 0; i < contexts.length; i++) {
    const ctx = contexts[i];
    try {
      const result = await pollOneCompetition(token, ctx);
      perComp.push(result);
      totalFetched += result.fetched;
      totalWritten += result.written;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error(`[${ctx.id}] poll failed`, { error: message });
      perComp.push({
        compId: ctx.id,
        ok: false,
        fetched: 0,
        written: 0,
        error: message,
      });
    }

    // Politeness gap before next competition. Skip after the last one.
    if (i < contexts.length - 1) {
      await sleep(INTER_REQUEST_DELAY_MS);
    }
  }

  // Legacy single-rollup write: `cache/fixtures` was the old layout when
  // only WC existed. The current FixturesService still reads it, so we
  // keep it populated with WC contents during the dual-running window
  // until task #71 swaps the service to per-comp rollups. Once that
  // lands this block can go.
  await writeLegacyRollup(db);

  logger.info(
    `Polled ${contexts.length} competition(s) — fetched ${totalFetched}, wrote ${totalWritten}`,
    { competitions: perComp.map((c) => ({ id: c.compId, ok: c.ok, written: c.written })) },
  );

  return {
    ok: perComp.every((c) => c.ok),
    fetched: totalFetched,
    written: totalWritten,
    competitions: perComp,
  };
}

/**
 * Resolves the list of (compId, season) contexts to poll. Two paths:
 *   - explicit `compId`: read that single doc; if missing or no
 *     currentSeason, return empty so the caller surfaces the warning.
 *   - implicit: list `competitions/` where `active == true`.
 *
 * Comps without a `currentSeason` are filtered out — football-data
 * returns null for these during the between-seasons window and there's
 * nothing to poll until the next season starts.
 */
async function resolveContexts(
  db: FirebaseFirestore.Firestore,
  compId: string | undefined,
): Promise<readonly CompetitionContext[]> {
  const snap = compId
    ? await db.collection('competitions').doc(compId).get().then((d) => (d.exists ? [d] : []))
    : (await db.collection('competitions').where('active', '==', true).get()).docs;

  const contexts: CompetitionContext[] = [];
  for (const doc of snap) {
    const data = doc.data() ?? {};
    const season = extractSeason(data['currentSeason']);
    if (!season) {
      logger.info(`[${doc.id}] skipped — no current season`);
      continue;
    }
    contexts.push({ id: doc.id, season });
  }
  return contexts;
}

/** Pulls the season starting calendar year out of the API's date format.
 *  e.g. `currentSeason.startDate = '2025-08-16'` → `'2025'`. */
function extractSeason(currentSeason: unknown): string | null {
  if (!currentSeason || typeof currentSeason !== 'object') return null;
  const startDate = (currentSeason as { startDate?: unknown })['startDate'];
  if (typeof startDate !== 'string' || startDate.length < 4) return null;
  return startDate.slice(0, 4);
}

/** Fetches one competition's matches, writes changes, refreshes its
 *  per-comp rollup. The competition's id doubles as the football-data
 *  `code`, so the URL is straightforward. */
async function pollOneCompetition(
  token: string,
  ctx: CompetitionContext,
): Promise<CompetitionPollResult> {
  const res = await fetch(
    `https://api.football-data.org/v4/competitions/${ctx.id}/matches`,
    { headers: { 'X-Auth-Token': token } },
  );
  if (!res.ok) {
    const body = await res.text();
    logger.error(`[${ctx.id}] football-data fetch failed`, { status: res.status, body });
    return {
      compId: ctx.id,
      ok: false,
      fetched: 0,
      written: 0,
      error: `HTTP ${res.status}: ${body}`,
    };
  }

  const data = (await res.json()) as FootballDataResponse;
  const matches = data.matches ?? [];
  logger.info(`[${ctx.id}] received ${matches.length} matches`);

  const db = getFirestore();
  const refs = matches.map((m) => db.collection('fixtures').doc(`fd-${m.id}`));
  const snapshots = refs.length > 0 ? await db.getAll(...refs) : [];
  const existing = new Map<string, FixtureDoc>();
  for (const s of snapshots) {
    if (s.exists) existing.set(s.id, s.data() as FixtureDoc);
  }

  const batch = db.batch();
  let writes = 0;
  for (const m of matches) {
    const next = mapFixture(m as FootballDataMatch, {
      competitionId: ctx.id,
      season: ctx.season,
    });
    const id = `fd-${m.id}`;
    if (fixtureChanged(existing.get(id), next)) {
      batch.set(
        db.collection('fixtures').doc(id),
        { ...next, lastSyncedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      writes++;
    }
  }

  if (writes > 0) {
    await batch.commit();
    logger.info(`[${ctx.id}] updated ${writes} fixtures`);
  }

  // Per-comp rollup. Rewritten on every poll so it can't drift from
  // the canonical per-fixture docs — cheaper than detecting any change
  // across the comp's matches.
  const rollup = matches.map((m) => ({
    id: `fd-${m.id}`,
    ...mapFixture(m as FootballDataMatch, {
      competitionId: ctx.id,
      season: ctx.season,
    }),
  }));
  await db.collection('cache').doc(`fixtures-${ctx.id}`).set({
    competitionId: ctx.id,
    season: ctx.season,
    fixtures: rollup,
    count: rollup.length,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    compId: ctx.id,
    ok: true,
    fetched: matches.length,
    written: writes,
  };
}

/**
 * Maintains the legacy `cache/fixtures` doc (the single-rollup layout
 * the current FixturesService still depends on) by re-reading the WC
 * fixtures from the canonical collection and rewriting the same shape
 * it used to have. Goes away once task #71 lands the per-comp client.
 *
 * Reads fixtures directly rather than the per-comp rollup so this stays
 * authoritative even if the WC rollup write failed earlier in the loop.
 */
async function writeLegacyRollup(db: FirebaseFirestore.Firestore): Promise<void> {
  const wcSnap = await db
    .collection('fixtures')
    .where('competitionId', '==', 'WC')
    .get();

  // During the migration window some fixtures may not have competitionId
  // backfilled yet. If the query returns nothing, fall back to reading
  // every fixture — pre-migration that's still WC-only.
  let docs = wcSnap.docs;
  if (docs.length === 0) {
    const allSnap = await db.collection('fixtures').get();
    docs = allSnap.docs;
  }

  const fixtures = docs.map((d) => ({ id: d.id, ...(d.data() as FixtureDoc) }));
  await db.collection('cache').doc('fixtures').set({
    fixtures,
    count: fixtures.length,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const pollFootballData = onSchedule(
  {
    schedule: 'every 10 minutes',
    region: 'europe-west1',
    secrets: [FOOTBALL_DATA_TOKEN],
    maxInstances: 1,
    // Bumped from 60s — polling 12 comps sequentially with a 200ms
    // pause between requests + Firestore writes can easily push past
    // a minute when several comps have changes to commit.
    timeoutSeconds: 540,
  },
  async () => {
    const token = FOOTBALL_DATA_TOKEN.value();
    if (!token) {
      logger.error('FOOTBALL_DATA_TOKEN secret missing');
      return;
    }
    await runPollFootballData(token);
  },
);
