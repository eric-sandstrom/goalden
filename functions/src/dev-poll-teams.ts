import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { FOOTBALL_DATA_TOKEN } from './poll-football-data';
import { runPollTeams } from './poll-teams';
import { requireAdminOrEmulator } from './lib/admin-check';

/**
 * Dev-only callable: forces a teams poll immediately, instead of waiting up
 * to an hour for the scheduled cron to fire. Reuses the exact same logic
 * the scheduled function runs, so verifying the dev path verifies the
 * production path too.
 *
 * Accepts an optional `compId` to scope the poll to one competition. Without
 * it, polls teams for every `competitions/* where active == true`, same as
 * the scheduled cron.
 *
 * Gated by `requireAdminOrEmulator`.
 */
export const devPollTeamsNow = onCall(
  { region: 'europe-west1', secrets: [FOOTBALL_DATA_TOKEN] },
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

    const result = await runPollTeams(token, compId);
    logger.info('devPollTeamsNow finished', {
      compId: compId ?? '(all active)',
      fetched: result.fetched,
      written: result.written,
      perComp: result.competitions.length,
    });
    return result;
  },
);
