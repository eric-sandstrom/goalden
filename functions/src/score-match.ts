import * as logger from 'firebase-functions/logger';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { FixtureDoc } from './lib/fixture-mapper';
import { scorePrediction } from './lib/scoring';

const BATCH_LIMIT = 450; // Firestore allows 500 ops per batch; leave headroom.

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

    const db = getFirestore();
    const predictionsSnap = await db
      .collectionGroup('matches')
      .where('matchId', '==', matchId)
      .get();

    logger.info(`Scoring ${predictionsSnap.size} predictions for ${matchId}`, {
      matchId,
      score: actual,
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

      batch.update(doc.ref, {
        points: result.points,
        pointsCategory: result.category,
      });
      ops++;

      const userRef = db.doc(`users/${uid}`);
      const totalsUpdate: Record<string, FirebaseFirestore.FieldValue> = {
        total: FieldValue.increment(result.points),
        match: FieldValue.increment(result.points),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (result.category === 'exact') {
        totalsUpdate['exactScoreHits'] = FieldValue.increment(1);
      } else if (result.category === 'outcome') {
        totalsUpdate['correctOutcomeHits'] = FieldValue.increment(1);
      }
      batch.set(userRef, { totals: totalsUpdate }, { merge: true });
      ops++;

      scored++;

      if (ops >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) await batch.commit();

    logger.info(`Scored ${scored} predictions for ${matchId}`);
  },
);
