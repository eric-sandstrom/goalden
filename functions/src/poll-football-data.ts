import { defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import {
  FixtureDoc,
  FootballDataMatch,
  FootballDataResponse,
  fixtureListFieldsChanged,
  mapFixture,
} from './lib/fixture-mapper';
import {
  CompetitionContext,
  resolveCompetitionContexts,
  sleep,
} from './lib/competition-contexts';
import {
  MappedEspnEvent,
  fetchEspnScoreboard,
  getEspnSlug,
  mapEspnEvent,
  naturalKey,
} from './lib/espn-live';
import {
  matchHeaders,
  matchNeedsDetail,
  readDetailDocs,
  stageMatchWrite,
} from './lib/match-ingest';
import { runPollLiveDetail } from './poll-live-detail';

/** Firestore caps a write batch at 500 ops; stage/commit chunks of fixtures
 *  (each match stages up to two writes — lean + detail) under that ceiling. */
const BATCH_OP_LIMIT = 450;

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
  reconcile = false,
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
      const result = await pollOneCompetition(token, ctx, reconcile);
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

    // Best-effort ESPN live overlay for this comp. Isolated in its own
    // try/catch so a failure can't affect the authoritative poll result
    // recorded above — it writes only the display-only `live*` fields. No-ops
    // (without a fetch) when the comp has no ESPN slug or no fixture is in
    // the live window.
    try {
      await pollEspnLive(db, ctx);
    } catch (e: unknown) {
      logger.warn(`[${ctx.id}] ESPN live overlay failed (non-fatal)`, {
        error: e instanceof Error ? e.message : String(e),
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
 *  per-comp rollup. We address the comp by its football-data numeric id
 *  (`fdId`) rather than our doc id — some comps (e.g. Superettan) have no
 *  textual code, so we synthesise one for the doc id, but only the numeric
 *  id resolves against the API. */
async function pollOneCompetition(
  token: string,
  ctx: CompetitionContext,
  reconcile: boolean,
): Promise<CompetitionPollResult> {
  const res = await fetch(
    `https://api.football-data.org/v4/competitions/${ctx.fdId ?? ctx.id}/matches`,
    { headers: matchHeaders(token) },
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

  // Build the "existing" set to diff against. Normally (reconcile === false) we
  // read the per-comp ROLLUP doc -- ONE read -- instead of getAll-ing every
  // match doc, so the full sync stops re-reading hundreds of unchangeable
  // finished/far-future fixtures each run. A NEW fixture is absent from the
  // rollup, so fixtureChanged(undefined, ...) forces its canonical write below:
  // every fixture is still PULLED to its canonical doc at least once, and a
  // missing rollup (a fresh/just-activated comp) leaves `existing` empty so ALL
  // matches count as new -> a full pull. The periodic reconcile (reconcile ===
  // true) reads the canonical docs directly to self-heal any drift and
  // guarantee completeness.
  const existing = new Map<string, FixtureDoc>();
  if (reconcile) {
    const refs = matches.map((m) => db.collection('fixtures').doc(`fd-${m.id}`));
    const snapshots = refs.length > 0 ? await db.getAll(...refs) : [];
    for (const s of snapshots) {
      if (s.exists) existing.set(s.id, s.data() as FixtureDoc);
    }
  } else {
    const rollupSnap = await db.collection('cache').doc(`fixtures-${ctx.id}`).get();
    const arr = rollupSnap.exists ? rollupSnap.data()?.['fixtures'] : null;
    if (Array.isArray(arr)) {
      for (const f of arr as Array<FixtureDoc & { id?: unknown }>) {
        if (typeof f.id === 'string') existing.set(f.id, f);
      }
    }
  }

  const mapCtx = { competitionId: ctx.id, season: ctx.season };

  // Read the existing detail docs only for matches that will actually write
  // detail (terminal / with content) — a season of empty future fixtures costs
  // no detail reads. Used to dedup the detail/full writes via detailChanged.
  const detailIds = matches
    .filter(
      (m) =>
        existing.get(`fd-${m.id}`)?.finalCaptured !== true &&
        matchNeedsDetail(m as FootballDataMatch, mapCtx),
    )
    .map((m) => `fd-${m.id}`);
  const existingDetail = await readDetailDocs(db, detailIds);

  // Stage lean (fixtures/{id}) + rich (detail/full) writes, committing in
  // chunks so a full season (≈ 2 writes/match) stays under the batch cap.
  let batch = db.batch();
  let ops = 0;
  let writes = 0;
  for (const m of matches) {
    const id = `fd-${m.id}`;
    const r = stageMatchWrite(
      db,
      batch,
      id,
      m as FootballDataMatch,
      mapCtx,
      existing.get(id),
      existingDetail.get(id) ?? null,
    );
    ops += (r.leanWritten ? 1 : 0) + (r.detailWritten ? 1 : 0);
    if (r.leanWritten) writes++;
    if (ops >= BATCH_OP_LIMIT) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();

  // Per-comp rollup, refreshed only when a fixture's lean fields actually
  // changed. With writes === 0 the stored rollup already matches the canonical
  // docs, so rewriting it would be a pure waste; any change rebuilds it in full
  // from the API response below.
  if (writes > 0) {
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

// =============================================================================
// Bulk live poll
// =============================================================================
//
// The frequent (every-minute) path. Where `runPollFootballData` makes one
// request PER competition against the full-season `/competitions/{id}/matches`
// list, this makes ONE request total against the cross-competition
// `/v4/matches?competitions=…&dateFrom&dateTo` endpoint, narrowed to the
// matches that can change soon (yesterday → tomorrow). That single request
// covers every active comp's in-window matches, so live scoring costs 1 req/min
// instead of N — freeing the rate-limit budget for the per-match detail polls.
//
// It is NOT a replacement for the per-comp full fetch: the date window means it
// never sees the rest of the season, so it can't rebuild a comp's rollup from
// scratch (that would drop every out-of-window fixture). Instead it PATCHES the
// affected rollup entries in place, and the periodic full sync (see the
// scheduler below) stays responsible for ingesting new/out-of-window fixtures
// and rebuilding rollups wholesale.

/** How wide the bulk window reaches back/forward from "now", in days. One day
 *  back catches late-finishing matches across the UTC midnight boundary; two
 *  forward (dateTo is exclusive) covers today + tomorrow, so a match whose
 *  lineup window opens just before midnight is still in range. */
const LIVE_WINDOW_BACK_DAYS = 1;
const LIVE_WINDOW_FWD_DAYS = 2;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shiftDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * One bulk `/v4/matches` request across every active comp's in-window matches.
 * Diffs each against its stored canonical doc, writes only the changed ones
 * (same `fixtureChanged` gate the full poll uses), then patches the affected
 * per-comp rollups so the list view reflects the change without a full refetch.
 */
export async function runPollLiveWindow(token: string): Promise<PollSummary> {
  const db = getFirestore();
  const contexts = await resolveCompetitionContexts(db, undefined);

  // Only comps with a numeric fdId can go in the `competitions=` filter. Any
  // legacy doc without one is left to the periodic full sync (it addresses
  // comps by id there); log so a missing fdId doesn't silently drop a comp.
  const pollable = contexts.filter((c) => c.fdId !== null);
  const skipped = contexts.filter((c) => c.fdId === null);
  if (skipped.length > 0) {
    logger.info(`Live poll: ${skipped.length} comp(s) without fdId excluded from bulk call`, {
      comps: skipped.map((c) => c.id),
    });
  }
  if (pollable.length === 0) {
    return { ok: true, fetched: 0, written: 0, competitions: [], message: 'No comps with fdId' };
  }

  const ctxByFdId = new Map<number, CompetitionContext>();
  for (const c of pollable) ctxByFdId.set(c.fdId as number, c);

  const now = new Date();
  const dateFrom = isoDay(shiftDays(now, -LIVE_WINDOW_BACK_DAYS));
  const dateTo = isoDay(shiftDays(now, LIVE_WINDOW_FWD_DAYS)); // exclusive upper bound
  const comps = pollable.map((c) => c.fdId).join(',');
  const url =
    `https://api.football-data.org/v4/matches?competitions=${comps}` +
    `&dateFrom=${dateFrom}&dateTo=${dateTo}`;

  const res = await fetch(url, { headers: matchHeaders(token) });
  if (!res.ok) {
    const body = await res.text();
    logger.error('Live poll bulk fetch failed', { status: res.status, body });
    return {
      ok: false,
      fetched: 0,
      written: 0,
      competitions: [],
      message: `HTTP ${res.status}: ${body}`,
    };
  }

  const data = (await res.json()) as FootballDataResponse;
  const matches = data.matches ?? [];
  // Only matches belonging to a comp we actively track; the rest are ignored.
  const tracked = matches.filter((m) => m.competition && ctxByFdId.has(m.competition.id));

  // Bulk-read the canonical docs we might touch so the diff is one round-trip,
  // plus the existing detail docs for the matches that will write detail.
  const refs = tracked.map((m) => db.collection('fixtures').doc(`fd-${m.id}`));
  const snapshots = refs.length > 0 ? await db.getAll(...refs) : [];
  const existing = new Map<string, FixtureDoc>();
  for (const s of snapshots) {
    if (s.exists) existing.set(s.id, s.data() as FixtureDoc);
  }
  const detailIds = tracked
    .filter(
      (m) =>
        existing.get(`fd-${m.id}`)?.finalCaptured !== true &&
        matchNeedsDetail(m as FootballDataMatch),
    )
    .map((m) => `fd-${m.id}`);
  const existingDetail = await readDetailDocs(db, detailIds);

  let batch = db.batch();
  let ops = 0;
  let writes = 0;
  // Changed fixtures grouped by comp, so we patch each rollup once.
  const changedByComp = new Map<
    string,
    { ctx: CompetitionContext; entries: Array<{ id: string; doc: FixtureDoc }> }
  >();

  for (const m of tracked) {
    const ctx = ctxByFdId.get((m.competition as { id: number }).id) as CompetitionContext;
    const id = `fd-${m.id}`;
    const prev = existing.get(id);
    const mapCtx = { competitionId: ctx.id, season: ctx.season };

    // Stage the lean doc (clock tick re-anchors the client + feeds listeners)
    // and the rich detail/full split, each gated independently inside.
    const r = stageMatchWrite(db, batch, id, m as FootballDataMatch, mapCtx, prev, existingDetail.get(id) ?? null);
    ops += (r.leanWritten ? 1 : 0) + (r.detailWritten ? 1 : 0);
    if (r.leanWritten) writes++;
    if (ops >= BATCH_OP_LIMIT) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }

    // Only patch the rollup when a field the LIST shows changed (status, score,
    // kickoff) — not for a pure clock tick or detail-only change, which the
    // rollup never displays.
    const next = mapFixture(m as FootballDataMatch, mapCtx);
    if (fixtureListFieldsChanged(prev, next)) {
      let bucket = changedByComp.get(ctx.id);
      if (!bucket) {
        bucket = { ctx, entries: [] };
        changedByComp.set(ctx.id, bucket);
      }
      bucket.entries.push({ id, doc: next });
    }
  }

  if (ops > 0) await batch.commit();

  // Best-effort ESPN live overlay for the active comps, reusing the contexts we
  // already resolved. No-ops without an ESPN slug or an in-window fixture, so
  // this is cheap on idle minutes. Isolated so a failure can't fail the poll.
  for (const ctx of pollable) {
    try {
      await pollEspnLive(db, ctx);
    } catch (e: unknown) {
      logger.warn(`[${ctx.id}] ESPN live overlay failed (non-fatal)`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (writes > 0) {
    for (const { ctx, entries } of changedByComp.values()) {
      await patchRollup(db, ctx, entries);
    }
    // WC also has the legacy single rollup the client still falls back to.
    if (changedByComp.has('WC')) {
      await writeLegacyRollup(db);
    }
  }

  logger.info(`Live poll: ${matches.length} matches in window, ${writes} changed`, {
    comps: [...changedByComp.keys()],
  });

  return {
    ok: true,
    fetched: matches.length,
    written: writes,
    competitions: [...changedByComp.values()].map(({ ctx, entries }) => ({
      compId: ctx.id,
      ok: true,
      fetched: entries.length,
      written: entries.length,
    })),
  };
}

/**
 * Updates a comp's rollup doc in place with the fixtures that changed this
 * poll. Replaces entries by id (appends any not yet present — e.g. a brand-new
 * in-window match), keeping the same `{ id, ...FixtureDoc }` shape the full
 * sync writes. No-op if the rollup hasn't been built yet; the periodic full
 * sync creates it, and the client falls back to a collection scan meanwhile.
 */
async function patchRollup(
  db: FirebaseFirestore.Firestore,
  ctx: CompetitionContext,
  entries: Array<{ id: string; doc: FixtureDoc }>,
): Promise<void> {
  const ref = db.collection('cache').doc(`fixtures-${ctx.id}`);
  const snap = await ref.get();
  if (!snap.exists) return;

  const data = snap.data() ?? {};
  const current = Array.isArray(data['fixtures'])
    ? (data['fixtures'] as Array<Record<string, unknown>>)
    : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const f of current) {
    const id = typeof f['id'] === 'string' ? f['id'] : null;
    if (id) byId.set(id, f);
  }
  for (const { id, doc } of entries) {
    byId.set(id, { id, ...doc });
  }
  const merged = [...byId.values()];

  await ref.set(
    {
      competitionId: ctx.id,
      season: ctx.season,
      fixtures: merged,
      count: merged.length,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** How far ahead of kickoff the poller wakes. Set to the line-up window
 *  (~75 min before kickoff) so the per-match detail poll can capture line-ups
 *  as soon as football-data publishes them — must stay >= the detail poll's
 *  LINEUP_LOOKAHEAD_MS or the gate would skip the runs that fetch them. Also
 *  catches the TIMED→IN_PLAY transition promptly, as before. */
const MATCH_LOOKAHEAD_MS = 75 * 60 * 1000;

/** Upper bound on how long after kickoff a match could still be running
 *  (90' + stoppage + extra time + penalties + provider lag before it
 *  flips to FINISHED). Past this, a still-non-terminal fixture is treated
 *  as stale rather than live, so a stuck doc can't pin us in fast cadence
 *  forever. Exported so the stuck-fixture reconciler shares the exact same
 *  boundary (it picks up where this window leaves off). */
export const MAX_MATCH_DURATION_MS = 3 * 60 * 60 * 1000;

/** Statuses meaning a fixture won't change again — they don't keep the
 *  poller in its live cadence. Exported for the reconciler, which inverts
 *  this set to find fixtures still wrongly "live". */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
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

/**
 * Best-effort live-score overlay from ESPN's public (unofficial) scoreboard
 * for one competition. Writes ONLY the `live*` fields onto matching fixture
 * docs — never the authoritative `score`/`status`/`winner`, which stay
 * football-data's exclusively. The client treats `live*` as display-only and
 * scoring never reads them, so a wrong or stale ESPN value can't move points.
 *
 * Matching: ESPN and football-data have disjoint id spaces, so a fixture is
 * reconciled to an ESPN event by a natural key (UTC match day + the unordered
 * pair of FIFA 3-letter codes). The resolved ESPN id is written back as
 * `espnEventId` so subsequent polls short-circuit to a direct id lookup.
 *
 * Cost control: scoped to fixtures already in the live window (same bounds as
 * `isMatchWindow`), so with nothing live it returns before even hitting ESPN.
 * The window query is a single-field range (auto-indexed); the comp is
 * filtered in code to avoid a composite index — same trick as isMatchWindow.
 */
async function pollEspnLive(
  db: FirebaseFirestore.Firestore,
  ctx: CompetitionContext,
): Promise<void> {
  const slug = getEspnSlug(ctx.id);
  if (!slug) return; // comp not mapped to an ESPN league — skip silently

  const now = new Date();
  const lower = Timestamp.fromDate(new Date(now.getTime() - MAX_MATCH_DURATION_MS));
  const upper = Timestamp.fromDate(new Date(now.getTime() + MATCH_LOOKAHEAD_MS));
  const snap = await db
    .collection('fixtures')
    .where('utcKickoff', '>=', lower)
    .where('utcKickoff', '<=', upper)
    .limit(50)
    .get();
  const candidates = snap.docs
    .map((d) => ({ id: d.id, fx: d.data() as FixtureDoc }))
    .filter((c) => (c.fx.competitionId ?? 'WC') === ctx.id);
  if (candidates.length === 0) return; // nothing live for this comp — no fetch

  const events = await fetchEspnScoreboard(slug);
  if (events.length === 0) return;

  const mapped = events
    .map(mapEspnEvent)
    .filter((e): e is MappedEspnEvent => e !== null);
  const byId = new Map<string, MappedEspnEvent>(
    mapped.map((e) => [e.eventId, e] as [string, MappedEspnEvent]),
  );
  const byKey = new Map<string, MappedEspnEvent>(
    mapped.map((e) => [e.key, e] as [string, MappedEspnEvent]),
  );

  const batch = db.batch();
  let writes = 0;
  let matched = 0;
  const unmatched: string[] = [];

  for (const { id, fx } of candidates) {
    const home = fx.homeTeam.tla?.toUpperCase().trim();
    const away = fx.awayTeam.tla?.toUpperCase().trim();

    // Prefer the stored id (stable); fall back to the natural key on first
    // resolution. TBD fixtures (null codes) can't be keyed, so they skip.
    let ev = fx.espnEventId ? byId.get(fx.espnEventId) : undefined;
    if (!ev && home && away) {
      ev = byKey.get(naturalKey(fx.utcKickoff.toDate().toISOString(), home, away));
    }
    if (!ev) {
      if (home && away) unmatched.push(`${home}-${away}`);
      continue;
    }
    matched++;

    if (!liveOverlayChanged(fx, ev)) continue;
    batch.set(
      db.collection('fixtures').doc(id),
      {
        espnEventId: ev.eventId,
        liveScore: ev.live.score,
        liveState: ev.live.state,
        liveDetail: ev.live.detail,
        liveSyncedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    writes++;
  }

  if (writes > 0) await batch.commit();
  logger.info(
    `[${ctx.id}] ESPN live: ${matched}/${candidates.length} matched, ${writes} written`,
    { unmatched },
  );
}

/**
 * True when ESPN's snapshot differs from what's stored, so we only write
 * (and trigger client onSnapshot fan-out) on a real change.
 *
 * Deliberately diffs ONLY score, state, and the event-id link — NOT the
 * ticking clock or the `detail` label. The clock advances every poll, so
 * including it would rewrite the doc ~every 2 min during a match, and every
 * listening client pays a read per rewrite (~60/match) even with no goal.
 * Diffing on score+state instead means writes happen only on goals and
 * HT/FT transitions (~handful per match). The live clock is cosmetic — derive
 * an approximate minute client-side from kickoff if you want one back.
 */
function liveOverlayChanged(fx: FixtureDoc, ev: MappedEspnEvent): boolean {
  if ((fx.espnEventId ?? null) !== ev.eventId) return true;
  if ((fx.liveState ?? null) !== ev.live.state) return true;
  const ph = fx.liveScore?.home ?? null;
  const pa = fx.liveScore?.away ?? null;
  const nh = ev.live.score?.home ?? null;
  const na = ev.live.score?.away ?? null;
  return ph !== nh || pa !== na;
}

export const pollFootballData = onSchedule(
  {
    // Wake every minute, but the isMatchWindow gate below means we only do real
    // work when a match is live or imminent. The frequent work is one bulk
    // /v4/matches request (runPollLiveWindow) — with the unfold headers it now
    // carries full detail, so it writes BOTH the lean fixture doc and the rich
    // detail/full split, plus the ESPN overlay. The full per-comp season fetch
    // is no longer on a timer: it runs on competition activation / manual
    // re-sync (sync-competitions) and the stuck-fixture reconciler.
    schedule: 'every 1 minutes',
    region: 'europe-west1',
    secrets: [FOOTBALL_DATA_TOKEN],
    maxInstances: 1,
    timeoutSeconds: 120,
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

    // One bulk request refreshes every in-window match across all comps — lean
    // doc + detail/full split + ESPN overlay. Live data reaches clients via the
    // onSnapshot listeners; rollup patches keep the list view current.
    await runPollLiveWindow(token);

    // Head2head is the one rich subresource NOT in the list payload, so it
    // still needs a per-match call (once, when a lineup appears). Budgeted to
    // stay under the account's req/min cap alongside the bulk request.
    await runPollLiveDetail(token, 25);
  },
);
