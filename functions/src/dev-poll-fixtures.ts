import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { FOOTBALL_DATA_TOKEN, runPollFootballData } from './poll-football-data';
import { requireAdminOrEmulator } from './lib/admin-check';

/**
 * Force a fixtures poll immediately instead of waiting for the next
 * scheduled poll. Reuses the exact same logic the scheduled function runs
 * — including the per-comp rollup writes — so the client's FixturesService
 * sees populated data right after a click. Unlike the scheduled poller,
 * this runs unconditionally (no match-window gate), so it's the way to
 * refresh fixtures when nothing is live — e.g. seeding before a tournament.
 *
 * Accepts an optional `compId` to scope the poll to one competition.
 * Without it, polls every `competitions/* where active == true` in
 * sequence, same as the scheduled cron.
 *
 * Gated by `requireAdminOrEmulator` so admins can run it in production
 * during the friends-test workflow without needing the emulator.
 */
export const devPollFixturesNow = onCall(
  { region: 'europe-west1', secrets: [FOOTBALL_DATA_TOKEN], timeoutSeconds: 540 },
  async (request) => {
    await requireAdminOrEmulator(request);

    const token = FOOTBALL_DATA_TOKEN.value();
    if (!token) {
      throw new HttpsError(
        'failed-precondition',
        'FOOTBALL_DATA_TOKEN secret missing — set it via `firebase functions:secrets:set FOOTBALL_DATA_TOKEN`.',
      );
    }

    const compId = request.data?.compId;
    if (compId !== undefined && (typeof compId !== 'string' || compId.length === 0)) {
      throw new HttpsError('invalid-argument', 'compId must be a non-empty string when provided');
    }

    // reconcile = true: a manual "poll now" does a full getAll reconcile (not
    // the cheap rollup diff), so it always pulls every fixture to its canonical
    // doc -- the point of this button (e.g. seeding before a tournament).
    const result = await runPollFootballData(token, compId, true);
    logger.info('devPollFixturesNow finished', {
      compId: compId ?? '(all active)',
      fetched: result.fetched,
      written: result.written,
      perComp: result.competitions.length,
    });
    return result;
  },
);
