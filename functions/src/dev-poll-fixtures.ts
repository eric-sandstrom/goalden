import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { FOOTBALL_DATA_TOKEN, runPollFootballData } from './poll-football-data';
import { requireAdminOrEmulator } from './lib/admin-check';

/**
 * Dev-only callable: forces a fixtures poll immediately instead of waiting
 * up to 10 minutes for the scheduled cron. Reuses the exact same logic the
 * scheduled function runs — including the cache/fixtures rollup write — so
 * the client's FixturesService sees populated data right after a click.
 *
 * Refuses to run anywhere except the local Functions emulator.
 */
export const devPollFixturesNow = onCall(
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

    const result = await runPollFootballData(token);
    logger.info('devPollFixturesNow finished', result);
    return result;
  },
);
