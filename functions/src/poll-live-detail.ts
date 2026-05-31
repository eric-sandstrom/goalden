import * as logger from 'firebase-functions/logger';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { FixtureDoc } from './lib/fixture-mapper';
import { mapHead2Head } from './lib/head2head-mapper';
import { sleep } from './lib/competition-contexts';

/**
 * Windowed head2head poll — the one rich subresource the match-list endpoints
 * do NOT carry even with the `X-Unfold-*` headers, so it still needs a
 * per-match call. Everything else that used to live here (lineups + goals +
 * cards + subs) now arrives on the bulk `/v4/matches` poll (see
 * `runPollLiveWindow`), which writes both the lean fixture doc and the rich
 * `fixtures/{id}/detail/full` split. This pass only fills
 * `fixtures/{id}/detail/head2head`, once per match.
 *
 * Gating: we wait until a lineup has been captured (the `lineupCaptured` flag
 * the bulk poll sets ~75m before kickoff) so we fetch head2head around match
 * time rather than for every far-future fixture, and we skip any match that
 * already has the subdoc. `maxRequests` bounds total calls per run so this
 * stays under the account's rate cap alongside the bulk request.
 */

/** Lineups publish ~1h before kickoff; 75m gives margin to catch them. */
const LINEUP_LOOKAHEAD_MS = 75 * 60 * 1000;

/** Upper bound on how long after kickoff a match might still be running — kept
 *  in step with the poller's MAX_MATCH_DURATION_MS. */
const MATCH_MAX_DURATION_MS = 3 * 60 * 60 * 1000;

/** Politeness gap between football-data requests within a run. */
const INTER_REQUEST_DELAY_MS = 250;

export interface DetailPollSummary {
  ok: boolean;
  candidates: number;
  fetched: number;
  /** Always 0 now — detail/full is written by the bulk poll. Kept for the
   *  callers/summaries that still read the shape. */
  detailWrites: number;
  head2headWrites: number;
  deferred: number;
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
  // poller's isMatchWindow); status + lineup flag are filtered in code.
  const snap = await db
    .collection('fixtures')
    .where('utcKickoff', '>=', lower)
    .where('utcKickoff', '<=', upper)
    .limit(100)
    .get();

  const candidates = snap.docs
    .map((d) => ({ id: d.id, fx: d.data() as FixtureDoc }))
    .filter(({ fx }) => fx.status !== 'POSTPONED' && fx.status !== 'CANCELLED')
    .filter(({ fx }) => fx.lineupCaptured === true);

  if (candidates.length === 0) {
    return { ok: true, candidates: 0, fetched: 0, detailWrites: 0, head2headWrites: 0, deferred: 0 };
  }

  // One read per candidate's head2head doc (bounded by the window) so we only
  // fetch the ones we don't already have — head2head never changes once stored.
  const h2hRefs = candidates.map((c) =>
    db.collection('fixtures').doc(c.id).collection('detail').doc('head2head'),
  );
  const h2hSnaps = await db.getAll(...h2hRefs);
  const missing = candidates.filter((_, i) => !h2hSnaps[i].exists);

  let budget = maxRequests;
  let fetched = 0;
  let head2headWrites = 0;
  let processed = 0;

  for (const cand of missing) {
    if (budget <= 0) break;
    processed++;
    const numericId = cand.id.replace(/^fd-/, '');
    if (!/^\d+$/.test(numericId)) continue;
    try {
      const res = await fetch(
        `https://api.football-data.org/v4/matches/${numericId}/head2head`,
        { headers: { 'X-Auth-Token': token } },
      );
      budget--;
      fetched++;
      if (res.status === 429) {
        logger.warn('Head2head poll rate-limited (429) — ending run early');
        break;
      }
      if (!res.ok) {
        logger.warn(`Head2head fetch ${res.status} for ${cand.id}`);
        continue;
      }
      await db
        .collection('fixtures')
        .doc(cand.id)
        .collection('detail')
        .doc('head2head')
        .set(
          { ...mapHead2Head(await res.json()), capturedAt: FieldValue.serverTimestamp() },
          { merge: false },
        );
      head2headWrites++;
    } catch (e: unknown) {
      logger.warn(`Head2head fetch failed for ${cand.id}`, { error: String(e) });
    }
    await sleep(INTER_REQUEST_DELAY_MS);
  }

  const deferred = missing.length - processed;
  if (deferred > 0) {
    logger.info(
      `Head2head poll: ${missing.length} candidates exceeded the ${maxRequests}-request budget — ${deferred} deferred to next run`,
    );
  }
  logger.info(`Head2head poll: ${fetched} fetched, ${head2headWrites} writes`);

  return {
    ok: true,
    candidates: missing.length,
    fetched,
    detailWrites: 0,
    head2headWrites,
    deferred,
  };
}
