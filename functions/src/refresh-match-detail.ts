import * as logger from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { FOOTBALL_DATA_TOKEN } from './poll-football-data';
import { mapMatchDetail } from './lib/match-detail-mapper';

/**
 * On-demand fetch of football-data.org's rich `/v4/matches/{id}` detail
 * (goals, bookings, substitutions, referees, lineups) into
 * `fixtures/{matchId}/detail/full`.
 *
 * The schedulers only hit the shallow `/competitions/{id}/matches` list, so
 * this is the sole path that ever populates per-match events. It's callable by
 * any signed-in user (the fixture-detail "refresh" button), which makes the
 * shared free-tier rate cap (10 req/min, one token for the whole app) the real
 * risk. Two guards bound it:
 *
 *   1. Finished-only — a match must be FINISHED/AWARDED to fetch. A finished
 *      match's events never change, so once fetched the data is permanent and
 *      the client hides the button.
 *   2. Throttle — if the detail doc was written within THROTTLE_MS we skip the
 *      API call entirely and report `throttled`. Combined with (1) this caps a
 *      given match to ~one real fetch regardless of how many users tap refresh.
 */

/** How recently a successful fetch must have run to skip re-hitting the API.
 *  Finished matches don't change, so this only ever needs to absorb a burst of
 *  taps right after kickoff-to-final; 10 min is comfortably wide. */
const THROTTLE_MS = 10 * 60 * 1000;

function requireAuth(request: { auth?: { uid: string } | null }): string {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  return request.auth.uid;
}

export const refreshMatchDetail = onCall(
  { region: 'europe-west1', secrets: [FOOTBALL_DATA_TOKEN], timeoutSeconds: 60 },
  async (request) => {
    requireAuth(request);

    const matchId = request.data?.matchId;
    if (typeof matchId !== 'string' || matchId.length === 0) {
      throw new HttpsError('invalid-argument', 'matchId required');
    }
    // Our fixture doc ids are `fd-{football-data-id}`; the detail endpoint
    // wants the bare numeric id.
    const numericId = matchId.replace(/^fd-/, '');
    if (!/^\d+$/.test(numericId)) {
      throw new HttpsError('invalid-argument', `matchId "${matchId}" is not a football-data id`);
    }

    const db = getFirestore();
    const fixtureRef = db.collection('fixtures').doc(matchId);
    const fixtureSnap = await fixtureRef.get();
    if (!fixtureSnap.exists) {
      throw new HttpsError('not-found', `fixture ${matchId} not found`);
    }
    const status = fixtureSnap.data()?.['status'];
    if (status !== 'FINISHED' && status !== 'AWARDED') {
      throw new HttpsError(
        'failed-precondition',
        'Match detail is only available once the match has finished.',
      );
    }

    const detailRef = fixtureRef.collection('detail').doc('full');
    const existing = await detailRef.get();
    if (existing.exists) {
      const syncedAt = existing.data()?.['detailSyncedAt'];
      const syncedMs = typeof syncedAt?.toMillis === 'function' ? syncedAt.toMillis() : 0;
      if (Date.now() - syncedMs < THROTTLE_MS) {
        logger.info(`refreshMatchDetail: ${matchId} served from throttle (recently synced)`);
        return { ok: true, throttled: true };
      }
    }

    const token = FOOTBALL_DATA_TOKEN.value();
    if (!token) {
      throw new HttpsError('internal', 'FOOTBALL_DATA_TOKEN secret missing');
    }

    const res = await fetch(`https://api.football-data.org/v4/matches/${numericId}`, {
      headers: { 'X-Auth-Token': token },
    });
    if (res.status === 429) {
      throw new HttpsError('resource-exhausted', 'Football-data rate limit hit — try again shortly.');
    }
    if (!res.ok) {
      logger.error(`refreshMatchDetail: football-data ${res.status} for ${numericId}`);
      throw new HttpsError('unavailable', `Football-data returned ${res.status}.`);
    }

    const detail = mapMatchDetail(await res.json());
    await detailRef.set(
      { ...detail, detailSyncedAt: FieldValue.serverTimestamp() },
      { merge: false },
    );

    logger.info(
      `refreshMatchDetail: ${matchId} -> ${detail.goals.length} goals, ` +
        `${detail.bookings.length} cards, ${detail.substitutions.length} subs`,
    );
    return { ok: true, throttled: false };
  },
);
