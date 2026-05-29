import * as logger from 'firebase-functions/logger';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { FixtureDoc } from './lib/fixture-mapper';
import { scorePrediction } from './lib/scoring';
import { markLeaderboardDirty } from './leaderboard-rollup';

/**
 * Firestore allows 500 ops per batch; we cap below that for headroom.
 * Each scored prediction costs 3 ops on a WC match (prediction update +
 * per-comp totals shard + legacy nested totals write) or 2 ops on a
 * non-WC match (no legacy write). Sized for the WC worst case so a
 * single batch can hold ~150 predictions.
 */
const BATCH_LIMIT = 450;

/** During the multi-comp cutover window, the WC totals shard is also
 *  mirrored onto the legacy `users/{uid}.totals.*` nested field so the
 *  current Home / Profile / Leaderboard / League-Detail readers (which
 *  hit the nested field) keep showing correct numbers. Non-WC comps
 *  never get a legacy mirror — those readers will move to the new
 *  shard path in task #71/#77 before any non-WC results land. */
const LEGACY_COMP_ID = 'WC';
const LEGACY_SEASON = '2026';

export const scoreMatch = onDocumentUpdated(
  {
    document: 'fixtures/{matchId}',
    region: 'europe-west1',
    timeoutSeconds: 120,
  },
  async (event) => {
    const matchId = event.params['matchId'] as string;
    const before = event.data?.before.data() as FixtureDoc | undefined;
    const after = event.data?.after.data() as FixtureDoc | undefined;
    if (!after) return;

    // Only act on the transition INTO FINISHED.
    if (before?.status === 'FINISHED' || after.status !== 'FINISHED') return;

    const actual = after.score.fullTime;
    if (!actual) {
      logger.warn(`Match ${matchId} finished but no fullTime score — skipping`);
      return;
    }

    // Resolve the fixture's (comp, season). Pre-migration WC fixtures
    // may lack these fields; default to ('WC', '2026') so scoring still
    // produces the right totals shard during the cutover gap. Once
    // migrateToMultiComp runs, every fixture has explicit values and
    // the fallback no longer activates.
    const compId =
      typeof after['competitionId'] === 'string' ? after['competitionId'] : LEGACY_COMP_ID;
    const season = typeof after['season'] === 'string' ? after['season'] : LEGACY_SEASON;
    const totalsShardId = `${compId}_${season}`;
    const isLegacyComp = compId === LEGACY_COMP_ID && season === LEGACY_SEASON;

    const db = getFirestore();
    const predictionsSnap = await db
      .collectionGroup('matches')
      .where('matchId', '==', matchId)
      .get();

    logger.info(`Scoring ${predictionsSnap.size} predictions for ${matchId}`, {
      matchId,
      score: actual,
      competitionId: compId,
      season,
    });

    let batch = db.batch();
    let ops = 0;
    let scored = 0;

    for (const doc of predictionsSnap.docs) {
      const data = doc.data();
      const uid = doc.ref.parent.parent?.id;
      if (!uid) continue;
      if (typeof data['homeScore'] !== 'number' || typeof data['awayScore'] !== 'number') continue;
      if (data['points'] !== null && data['points'] !== undefined) continue;

      const result = scorePrediction(
        { homeScore: data['homeScore'], awayScore: data['awayScore'] },
        actual,
      );

      // 1) Stamp the prediction with its computed points + category.
      batch.update(doc.ref, {
        points: result.points,
        pointsCategory: result.category,
      });
      ops++;

      // 2) Per-comp totals shard — the new authoritative location.
      //    Stored at users/{uid}/totals/{compId}_{season}. Setting the
      //    (comp, season) scalars in the same write makes the doc
      //    self-describing for cross-shard queries (e.g. the upcoming
      //    lifetime-totals sum).
      const totalsRef = db.doc(`users/${uid}/totals/${totalsShardId}`);
      const shardUpdate: Record<string, FirebaseFirestore.FieldValue | string> = {
        competitionId: compId,
        season,
        total: FieldValue.increment(result.points),
        match: FieldValue.increment(result.points),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (result.category === 'exact') {
        shardUpdate['exactScoreHits'] = FieldValue.increment(1);
      } else if (result.category === 'outcome') {
        shardUpdate['correctOutcomeHits'] = FieldValue.increment(1);
      }
      batch.set(totalsRef, shardUpdate, { merge: true });
      ops++;

      // 3) Legacy nested-field mirror — only for WC 2026. Keeps the
      //    pre-migration readers (Home, Profile, Leaderboard, League
      //    detail) seeing correct numbers during the cutover window.
      //    Removed in a follow-up deploy once every reader is moved
      //    to the new shard path.
      if (isLegacyComp) {
        const userRef = db.doc(`users/${uid}`);
        const legacyUpdate: Record<string, FirebaseFirestore.FieldValue> = {
          total: FieldValue.increment(result.points),
          match: FieldValue.increment(result.points),
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (result.category === 'exact') {
          legacyUpdate['exactScoreHits'] = FieldValue.increment(1);
        } else if (result.category === 'outcome') {
          legacyUpdate['correctOutcomeHits'] = FieldValue.increment(1);
        }
        batch.set(userRef, { totals: legacyUpdate }, { merge: true });
        ops++;
      }

      scored++;

      if (ops >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) await batch.commit();

    // Totals changed → nudge the global leaderboard rollup. One atomic
    // counter bump; the scheduled flush collapses a whole scoring burst
    // (and concurrent scoreMatch runs for other matches) into a single
    // rebuild. Best-effort: a failed mark must not fail scoring, and the
    // next scored match would re-mark anyway.
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
    });
  },
);
