import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { FOOTBALL_DATA_TOKEN } from './poll-football-data';
import { runPollTeams } from './poll-teams';

/**
 * Dev-only callable: forces a teams poll immediately, instead of waiting up
 * to an hour for the scheduled cron to fire. Reuses the exact same logic
 * the scheduled function runs, so verifying the dev path verifies the
 * production path too.
 *
 * Refuses to run anywhere except the local Functions emulator.
 */
export const devPollTeamsNow = onCall(
  { region: 'europe-west1', secrets: [FOOTBALL_DATA_TOKEN] },
  async (request) => {
    if (process.env['FUNCTIONS_EMULATOR'] !== 'true') {
      throw new HttpsError('failed-precondition', 'Dev tools are emulator-only.');
    }
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in first.');
    }

    const token = FOOTBALL_DATA_TOKEN.value();
    if (!token) {
      throw new HttpsError(
        'failed-precondition',
        'FOOTBALL_DATA_TOKEN secret missing — set it via `firebase functions:secrets:set FOOTBALL_DATA_TOKEN`.',
      );
    }

    const result = await runPollTeams(token);
    logger.info('devPollTeamsNow finished', result);
    return result;
  },
);
