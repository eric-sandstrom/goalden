import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { requireAdminOrEmulator } from './lib/admin-check';

/**
 * Dev-only callable: wipe the caller's predictions and/or totals so we can
 * replay the journey from scratch without re-creating the whole emulator
 * dataset.
 *
 * Flags (all default false — caller must opt in explicitly):
 *   - `clearMatchPredictions`: delete every doc under predictions/{uid}/matches
 *   - `clearPodium`: delete predictions/{uid}/podium/picks
 *   - `resetTotals`: zero out the legacy users/{uid}.totals nested field
 *     AND delete every per-comp totals shard under
 *     users/{uid}/totals/{compId_season}. Both are touched because
 *     during the multi-comp cutover the scoring engine dual-writes WC
 *     points to both locations — clearing only one leaves the other
 *     stale and confuses the UI.
 *
 * Admin-gated so this can run in production (friends-test workflow).
 */
export const devResetMyState = onCall(
  { region: 'europe-west1' },
  async (request) => {
    await requireAdminOrEmulator(request);
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in first.');
    }

    const uid = request.auth.uid;
    const {
      clearMatchPredictions = false,
      clearPodium = false,
      resetTotals = false,
    } = request.data ?? {};

    if (!clearMatchPredictions && !clearPodium && !resetTotals) {
      throw new HttpsError('invalid-argument', 'no reset flag set — nothing to do');
    }

    const db = getFirestore();
    let deletedMatches = 0;
    let deletedShards = 0;

    // Match predictions live in their own subcollection — we need to fetch
    // every doc ref to delete them. Batches are capped at 500 ops; if a user
    // has more than 500 predictions we chunk it (unlikely for v1: 104 matches).
    if (clearMatchPredictions) {
      const snap = await db.collection(`predictions/${uid}/matches`).get();
      const docs = snap.docs;
      for (let i = 0; i < docs.length; i += 400) {
        const batch = db.batch();
        for (const d of docs.slice(i, i + 400)) batch.delete(d.ref);
        await batch.commit();
      }
      deletedMatches = docs.length;
    }

    if (clearPodium) {
      await db.doc(`predictions/${uid}/podium/picks`).delete();
    }

    if (resetTotals) {
      // 1) Zero out the legacy nested totals on the user doc. Uses the
      //    same field names the scoring engine writes (`total`, `match`,
      //    `podium`, `bracket`, `exactScoreHits`, `correctOutcomeHits`)
      //    so the readers actually see zeros instead of stale stats
      //    sitting next to fresh zeros under different names.
      await db.doc(`users/${uid}`).set(
        {
          totals: {
            total: 0,
            match: 0,
            podium: 0,
            bracket: 0,
            exactScoreHits: 0,
            correctOutcomeHits: 0,
            updatedAt: FieldValue.serverTimestamp(),
          },
        },
        { merge: true },
      );

      // 2) Delete every per-comp totals shard. We could `set` zeros
      //    instead, but the shard is fully derived from prediction
      //    points so deletion is cleaner — next scored prediction
      //    creates the shard fresh. Chunked into batches the same
      //    way we delete match predictions.
      const shardsSnap = await db.collection(`users/${uid}/totals`).get();
      const shards = shardsSnap.docs;
      for (let i = 0; i < shards.length; i += 400) {
        const batch = db.batch();
        for (const d of shards.slice(i, i + 400)) batch.delete(d.ref);
        await batch.commit();
      }
      deletedShards = shards.length;
    }

    logger.info(
      `devResetMyState: uid=${uid} matches=${clearMatchPredictions ? deletedMatches : 'skip'} podium=${clearPodium} totals=${resetTotals} shards=${deletedShards}`,
    );

    return {
      ok: true,
      deletedMatches,
      clearedPodium: clearPodium,
      resetTotals,
      deletedShards,
    };
  },
);
