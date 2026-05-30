import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { FixtureDoc } from './lib/fixture-mapper';
import { applyMatchScoring } from './lib/match-scoring';

/**
 * Scores every prediction for a match the moment it finishes. The actual
 * scoring (points calc + per-comp totals shard writes + legacy WC mirror +
 * leaderboard mark) lives in `applyMatchScoring`, shared with the admin
 * `correctFixtureScore` callable. This trigger just gates on the
 * transition INTO FINISHED and delegates with `force: false` so only
 * unscored predictions are touched.
 */
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

    // Only act on the transition INTO FINISHED. Re-scoring an
    // already-FINISHED fixture after a score correction goes through the
    // admin `correctFixtureScore` callable (which uses force: true).
    if (before?.status === 'FINISHED' || after.status !== 'FINISHED') return;

    await applyMatchScoring(getFirestore(), matchId, after, { force: false });
  },
);
