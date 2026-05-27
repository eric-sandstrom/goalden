import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { requireAdminOrEmulator } from './lib/admin-check';

/**
 * Dev-only callable: override a fixture's `utcKickoff`. Accepts either an
 * absolute ISO datetime string or a relative offset in minutes from "now".
 *
 * Relative offsets are the common case — "move this fixture to 30 minutes from
 * now" lets you test the warn-chip ("Locks in 30m") instantly. Absolute is
 * there for the cases where you want to back-date a fixture (e.g. show what
 * yesterday's matches look like on the Finished tab).
 *
 * Emulator-only.
 */
export const devSetKickoffTime = onCall(
  { region: 'europe-west1' },
  async (request) => {
    await requireAdminOrEmulator(request);

    const { matchId, isoDateTime, offsetMinutes } = request.data ?? {};
    if (typeof matchId !== 'string' || matchId.length === 0) {
      throw new HttpsError('invalid-argument', 'matchId required');
    }

    let target: Date;
    if (typeof isoDateTime === 'string' && isoDateTime.length > 0) {
      const parsed = new Date(isoDateTime);
      if (Number.isNaN(parsed.getTime())) {
        throw new HttpsError('invalid-argument', 'isoDateTime is not a valid date');
      }
      target = parsed;
    } else if (typeof offsetMinutes === 'number' && Number.isFinite(offsetMinutes)) {
      target = new Date(Date.now() + offsetMinutes * 60_000);
    } else {
      throw new HttpsError(
        'invalid-argument',
        'provide either isoDateTime (string) or offsetMinutes (number)',
      );
    }

    const db = getFirestore();
    const ref = db.collection('fixtures').doc(matchId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError('not-found', `fixture ${matchId} not found`);
    }

    await ref.update({
      utcKickoff: Timestamp.fromDate(target),
    });

    logger.info(`devSetKickoffTime: ${matchId} -> ${target.toISOString()}`);
    return { ok: true, matchId, utcKickoff: target.toISOString() };
  },
);
