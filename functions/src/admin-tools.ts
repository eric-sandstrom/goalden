import * as logger from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { requireAdminOrEmulator } from './lib/admin-check';
import { applyMatchScoring } from './lib/match-scoring';

// =============================================================================
// correctFixtureScore({ matchId, homeScore, awayScore }) → { rescored, ... }
//
// Fixes a wrong or late football-data full-time score on a FINISHED fixture
// and re-scores every prediction against the corrected result. The live
// `scoreMatch` trigger only fires on the *transition* into FINISHED, so a
// correction (FINISHED → FINISHED) would otherwise never re-score — this
// callable closes that gap, applying the points delta vs each prediction's
// previously-stored value so totals move by exactly the right amount.
// =============================================================================

export const correctFixtureScore = onCall(
  { region: 'europe-west1', timeoutSeconds: 120 },
  async (request) => {
    await requireAdminOrEmulator(request);

    const { matchId, homeScore, awayScore } = request.data ?? {};
    if (typeof matchId !== 'string' || matchId.length === 0) {
      throw new HttpsError('invalid-argument', 'matchId required');
    }
    if (
      !Number.isInteger(homeScore) ||
      !Number.isInteger(awayScore) ||
      homeScore < 0 ||
      awayScore < 0
    ) {
      throw new HttpsError(
        'invalid-argument',
        'homeScore and awayScore must be non-negative integers',
      );
    }

    const db = getFirestore();
    const ref = db.collection('fixtures').doc(matchId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError('not-found', `fixture ${matchId} not found`);
    }
    const fixture = snap.data()!;
    if (fixture['status'] !== 'FINISHED') {
      throw new HttpsError(
        'failed-precondition',
        'Score correction only applies to FINISHED fixtures. Use dev-tools to finish a live match.',
      );
    }

    const winner = homeScore > awayScore ? 'HOME' : awayScore > homeScore ? 'AWAY' : 'DRAW';
    const score = { fullTime: { home: homeScore, away: awayScore }, winner };

    // Mirror a legit poll write (score + lastSyncedAt) so the fixture doc
    // looks the same as if football-data had corrected it.
    await ref.update({ score, lastSyncedAt: FieldValue.serverTimestamp() });

    // Re-score with the corrected result. force:true moves totals by the
    // delta vs each prediction's previously-stored points.
    const merged = { ...fixture, score };
    const { scored } = await applyMatchScoring(db, matchId, merged, { force: true });

    logger.info(`correctFixtureScore: ${matchId} -> ${homeScore}-${awayScore}, rescored ${scored}`);
    return { ok: true, matchId, homeScore, awayScore, winner, rescored: scored };
  },
);

// =============================================================================
// getAdminMetrics() → at-a-glance operational counts
//
// Predictions live under per-user subcollections that admins can't read
// across users via security rules, so the counts come from this Admin-SDK
// callable (which bypasses rules) rather than client reads. Uses Firestore
// aggregation (`.count()`) so we never pull the documents themselves.
// =============================================================================

export const getAdminMetrics = onCall(
  { region: 'europe-west1', timeoutSeconds: 60 },
  async (request) => {
    await requireAdminOrEmulator(request);
    const db = getFirestore();

    const leaguesCol = db.collection('leagues');
    const compsCol = db.collection('competitions');

    const [
      usersCount,
      leaguesTotal,
      leaguesGlobal,
      leaguesPublic,
      predictionsCount,
      compsTotal,
      compsActive,
      cacheSnap,
    ] = await Promise.all([
      db.collection('users').count().get(),
      leaguesCol.count().get(),
      leaguesCol.where('type', '==', 'global').count().get(),
      leaguesCol.where('type', '==', 'public').count().get(),
      db.collectionGroup('matches').count().get(),
      compsCol.count().get(),
      compsCol.where('active', '==', true).count().get(),
      db.collection('cache').get(),
    ]);

    const total = leaguesTotal.data().count;
    const global = leaguesGlobal.data().count;
    const pub = leaguesPublic.data().count;

    // Last fixture poll = newest `updatedAt` across the per-comp fixture
    // rollups (cache/fixtures-{compId}); leaderboard from cache/leaderboard.
    let lastFixturePoll: number | null = null;
    let lastLeaderboardRebuild: number | null = null;
    cacheSnap.forEach((d) => {
      const updatedAt = d.get('updatedAt');
      const ms = updatedAt instanceof Timestamp ? updatedAt.toMillis() : null;
      if (ms === null) return;
      if (d.id.startsWith('fixtures-')) {
        lastFixturePoll = lastFixturePoll === null ? ms : Math.max(lastFixturePoll, ms);
      } else if (d.id === 'leaderboard') {
        lastLeaderboardRebuild = ms;
      }
    });

    return {
      users: usersCount.data().count,
      predictions: predictionsCount.data().count,
      leagues: { total, global, public: pub, private: Math.max(0, total - global - pub) },
      competitions: { total: compsTotal.data().count, active: compsActive.data().count },
      lastFixturePoll,
      lastLeaderboardRebuild,
    };
  },
);
