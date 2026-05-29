import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onCall } from 'firebase-functions/v2/https';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { requireAdminOrEmulator } from './lib/admin-check';

/**
 * Server-maintained global leaderboard rollup.
 *
 * Instead of every client listening to the top-100 `users` docs directly
 * (a cold load of ~100 reads, and ~100 reads per client on every scoring
 * burst), the client reads ONE doc — `cache/leaderboard` — which this
 * module keeps current. That turns the per-client cost into 1 read on load
 * and 1 read per rebuild. Same pattern as the fixtures rollups.
 *
 * Rebuild trigger: a monotonic `scoringSeq` counter is bumped (atomically,
 * so bumps are never lost) whenever totals change (scoreMatch) or a
 * profile field that shows on the board changes (rename / photo). A
 * scheduled flush rebuilds only when the counter has advanced since the
 * last build — so idle periods cost one tiny read per tick, and a whole
 * scoring burst collapses into a single 100-doc rebuild.
 */

const ROLLUP_PATH = 'cache/leaderboard';
const PAGE_SIZE = 100;

interface RollupEntry {
  uid: string;
  rank: number;
  displayName: string;
  photoURL: string | null;
  totals: {
    total: number;
    match: number;
    podium: number;
    bracket: number;
    exactScoreHits: number;
    correctOutcomeHits: number;
  };
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

/**
 * Bumps the rollup's change counter so the next scheduled flush rebuilds.
 * Atomic increment → concurrent bumps from a scoring burst all register
 * and collapse into one rebuild. Cheap (one merge write); call once per
 * totals-mutating operation.
 */
export async function markLeaderboardDirty(
  db: FirebaseFirestore.Firestore,
): Promise<void> {
  await db.doc(ROLLUP_PATH).set({ scoringSeq: FieldValue.increment(1) }, { merge: true });
}

/**
 * Builds the top-PAGE_SIZE entries. Mirrors the query the client used to
 * run directly (order by the nested WC `totals.total`), so moving the
 * client onto this doc changes cost, not semantics.
 */
async function buildEntries(db: FirebaseFirestore.Firestore): Promise<RollupEntry[]> {
  const snap = await db
    .collection('users')
    .orderBy('totals.total', 'desc')
    .limit(PAGE_SIZE)
    .get();
  const entries: RollupEntry[] = [];
  let rank = 1;
  snap.forEach((d) => {
    const data = d.data();
    const t = (data['totals'] ?? {}) as Record<string, unknown>;
    entries.push({
      uid: d.id,
      rank: rank++,
      displayName: typeof data['displayName'] === 'string' ? data['displayName'] : 'Unknown',
      photoURL: typeof data['photoURL'] === 'string' ? data['photoURL'] : null,
      totals: {
        total: num(t['total']),
        match: num(t['match']),
        podium: num(t['podium']),
        bracket: num(t['bracket']),
        exactScoreHits: num(t['exactScoreHits']),
        correctOutcomeHits: num(t['correctOutcomeHits']),
      },
    });
  });
  return entries;
}

/**
 * Rebuilds the rollup when its counter advanced since the last build (or
 * always, when forced). Seq-gated so idle ticks cost one read, not a
 * 100-doc query. We record the seq observed BEFORE building, so any bumps
 * that land mid-build leave seq > builtSeq and the next tick rebuilds —
 * no update is silently dropped.
 */
export async function runRebuildLeaderboard(
  db: FirebaseFirestore.Firestore,
  force = false,
): Promise<{ rebuilt: boolean; count: number }> {
  const ref = db.doc(ROLLUP_PATH);
  const snap = await ref.get();
  const data = snap.data() ?? {};
  const seq = num(data['scoringSeq']);
  const built = typeof data['builtSeq'] === 'number' ? (data['builtSeq'] as number) : -1;

  if (!force && seq === built) {
    const existing = Array.isArray(data['entries']) ? data['entries'].length : 0;
    return { rebuilt: false, count: existing };
  }

  const entries = await buildEntries(db);
  await ref.set(
    {
      entries,
      count: entries.length,
      builtSeq: seq,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return { rebuilt: true, count: entries.length };
}

/** Scheduled flush. On a brand-new doc seq(0) !== builtSeq(-1), so the
 *  rollup self-seeds within one tick of deploy. */
export const rebuildLeaderboard = onSchedule(
  {
    schedule: 'every 2 minutes',
    region: 'europe-west1',
    maxInstances: 1,
    timeoutSeconds: 120,
  },
  async () => {
    const result = await runRebuildLeaderboard(getFirestore());
    if (result.rebuilt) {
      logger.info(`Leaderboard rollup rebuilt (${result.count} entries)`);
    }
  },
);

/**
 * Profile-field changes (rename, new photo) also change leaderboard rows.
 * Mark dirty ONLY when displayName/photoURL actually changed — NOT on
 * totals-only writes — so a scoring burst (which writes the nested totals
 * on each user doc) doesn't fan out into N markers here; scoreMatch marks
 * once for those.
 */
export const onUserProfileChange = onDocumentWritten(
  { document: 'users/{uid}', region: 'europe-west1' },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!after) return; // deletion — next scoring rebuild prunes the row
    const nameChanged = before?.['displayName'] !== after['displayName'];
    const photoChanged = (before?.['photoURL'] ?? null) !== (after['photoURL'] ?? null);
    if (!before || nameChanged || photoChanged) {
      await markLeaderboardDirty(getFirestore());
    }
  },
);

/**
 * Force an immediate rebuild, bypassing the seq gate. Lets admins seed or
 * refresh the rollup on demand — e.g. in the emulator (where the scheduled
 * trigger doesn't fire on a cron) or before the tournament when there's no
 * scoring to advance the counter.
 */
export const devRebuildLeaderboardNow = onCall(
  { region: 'europe-west1', timeoutSeconds: 120 },
  async (request) => {
    await requireAdminOrEmulator(request);
    const result = await runRebuildLeaderboard(getFirestore(), true);
    logger.info('devRebuildLeaderboardNow finished', result);
    return result;
  },
);
