import { defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import {
  FixtureDoc,
  FootballDataMatch,
  FootballDataResponse,
  fixtureChanged,
  mapFixture,
} from './lib/fixture-mapper';
import {
  CompetitionContext,
  resolveCompetitionContexts,
  sleep,
} from './lib/competition-contexts';

export const FOOTBALL_DATA_TOKEN = defineSecret('FOOTBALL_DATA_TOKEN');

/** Pause between competition fetches. Football-data's free tier allows
 *  10 req/min — at 12 comps every 10 min we stay well under, but the
 *  delay keeps us polite and avoids burst-rate-limit edge cases. */
const INTER_REQUEST_DELAY_MS = 200;

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
  const contexts = await resolveCompetitionContexts(db, compId);

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
  //
  // Only when something changed this run — otherwise `cache/fixtures`
  // already matches the canonical docs. Gating on totalWritten (not just
  // WC's count) means a non-WC-only change does one redundant rewrite, but
  // we never miss a WC change: any WC write makes totalWritten > 0.
  if (totalWritten > 0) {
    await writeLegacyRollup(db);
  }

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

  // Per-comp rollup, refreshed only when a fixture actually changed. With
  // writes === 0 the stored rollup already matches the canonical docs, so
  // rewriting it would be a pure waste; any future change rebuilds it in
  // full from the API response below.
  if (writes > 0) {
    await batch.commit();
    logger.info(`[${ctx.id}] updated ${writes} fixtures`);

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
  }

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

/** How far ahead of kickoff the live cadence kicks in, so we catch the
 *  TIMED→IN_PLAY transition (and have fresh data on screen) right around
 *  kickoff rather than up to a poll-interval late. */
const MATCH_LOOKAHEAD_MS = 15 * 60 * 1000;

/** Upper bound on how long after kickoff a match could still be running
 *  (90' + stoppage + extra time + penalties + provider lag before it
 *  flips to FINISHED). Past this, a still-non-terminal fixture is treated
 *  as stale rather than live, so a stuck doc can't pin us in fast cadence
 *  forever. */
const MAX_MATCH_DURATION_MS = 3 * 60 * 60 * 1000;

/** Statuses meaning a fixture won't change again — they don't keep the
 *  poller in its live cadence. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'FINISHED',
  'CANCELLED',
  'AWARDED',
  'POSTPONED',
]);

/**
 * Cheap gate for the scheduled poller: is any match live or kicking off
 * soon? The scheduler wakes every couple of minutes but only runs the full
 * fetch/diff/rollup pipeline when this returns true — so idle hours (and
 * the entire off-season) cost one small bounded query per wake instead of
 * a fleet-wide read/write pass.
 *
 * "In window" = a non-terminal fixture whose kickoff falls in
 * [now - MAX_MATCH_DURATION, now + LOOKAHEAD]. Keyed off kickoff time, not
 * status, deliberately: our own polling is what advances status, so gating
 * on IN_PLAY would deadlock (we'd never poll, so nothing would ever flip to
 * IN_PLAY). The range is on a single field, so the automatic index covers
 * it; status is filtered in code to avoid a composite index.
 */
async function isMatchWindow(
  db: FirebaseFirestore.Firestore,
  now: Date = new Date(),
): Promise<boolean> {
  const lower = Timestamp.fromDate(new Date(now.getTime() - MAX_MATCH_DURATION_MS));
  const upper = Timestamp.fromDate(new Date(now.getTime() + MATCH_LOOKAHEAD_MS));
  const snap = await db
    .collection('fixtures')
    .where('utcKickoff', '>=', lower)
    .where('utcKickoff', '<=', upper)
    .limit(50)
    .get();
  return snap.docs.some((d) => !TERMINAL_STATUSES.has((d.data() as FixtureDoc).status));
}

export const pollFootballData = onSchedule(
  {
    // Wake often, but the isMatchWindow gate below means we only do real
    // work when a match is live or imminent — see runPollFootballData.
    schedule: 'every 2 minutes',
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
    const db = getFirestore();
    if (!(await isMatchWindow(db))) {
      logger.debug('No match live or imminent — skipping poll');
      return;
    }
    await runPollFootballData(token);
  },
);
