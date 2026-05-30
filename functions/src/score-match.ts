import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { FixtureDoc } from './lib/fixture-mapper';
import { applyMatchScoring } from './lib/match-scoring';

/**
 * Scores every prediction for a match the moment it reaches a final result.
 * The actual scoring (points calc + per-comp totals shard writes + legacy WC
 * mirror + leaderboard mark) lives in `applyMatchScoring`, shared with the
 * admin `correctFixtureScore` callable. This trigger gates on the transition
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
  },
);
