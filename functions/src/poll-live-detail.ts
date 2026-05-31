import * as logger from 'firebase-functions/logger';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { FixtureDoc } from './lib/fixture-mapper';
import { MatchDetailDoc, mapMatchDetail } from './lib/match-detail-mapper';
import { mapHead2Head } from './lib/head2head-mapper';
import { sleep } from './lib/competition-contexts';

/**
 * Windowed per-match detail poll — the depth pass that complements the bulk
 * score poll (`runPollLiveWindow`). For each fixture in the window it fetches
 * the rich `/v4/matches/{id}` endpoint (lineups + events) and, the first time a
 * lineup appears, the `/v4/matches/{id}/head2head` subresource. Both land in
 * `fixtures/{matchId}/detail/{full|head2head}` — the lean fixture doc stays
 * untouched, so this never bloats the broadcast/rollup paths.
 *
 * Per-match fetch policy (so we spend requests only where data is changing):
 *   - IN_PLAY / PAUSED   → fetch every run (events are accruing).
 *   - TIMED (in window)  → fetch only until a lineup is captured (~1h before
 *                          kickoff), then idle until it goes live.
 *   - FINISHED / AWARDED → one final fetch to capture the closing events, then
 *                          idle (marked via `finalCaptured`).
 *
 * `maxRequests` bounds total football-data calls this run (detail + head2head),
 * so the caller can keep the minute under the account's rate cap alongside the
 * bulk poll and the periodic full sync. Over-budget candidates are deferred to
 * the next run (logged, never silently dropped).
 */

/** Lineups publish ~1h before kickoff; 75m gives margin to catch them. */
const LINEUP_LOOKAHEAD_MS = 75 * 60 * 1000;

/** Upper bound on how long after kickoff a match might still be running — kept
 *  in step with the poller's MAX_MATCH_DURATION_MS. Past this a fixture leaves
 *  the detail window (its final was captured while it was still inside). */
const MATCH_MAX_DURATION_MS = 3 * 60 * 60 * 1000;

/** Politeness gap between football-data requests within a run. */
const INTER_REQUEST_DELAY_MS = 250;

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function len(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

export interface DetailPollSummary {
  ok: boolean;
  candidates: number;
  fetched: number;
  detailWrites: number;
  head2headWrites: number;
  deferred: number;
}

/** True when the stored detail doc already carries a non-empty lineup. */
function hasLineups(detail: Json | null): boolean {
  if (!detail) return false;
  return len(obj(detail['home'])?.['lineup']) > 0 || len(obj(detail['away'])?.['lineup']) > 0;
}

/**
 * True when the freshly-mapped detail differs from what's stored in a way worth
 * a write. Compares event/lineup counts (events only grow) and the full-time
 * score — enough to catch a new goal/card/sub, lineups appearing, or the final
 * landing, without deep-diffing every field on every poll.
 */
function detailChanged(existing: Json | null, next: MatchDetailDoc): boolean {
  if (!existing) return true;
  if (len(existing['goals']) !== next.goals.length) return true;
  if (len(existing['bookings']) !== next.bookings.length) return true;
  if (len(existing['substitutions']) !== next.substitutions.length) return true;
  const eh = obj(existing['home']);
  const ea = obj(existing['away']);
  if (len(eh?.['lineup']) !== next.home.lineup.length) return true;
  if (len(ea?.['lineup']) !== next.away.lineup.length) return true;
  if (len(eh?.['bench']) !== next.home.bench.length) return true;
  if (len(ea?.['bench']) !== next.away.bench.length) return true;
  const es = obj(existing['score']) ?? {};
  if (str(es['winner']) !== next.score.winner) return true;
  const eft = obj(es['fullTime']);
  if (num(eft?.['home']) !== (next.score.fullTime?.home ?? null)) return true;
  if (num(eft?.['away']) !== (next.score.fullTime?.away ?? null)) return true;
  return false;
}

export async function runPollLiveDetail(
  token: string,
  maxRequests: number,
): Promise<DetailPollSummary> {
  const db = getFirestore();
  const now = Date.now();
  const lower = Timestamp.fromMillis(now - MATCH_MAX_DURATION_MS);
  const upper = Timestamp.fromMillis(now + LINEUP_LOOKAHEAD_MS);

  // Single-field range — the automatic index covers it (same trick as the
  // poller's isMatchWindow); status is filtered in code.
  const snap = await db
    .collection('fixtures')
    .where('utcKickoff', '>=', lower)
    .where('utcKickoff', '<=', upper)
    .limit(100)
    .get();

  const fixtures = snap.docs
    .map((d) => ({ id: d.id, fx: d.data() as FixtureDoc }))
    .filter(({ fx }) => fx.status !== 'POSTPONED' && fx.status !== 'CANCELLED');

  if (fixtures.length === 0) {
    return { ok: true, candidates: 0, fetched: 0, detailWrites: 0, head2headWrites: 0, deferred: 0 };
  }

  // Bulk-read each candidate's detail/full so the fetch decision + the
  // detailChanged diff are one round-trip, not one read per match.
  const fullRefs = fixtures.map(({ id }) =>
    db.collection('fixtures').doc(id).collection('detail').doc('full'),
  );
  const fullSnaps = await db.getAll(...fullRefs);
  const fullById = new Map<string, Json | null>();
  fixtures.forEach(({ id }, i) => {
    const s = fullSnaps[i];
    fullById.set(id, s && s.exists ? (s.data() ?? {}) : null);
  });

  // Decide which to fetch, and in what priority order (live first, then the
  // soonest pre-match, then finished) so the budget goes to the most dynamic.
  type Candidate = { id: string; fx: FixtureDoc; priority: number };
  const toFetch: Candidate[] = [];
  for (const { id, fx } of fixtures) {
    const detail = fullById.get(id) ?? null;
    let fetch = false;
    let priority = 3;
    if (fx.status === 'IN_PLAY' || fx.status === 'PAUSED') {
      fetch = true;
      priority = 0;
    } else if (fx.status === 'TIMED') {
      fetch = !hasLineups(detail); // until the lineup is captured
      priority = 1;
    } else if (fx.status === 'FINISHED' || fx.status === 'AWARDED') {
      fetch = !detail || detail['finalCaptured'] !== true; // one closing capture
      priority = 2;
    }
    if (fetch) toFetch.push({ id, fx, priority });
  }
  toFetch.sort(
    (a, b) => a.priority - b.priority || a.fx.utcKickoff.toMillis() - b.fx.utcKickoff.toMillis(),
  );

  let budget = maxRequests;
  let fetched = 0;
  let detailWrites = 0;
  let head2headWrites = 0;
  let processed = 0;

  for (const cand of toFetch) {
    if (budget <= 0) break;
    processed++;
    const numericId = cand.id.replace(/^fd-/, '');
    if (!/^\d+$/.test(numericId)) continue;
    const baseUrl = `https://api.football-data.org/v4/matches/${numericId}`;

    // --- 1. Detail (lineups + events) -----------------------------------------
    let mapped: MatchDetailDoc;
    try {
      const res = await fetch(baseUrl, { headers: { 'X-Auth-Token': token } });
      budget--;
      fetched++;
      if (res.status === 429) {
        logger.warn('Detail poll rate-limited (429) — ending run early');
        break;
      }
      if (!res.ok) {
        logger.warn(`Detail fetch ${res.status} for ${cand.id}`);
        continue;
      }
      mapped = mapMatchDetail(await res.json());
    } catch (e: unknown) {
      logger.warn(`Detail fetch failed for ${cand.id}`, { error: String(e) });
      continue;
    }
    await sleep(INTER_REQUEST_DELAY_MS);

    const terminal = cand.fx.status === 'FINISHED' || cand.fx.status === 'AWARDED';
    const existing = fullById.get(cand.id) ?? null;
    if (detailChanged(existing, mapped) || (terminal && existing?.['finalCaptured'] !== true)) {
      await db
        .collection('fixtures')
        .doc(cand.id)
        .collection('detail')
        .doc('full')
        .set(
          { ...mapped, detailSyncedAt: FieldValue.serverTimestamp(), finalCaptured: terminal },
          { merge: false },
        );
      detailWrites++;
    }

    // --- 2. Head2head (once, when the lineup is known) ------------------------
    const lineupNow = mapped.home.lineup.length > 0 || mapped.away.lineup.length > 0;
    if (lineupNow && budget > 0) {
      const h2hRef = db.collection('fixtures').doc(cand.id).collection('detail').doc('head2head');
      const h2hSnap = await h2hRef.get();
      if (!h2hSnap.exists) {
        try {
          const res = await fetch(`${baseUrl}/head2head`, { headers: { 'X-Auth-Token': token } });
          budget--;
          if (res.ok) {
            await h2hRef.set(
              { ...mapHead2Head(await res.json()), capturedAt: FieldValue.serverTimestamp() },
              { merge: false },
            );
            head2headWrites++;
          } else {
            logger.warn(`Head2head fetch ${res.status} for ${cand.id}`);
          }
        } catch (e: unknown) {
          logger.warn(`Head2head fetch failed for ${cand.id}`, { error: String(e) });
        }
        await sleep(INTER_REQUEST_DELAY_MS);
      }
    }
  }

  const deferred = toFetch.length - processed;
  if (deferred > 0) {
    logger.info(
      `Detail poll: ${toFetch.length} candidates exceeded the ${maxRequests}-request budget — ${deferred} deferred to next run`,
    );
  }
  logger.info(
    `Detail poll: ${fetched} fetched, ${detailWrites} detail writes, ${head2headWrites} head2head writes`,
  );

  return {
    ok: true,
    candidates: toFetch.length,
    fetched,
    detailWrites,
    head2headWrites,
    deferred,
  };
}
