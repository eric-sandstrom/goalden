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
 *   - `resetTotals`: zero out users/{uid}.totals
 *
 * Emulator-only.
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
      await db.doc(`users/${uid}`).set(
        {
          totals: {
            totalPoints: 0,
            matchPoints: 0,
            podiumPoints: 0,
            bracketPoints: 0,
            exactScoreHits: 0,
            correctOutcomeHits: 0,
            updatedAt: FieldValue.serverTimestamp(),
          },
        },
        { merge: true },
      );
    }

    logger.info(
      `devResetMyState: uid=${uid} matches=${clearMatchPredictions ? deletedMatches : 'skip'} podium=${clearPodium} totals=${resetTotals}`,
    );

    return {
      ok: true,
      deletedMatches,
      clearedPodium: clearPodium,
      resetTotals,
    };
  },
);
