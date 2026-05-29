import * as logger from 'firebase-functions/logger';
import { onCall } from 'firebase-functions/v2/https';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { requireAdminOrEmulator } from './lib/admin-check';
import { runRebuildLeaderboard } from './leaderboard-rollup';

/**
 * Dev-only fake-user seeding for testing the leaderboard at volume before
 * real users exist. Fake docs live at `users/fake-NNN` with an `isFake`
 * marker (used for cleanup) and randomised totals. They behave like real
 * users for leaderboard purposes, and — because creating a user doc fires
 * `autoEnrollOnUserCreate` — they also auto-join any "all" global league,
 * so the global-league board fills too. `devClearFakeUsers` removes both
 * the docs and those auto-enrolled memberships.
 *
 * Admin/emulator-gated like the other dev callables. The points are
 * cosmetic test data, never produced by the real scoring engine.
 */

const MAX_FAKE_USERS = 200;
const DEFAULT_FAKE_USERS = 20;
const FAKE_PREFIX = 'fake-';
const BATCH_LIMIT = 450;

const NAMES = [
  'Ada', 'Bruno', 'Chiara', 'Diego', 'Emma', 'Farid', 'Greta', 'Hugo',
  'Ines', 'Jonas', 'Kira', 'Liam', 'Mira', 'Noah', 'Olu', 'Petra',
  'Quinn', 'Rosa', 'Sven', 'Tariq', 'Ula', 'Vik', 'Wren', 'Xander',
  'Yara', 'Zane',
];

/** Inclusive 0..max random integer. Math.random is fine in a callable
 *  (only forbidden in resumable workflow scripts). */
function randInt(maxInclusive: number): number {
  return Math.floor(Math.random() * (maxInclusive + 1));
}

export const devSeedFakeUsers = onCall(
  { region: 'europe-west1', timeoutSeconds: 120 },
  async (request) => {
    await requireAdminOrEmulator(request);

    const raw = request.data?.count;
    const count = Math.min(
      MAX_FAKE_USERS,
      Math.max(1, typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_FAKE_USERS),
    );

    const db = getFirestore();
    let batch = db.batch();
    let ops = 0;
    for (let i = 0; i < count; i++) {
      const uid = `${FAKE_PREFIX}${String(i).padStart(3, '0')}`;
      const match = randInt(312);
      const podium = randInt(50);
      const bracket = randInt(70);
      batch.set(
        db.doc(`users/${uid}`),
        {
          displayName: `${NAMES[i % NAMES.length]} ${String.fromCharCode(65 + (i % 26))}. (test)`,
          photoURL: null,
          createdAt: FieldValue.serverTimestamp(),
          isFake: true,
          roles: [],
          totals: {
            total: match + podium + bracket,
            match,
            podium,
            bracket,
            exactScoreHits: randInt(40),
            correctOutcomeHits: randInt(60),
          },
        },
        { merge: true },
      );
      if (++ops >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();

    // Force a rebuild so the fakes appear on the board immediately (the
    // scheduled flush doesn't run on a cron in the emulator anyway).
    const rollup = await runRebuildLeaderboard(db, true);
    logger.info(`Seeded ${count} fake users`, { leaderboardCount: rollup.count });
    return { created: count, leaderboardCount: rollup.count };
  },
);

export const devClearFakeUsers = onCall(
  { region: 'europe-west1', timeoutSeconds: 120 },
  async (request) => {
    await requireAdminOrEmulator(request);

    const db = getFirestore();
    const snap = await db.collection('users').where('isFake', '==', true).get();
    const fakeUids = new Set(snap.docs.map((d) => d.id));

    // 1. Delete the fake user docs.
    let batch = db.batch();
    let ops = 0;
    for (const d of snap.docs) {
      batch.delete(d.ref);
      if (++ops >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();

    // 2. Remove their auto-enrolled global-league memberships and correct
    //    each league's memberCount (recount, so it self-heals from drift).
    let membershipsRemoved = 0;
    const globals = await db.collection('leagues').where('type', '==', 'global').get();
    for (const league of globals.docs) {
      const members = await league.ref.collection('members').get();
      const fakeMembers = members.docs.filter((m) => fakeUids.has(m.id));
      if (fakeMembers.length === 0) continue;

      let b = db.batch();
      let o = 0;
      for (const m of fakeMembers) {
        b.delete(m.ref);
        membershipsRemoved++;
        if (++o >= BATCH_LIMIT) {
          await b.commit();
          b = db.batch();
          o = 0;
        }
      }
      b.update(league.ref, { memberCount: members.size - fakeMembers.length });
      await b.commit();
    }

    const rollup = await runRebuildLeaderboard(db, true);
    logger.info(
      `Cleared ${snap.size} fake users, ${membershipsRemoved} memberships`,
      { leaderboardCount: rollup.count },
    );
    return { deleted: snap.size, membershipsRemoved, leaderboardCount: rollup.count };
  },
);
