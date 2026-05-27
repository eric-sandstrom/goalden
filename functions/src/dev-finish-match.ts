import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { getFirestore } from 'firebase-admin/firestore';
import { requireAdminOrEmulator } from './lib/admin-check';

/**
 * Dev-only callable: forces a fixture into FINISHED with a given score so the
 * `scoreMatch` Firestore trigger fires and we can verify scoring end-to-end
 * without waiting for a real match to play out.
 *
 * Refuses to run anywhere except the local Functions emulator.
 */
export const devFinishMatch = onCall(
  { region: 'europe-west1' },
  async (request) => {
    await requireAdminOrEmulator(request);

    const { matchId, homeScore, awayScore } = request.data ?? {};
    if (typeof matchId !== 'string' || matchId.length === 0) {
      throw new HttpsError('invalid-argument', 'matchId required');
    }
    if (
      !Number.isInteger(homeScore) ||
      !Number.isInteger(awayScore) ||
      homeScore < 0 ||
      awayScore < 0
    ) {
      throw new HttpsError('invalid-argument', 'home/away scores must be non-negative integers');
    }

    const db = getFirestore();
    const ref = db.collection('fixtures').doc(matchId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError('not-found', `fixture ${matchId} not found`);
    }

    const winner =
      homeScore > awayScore ? 'HOME' : awayScore > homeScore ? 'AWAY' : 'DRAW';

    await ref.update({
      status: 'FINISHED',
      score: {
        fullTime: { home: homeScore, away: awayScore },
        winner,
      },
    });

    logger.info(`devFinishMatch: ${matchId} -> ${homeScore}-${awayScore} (${winner})`);
    return { ok: true, matchId, homeScore, awayScore, winner };
  },
);
