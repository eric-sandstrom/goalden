import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { requireAdminOrEmulator } from './lib/admin-check';

type Status = 'TIMED' | 'IN_PLAY' | 'PAUSED' | 'FINISHED';

const VALID_STATUS = new Set<Status>(['TIMED', 'IN_PLAY', 'PAUSED', 'FINISHED']);

/**
 * Dev-only callable: set a fixture to any status with an optional score. This
 * is the swiss-army knife behind the fixture-state buttons in the dev panel.
 *
 * - `TIMED` clears the score (back-to-scheduled).
 * - `IN_PLAY` / `PAUSED` set the running score (homeScore/awayScore required).
 * - `FINISHED` sets the final score and fires the scoreMatch trigger
 *   (homeScore/awayScore required).
 *
 * Emulator-only. Refuses to run in production.
 */
export const devSetFixtureState = onCall(
  { region: 'europe-west1' },
  async (request) => {
    await requireAdminOrEmulator(request);

    const { matchId, status, homeScore, awayScore } = request.data ?? {};
    if (typeof matchId !== 'string' || matchId.length === 0) {
      throw new HttpsError('invalid-argument', 'matchId required');
    }
    if (typeof status !== 'string' || !VALID_STATUS.has(status as Status)) {
      throw new HttpsError(
        'invalid-argument',
        `status must be one of ${[...VALID_STATUS].join(', ')}`,
      );
    }

    const db = getFirestore();
    const ref = db.collection('fixtures').doc(matchId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError('not-found', `fixture ${matchId} not found`);
    }

    const update: Record<string, unknown> = { status };

    if (status === 'TIMED') {
      // Reset back to scheduled — wipe the score so the live scoreboard
      // doesn't keep showing stale data.
      update['score'] = null;
    } else {
      if (
        !Number.isInteger(homeScore) ||
        !Number.isInteger(awayScore) ||
        homeScore < 0 ||
        awayScore < 0
      ) {
        throw new HttpsError(
          'invalid-argument',
          'homeScore/awayScore must be non-negative integers for non-TIMED states',
        );
      }
      const winner =
        homeScore > awayScore ? 'HOME' : awayScore > homeScore ? 'AWAY' : 'DRAW';
      // For IN_PLAY/PAUSED we still write fullTime — football-data.org reports
      // the running score in the same field, and our UI reads it the same way.
      update['score'] = {
        fullTime: { home: homeScore, away: awayScore },
        winner: status === 'FINISHED' ? winner : null,
      };
    }

    update['lastSyncedAt'] = FieldValue.serverTimestamp();

    await ref.update(update);

    logger.info(
      `devSetFixtureState: ${matchId} -> ${status}${
        status !== 'TIMED' ? ` ${homeScore}-${awayScore}` : ''
      }`,
    );
    return { ok: true, matchId, status, homeScore, awayScore };
  },
);
