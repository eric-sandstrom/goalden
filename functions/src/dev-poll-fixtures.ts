import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { FOOTBALL_DATA_TOKEN, runPollFootballData } from './poll-football-data';
import { requireAdminOrEmulator } from './lib/admin-check';

/**
 * Force a fixtures poll immediately instead of waiting up to 10 minutes
 * for the scheduled cron. Reuses the exact same logic the scheduled
 * function runs — including the per-comp rollup writes — so the client's
 * FixturesService sees populated data right after a click.
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

    const result = await runPollFootballData(token, compId);
    logger.info('devPollFixturesNow finished', {
      compId: compId ?? '(all active)',
      fetched: result.fetched,
      written: result.written,
      perComp: result.competitions.length,
    });
    return result;
  },
);
