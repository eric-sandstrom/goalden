import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { FOOTBALL_DATA_TOKEN, runPollLiveWindow } from './poll-football-data';
import { runPollLiveDetail } from './poll-live-detail';
import { requireAdminOrEmulator } from './lib/admin-check';

/**
 * Force the frequent live pipeline immediately instead of waiting for the next
 * scheduled minute — the bulk score poll (`runPollLiveWindow`) followed by the
 * per-match detail/head2head depth pass (`runPollLiveDetail`). Runs
 * unconditionally (no isMatchWindow gate), so it's the way to exercise/verify
 * the live + detail + head2head writes on demand — e.g. after using the dev
 * tools to push a fixture IN_PLAY or set its kickoff near now.
 *
 * Gated by `requireAdminOrEmulator` so it's usable in the emulator and by
 * admins in production during testing.
 */
export const devPollLiveDetailNow = onCall(
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

    const live = await runPollLiveWindow(token);
    const detail = await runPollLiveDetail(token, 25);

    logger.info('devPollLiveDetailNow finished', {
      liveWritten: live.written,
      detailCandidates: detail.candidates,
      detailWrites: detail.detailWrites,
      head2headWrites: detail.head2headWrites,
    });
    return { live, detail };
  },
);
