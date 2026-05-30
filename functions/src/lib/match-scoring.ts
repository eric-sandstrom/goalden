import * as logger from 'firebase-functions/logger';
import { FieldValue } from 'firebase-admin/firestore';
import { PointsCategory, scorePrediction } from './scoring';
import { markLeaderboardDirty } from '../leaderboard-rollup';

/**
 * Firestore allows 500 ops per batch; we cap below that for headroom.
 * Each scored prediction costs 3 ops (prediction update + per-comp
 * totals shard + combined user-doc totals write). Sized so a single
 * batch can hold ~150 predictions.
 */
const BATCH_LIMIT = 450;

/** Fallback (comp, season) for fixtures that predate multi-comp and
 *  lack the `competitionId` / `season` fields. Pre-migration the only
 *  competition was WC 2026, so defaulting there keeps those fixtures
 *  scoring into the right shard during the cutover gap. */
const DEFAULT_COMP_ID = 'WC';
const DEFAULT_SEASON = '2026';

/** Minimal fixture shape `applyMatchScoring` needs — works for both the
 *  full FixtureDoc (trigger path) and a hand-built object (admin path). */
interface ScorableFixture {
  competitionId?: unknown;
  season?: unknown;
  score?: {
    fullTime?: { home: number; away: number } | null;
    regularTime?: { home: number; away: number } | null;
  } | null;
}

export interface ApplyMatchScoringOptions {
  /**
   * `false` (the live `scoreMatch` trigger): only predictions that
   * haven't been scored yet (`points == null`) are scored, and points
   * are added with `FieldValue.increment`.
   *
   * `true` (the admin score-correction callable): already-scored
   * predictions are re-evaluated and totals move by the **delta** vs
   * their previously stored value — so correcting a wrong/late
   * football-data score nudges every affected user's totals up or down
   * by exactly the right amount without double-counting. Predictions
   * whose points don't change are left untouched.
   */
  force?: boolean;
}

/**
 * Score (or re-score) every prediction for a finished match and update
 * the per-(comp, season) totals shards. Extracted from `scoreMatch` so the
 * admin `correctFixtureScore` callable can re-run scoring on an
 * already-FINISHED fixture (the trigger only fires on the *transition*
 * into FINISHED, so a correction would otherwise never re-score).
 */
export async function applyMatchScoring(
  db: FirebaseFirestore.Firestore,
  matchId: string,
  fixture: ScorableFixture,
  options: ApplyMatchScoringOptions = {},
): Promise<{ scored: number }> {
  const force = options.force === true;

  // Grade on the 90-minute score: football-data's `fullTime` includes extra
  // time and penalty-shootout goals, so for matches that went past 90 we use
  // `regularTime` (the after-90 score). For matches decided in regulation
  // `regularTime` is absent and `fullTime` already IS the 90-minute score.
  const actual = fixture.score?.regularTime ?? fixture.score?.fullTime;
  if (!actual) {
    logger.warn(`applyMatchScoring: ${matchId} finished but no score — skipping`);
    return { scored: 0 };
  }

  // Resolve the fixture's (comp, season). Pre-migration WC fixtures may
  // lack these fields; default to ('WC', '2026') so scoring still
  // produces the right totals shard during the cutover gap.
  const compId = typeof fixture.competitionId === 'string' ? fixture.competitionId : DEFAULT_COMP_ID;
  const season = typeof fixture.season === 'string' ? fixture.season : DEFAULT_SEASON;
  const totalsShardId = `${compId}_${season}`;

  const predictionsSnap = await db
    .collectionGroup('matches')
    .where('matchId', '==', matchId)
    .get();

  logger.info(`Scoring ${predictionsSnap.size} predictions for ${matchId}`, {
    matchId,
    score: actual,
    competitionId: compId,
    season,
    force,
  });

  let batch = db.batch();
  let ops = 0;
  let scored = 0;

  for (const doc of predictionsSnap.docs) {
    const data = doc.data();
    const uid = doc.ref.parent.parent?.id;
    if (!uid) continue;
    if (typeof data['homeScore'] !== 'number' || typeof data['awayScore'] !== 'number') continue;

    const alreadyScored = data['points'] !== null && data['points'] !== undefined;
    // Trigger path: never touch a prediction that's already scored.
    if (alreadyScored && !force) continue;

    const next = scorePrediction(
      { homeScore: data['homeScore'], awayScore: data['awayScore'] },
      actual,
    );

    // Previously-stored values, so a re-score moves totals by the delta.
    // An unscored prediction contributes from a zero/none baseline.
    const prevPoints = alreadyScored && typeof data['points'] === 'number' ? data['points'] : 0;
    const prevCategory = alreadyScored ? (data['pointsCategory'] as PointsCategory | null) : null;

    const pointsDelta = next.points - prevPoints;
    const exactDelta = (next.category === 'exact' ? 1 : 0) - (prevCategory === 'exact' ? 1 : 0);
    const outcomeDelta = (next.category === 'outcome' ? 1 : 0) - (prevCategory === 'outcome' ? 1 : 0);

    // Re-score that changes nothing for this user → skip entirely so we
    // don't churn writes or nudge the leaderboard for unaffected users.
    if (alreadyScored && pointsDelta === 0 && exactDelta === 0 && outcomeDelta === 0) continue;

    // 1) Stamp the prediction with its computed points + category.
    batch.update(doc.ref, { points: next.points, pointsCategory: next.category });
    ops++;

    // 2) Per-comp totals shard — the authoritative location. Setting the
    //    (comp, season) scalars in the same write keeps the doc
    //    self-describing for cross-shard queries (lifetime totals).
    const totalsRef = db.doc(`users/${uid}/totals/${totalsShardId}`);
    const shardUpdate: Record<string, FirebaseFirestore.FieldValue | string> = {
      competitionId: compId,
      season,
      total: FieldValue.increment(pointsDelta),
      match: FieldValue.increment(pointsDelta),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (exactDelta !== 0) shardUpdate['exactScoreHits'] = FieldValue.increment(exactDelta);
    if (outcomeDelta !== 0) shardUpdate['correctOutcomeHits'] = FieldValue.increment(outcomeDelta);
    batch.set(totalsRef, shardUpdate, { merge: true });
    ops++;

    // 3) Combined cross-comp total on the user doc. Every competition's
    //    points accumulate here (not just WC), so `users/{uid}.totals`
    //    is the user's grand total across all comps. This is the
    //    denormalised field the global leaderboard rollup
    //    (`orderBy('totals.total')`), Home global-rank, and Profile read
    //    — keeping those one-doc reads cheap. Per-league views read the
    //    per-comp shard above instead, so league standings stay scoped
    //    to their own competition. Because we move by `pointsDelta`, a
    //    re-score (force) adjusts the combined total by exactly the
    //    change without double-counting across comps.
    const userRef = db.doc(`users/${uid}`);
    const combinedUpdate: Record<string, FirebaseFirestore.FieldValue> = {
      total: FieldValue.increment(pointsDelta),
      match: FieldValue.increment(pointsDelta),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (exactDelta !== 0) combinedUpdate['exactScoreHits'] = FieldValue.increment(exactDelta);
    if (outcomeDelta !== 0) combinedUpdate['correctOutcomeHits'] = FieldValue.increment(outcomeDelta);
    batch.set(userRef, { totals: combinedUpdate }, { merge: true });
    ops++;

    scored++;

    if (ops >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  if (ops > 0) await batch.commit();

  // Totals changed → nudge the global leaderboard rollup. Best-effort:
  // a failed mark must not fail scoring; the next scored match re-marks.
  if (scored > 0) {
    try {
      await markLeaderboardDirty(db);
    } catch (e: unknown) {
      logger.warn('Failed to mark leaderboard dirty (non-fatal)', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  logger.info(`Scored ${scored} predictions for ${matchId}`, {
    competitionId: compId,
    season,
    shardId: totalsShardId,
    force,
  });

  return { scored };
}
