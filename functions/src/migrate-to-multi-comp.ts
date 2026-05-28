import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { requireAdminOrEmulator } from './lib/admin-check';

/**
 * One-shot data backfill for the multi-competition cutover.
 *
 * Live data state before migration:
 *   - `fixtures/{matchId}` docs hold WC matches with no `competitionId`
 *     or `season` field (the schema pre-dates multi-comp).
 *   - `leagues/{id}` docs lack the same fields.
 *   - User totals live in the nested `users/{uid}.totals.*` field.
 *
 * Live data state after migration:
 *   - Every fixture / league doc carries `competitionId: 'WC'` and
 *     `season: '2026'`.
 *   - Every user with non-zero totals also has a
 *     `users/{uid}/totals/WC_2026` shard mirroring the nested values.
 *   - `competitions/WC.hasGlobalLeague = true` so the catalogue
 *     correctly reflects the auto-enrolled WC league.
 *
 * Idempotency: every write is a `{ merge: true }` set with fixed
 * values (no increments), so re-running the callable converges back
 * to the same state. After the dual-write window closes (a follow-up
 * deploy removes the legacy mirror from scoreMatch), this callable
 * stops being meaningful — but it stays available for the rare case
 * of restoring a backup.
 *
 * Race-safety: between read-legacy and write-shard, a concurrent
 * scoring event could double-fire and temporarily desync the two.
 * That's tolerated because the dual-write in scoreMatch keeps the
 * shard caught up on every subsequent scoring event — the only
 * window of inconsistency is < 1 score's worth of points. Cutover
 * is timed to run before WC matches start, so in practice no
 * scoring events fire concurrently.
 */
const LEGACY_COMP_ID = 'WC';
const LEGACY_SEASON = '2026';
/** Same headroom as scoreMatch — Firestore caps at 500 ops/batch. */
const BATCH_LIMIT = 450;

interface TotalsShape {
  total: number;
  match: number;
  podium: number;
  bracket: number;
  exactScoreHits: number;
  correctOutcomeHits: number;
}

export const migrateToMultiComp = onCall(
  { region: 'europe-west1', timeoutSeconds: 540 },
  async (request) => {
    await requireAdminOrEmulator(request);

    const db = getFirestore();

    // ---------------------------------------------------------------------
    // Precondition: the WC competition doc must already exist.
    // The cutover order is: deploy → syncCompetitionsFromApi (creates
    // competitions/{code} docs) → toggle WC active → run THIS migration.
    // Running this before sync would leave us with backfilled fixtures
    // pointing at a competitionId that doesn't have a catalogue doc.
    // ---------------------------------------------------------------------
    const wcRef = db.collection('competitions').doc(LEGACY_COMP_ID);
    const wcSnap = await wcRef.get();
    if (!wcSnap.exists) {
      throw new HttpsError(
        'failed-precondition',
        'competitions/WC missing — run syncCompetitionsFromApi first, then re-run this migration.',
      );
    }

    // ---------------------------------------------------------------------
    // Step 1: Backfill `competitionId` + `season` on every fixture missing
    // them. Firestore can't filter "field doesn't exist", so we read all
    // fixtures and let the in-memory check decide which ones need writes.
    // At ~104 docs pre-cutover this is cheap.
    // ---------------------------------------------------------------------
    const fixturesSnap = await db.collection('fixtures').get();
    let fixturesBackfilled = 0;
    let batch = db.batch();
    let ops = 0;
    for (const doc of fixturesSnap.docs) {
      const data = doc.data();
      if (typeof data['competitionId'] === 'string' && typeof data['season'] === 'string') {
        continue; // already tagged — idempotent skip
      }
      batch.update(doc.ref, {
        competitionId: LEGACY_COMP_ID,
        season: LEGACY_SEASON,
      });
      ops++;
      fixturesBackfilled++;
      if (ops >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
    logger.info(`Migration step 1: ${fixturesBackfilled} fixtures backfilled`);

    // ---------------------------------------------------------------------
    // Step 2: Same backfill for leagues. Existing leagues all pre-date
    // multi-comp so they implicitly belong to (WC, 2026).
    // ---------------------------------------------------------------------
    const leaguesSnap = await db.collection('leagues').get();
    let leaguesBackfilled = 0;
    batch = db.batch();
    ops = 0;
    for (const doc of leaguesSnap.docs) {
      const data = doc.data();
      if (typeof data['competitionId'] === 'string' && typeof data['season'] === 'string') {
        continue;
      }
      batch.update(doc.ref, {
        competitionId: LEGACY_COMP_ID,
        season: LEGACY_SEASON,
      });
      ops++;
      leaguesBackfilled++;
      if (ops >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
    logger.info(`Migration step 2: ${leaguesBackfilled} leagues backfilled`);

    // ---------------------------------------------------------------------
    // Step 3: Mirror users/{uid}.totals.* into the new per-comp shard
    // at users/{uid}/totals/WC_2026. Uses set() with literal values (not
    // FieldValue.increment) so re-runs converge instead of double-counting.
    //
    // Users with no nested totals (never scored anything) are skipped —
    // their shard will be created naturally on their first scored
    // prediction. Avoids creating empty shards that bloat Firestore.
    // ---------------------------------------------------------------------
    const usersSnap = await db.collection('users').get();
    let usersMigrated = 0;
    let usersSkipped = 0;
    batch = db.batch();
    ops = 0;
    for (const userDoc of usersSnap.docs) {
      const data = userDoc.data();
      const legacyTotals = data['totals'];
      if (!isMeaningfulTotals(legacyTotals)) {
        usersSkipped++;
        continue;
      }
      const totals = readTotals(legacyTotals);
      const shardRef = db.doc(
        `users/${userDoc.id}/totals/${LEGACY_COMP_ID}_${LEGACY_SEASON}`,
      );
      batch.set(
        shardRef,
        {
          competitionId: LEGACY_COMP_ID,
          season: LEGACY_SEASON,
          ...totals,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      ops++;
      usersMigrated++;
      if (ops >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
    logger.info(
      `Migration step 3: ${usersMigrated} users mirrored, ${usersSkipped} skipped (no totals)`,
    );

    // ---------------------------------------------------------------------
    // Step 4: Flag the WC catalogue entry as the host of an auto-enrolled
    // global league. The frontend uses this to surface "everyone is in
    // the WC league" affordances; today it's hardcoded but
    // CompetitionsService will read this flag once #70 lands.
    // ---------------------------------------------------------------------
    await wcRef.update({ hasGlobalLeague: true });
    logger.info('Migration step 4: competitions/WC.hasGlobalLeague = true');

    const summary = {
      ok: true,
      fixturesBackfilled,
      leaguesBackfilled,
      usersMigrated,
      usersSkipped,
    };
    logger.info('migrateToMultiComp finished', summary);
    return summary;
  },
);

/** Returns true when the nested `totals` blob has anything worth
 *  preserving — i.e. at least one numeric field above zero. Plain `{}`
 *  or `undefined` returns false so we skip those users. */
function isMeaningfulTotals(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const t = raw as Record<string, unknown>;
  const keys = [
    'total',
    'match',
    'podium',
    'bracket',
    'exactScoreHits',
    'correctOutcomeHits',
  ];
  return keys.some((k) => typeof t[k] === 'number' && (t[k] as number) > 0);
}

/** Normalises the legacy totals blob into the canonical shape, defaulting
 *  any missing numeric field to 0. Tolerates older docs with partial data
 *  (a user who only ever earned match points wouldn't have `podium`). */
function readTotals(raw: unknown): TotalsShape {
  const t = (raw ?? {}) as Record<string, unknown>;
  const num = (k: string): number => (typeof t[k] === 'number' ? (t[k] as number) : 0);
  return {
    total: num('total'),
    match: num('match'),
    podium: num('podium'),
    bracket: num('bracket'),
    exactScoreHits: num('exactScoreHits'),
    correctOutcomeHits: num('correctOutcomeHits'),
  };
}
