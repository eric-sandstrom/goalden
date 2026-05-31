import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import * as logger from 'firebase-functions/logger';
import { getFirestore } from 'firebase-admin/firestore';
import { FixtureDoc } from './lib/fixture-mapper';
import { applyMatchScoring } from './lib/match-scoring';
import { FOOTBALL_DATA_TOKEN } from './poll-football-data';
import { runPollStandings } from './poll-standings';

/**
 * Scores every prediction for a match the moment it reaches a final result.
 * The actual scoring (points calc + per-comp totals shard writes + combined
 * user-doc total + leaderboard mark) lives in `applyMatchScoring`, shared with
 * the admin `correctFixtureScore` callable. This trigger gates on the transition
 * INTO a terminal status and delegates with `force: false` so only unscored
 * predictions are touched.
 *
 * Gating is on the *normalised* status (`FINISHED`/`AWARDED`), not on the
 * presence of `score.fullTime`: football-data reports the running score in
 * `fullTime` during IN_PLAY/PAUSED, so a score-presence gate would score
 * matches mid-play. The cancelled-but-played case (a played match the
 * provider mislabels CANCELLED while still counting it) is handled upstream —
 * the poller's `normalizeStatus` rewrites it to FINISHED — so it arrives here
 * as a normal transition into FINISHED. AWARDED (walkovers) is included too;
 * the previous FINISHED-only gate never scored those. A later score
 * correction (already terminal) doesn't re-fire here; that path is the admin
 * `correctFixtureScore` callable with force: true.
 */
function isFinal(status: string | undefined): boolean {
  return status === 'FINISHED' || status === 'AWARDED';
}

export const scoreMatch = onDocumentUpdated(
  {
    document: 'fixtures/{matchId}',
    region: 'europe-west1',
    secrets: [FOOTBALL_DATA_TOKEN],
    timeoutSeconds: 120,
  },
  async (event) => {
    const matchId = event.params['matchId'] as string;
    const before = event.data?.before.data() as FixtureDoc | undefined;
    const after = event.data?.after.data() as FixtureDoc | undefined;
    if (!after) return;

    // Act only on the transition INTO a final status. If it was already
    // final before this update, scoring already ran (or a correction is in
    // flight via the admin callable) — don't re-fire.
    if (!isFinal(after.status) || isFinal(before?.status)) return;

    await applyMatchScoring(getFirestore(), matchId, after, { force: false });

    // A finished match changes its competition's table, so refresh standings
    // now that the standalone standings scheduler is retired. Best-effort: the
    // poll gates writes on a content signature, and any failure must never
    // affect scoring (already committed above).
    const token = FOOTBALL_DATA_TOKEN.value();
    if (token) {
      const compId = after.competitionId ?? 'WC';
      try {
        await runPollStandings(token, compId);
      } catch (e: unknown) {
        logger.warn(`[${compId}] standings refresh after ${matchId} failed (non-fatal)`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  },
);
