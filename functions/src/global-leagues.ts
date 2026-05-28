import * as logger from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const NAME_MIN = 2;
const NAME_MAX = 60;
const FIRESTORE_BATCH_LIMIT = 400;

/**
 * Defaults applied when an admin creates a global league without
 * specifying (comp, season). Kept aligned with the createLeague
 * callable so legacy admin flows still produce the WC global league
 * everyone expects.
 */
const DEFAULT_COMP_ID = 'WC';
const DEFAULT_SEASON = '2026';

// =============================================================================
// Shared types
// =============================================================================

type AutoEnroll = 'all' | 'filter';

interface GlobalConfigInput {
  autoEnroll: AutoEnroll;
  filter?: { field: string; equals: string | number | boolean };
  allowLeave: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

function requireAuth(request: { auth?: { uid: string } | null }): string {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  return request.auth.uid;
}

/** Server-side mirror of UserService.isAdmin. Reads the caller's user doc
 *  and verifies `'admin'` is in the `roles` array. */
async function requireAdmin(uid: string): Promise<void> {
  const userSnap = await getFirestore().collection('users').doc(uid).get();
  const roles = (userSnap.data()?.['roles'] ?? []) as readonly string[];
  if (!Array.isArray(roles) || !roles.includes('admin')) {
    throw new HttpsError('permission-denied', 'Admin role required.');
  }
}

function validName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.trim().length >= NAME_MIN &&
    name.trim().length <= NAME_MAX
  );
}

/** Coerces a raw client payload into the strict GlobalConfigInput shape, or
 *  throws `invalid-argument`. Keeps the rest of the callable code clean. */
function parseConfig(raw: unknown): GlobalConfigInput {
  if (!raw || typeof raw !== 'object') {
    throw new HttpsError('invalid-argument', 'globalConfig required');
  }
  const data = raw as Record<string, unknown>;
  const autoEnroll = data['autoEnroll'];
  if (autoEnroll !== 'all' && autoEnroll !== 'filter') {
    throw new HttpsError('invalid-argument', 'autoEnroll must be "all" or "filter"');
  }
  const allowLeave = data['allowLeave'] === true;
  if (autoEnroll === 'all') {
    return { autoEnroll: 'all', allowLeave };
  }
  const filter = data['filter'];
  if (!filter || typeof filter !== 'object') {
    throw new HttpsError('invalid-argument', 'filter required when autoEnroll is "filter"');
  }
  const f = filter as Record<string, unknown>;
  const field = f['field'];
  const equals = f['equals'];
  if (typeof field !== 'string' || field.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'filter.field must be a non-empty string');
  }
  if (
    typeof equals !== 'string' &&
    typeof equals !== 'number' &&
    typeof equals !== 'boolean'
  ) {
    throw new HttpsError('invalid-argument', 'filter.equals must be string | number | boolean');
  }
  return { autoEnroll: 'filter', filter: { field, equals }, allowLeave };
}

/** Predicate used by both the trigger and the sync callable to decide
 *  whether a given user doc qualifies for membership in a global league. */
function userMatchesConfig(userData: Record<string, unknown>, config: GlobalConfigInput): boolean {
  if (config.autoEnroll === 'all') return true;
  if (config.autoEnroll === 'filter' && config.filter) {
    return userData[config.filter.field] === config.filter.equals;
  }
  return false;
}

// =============================================================================
// createGlobalLeague({ name, description?, globalConfig })
//   → { leagueId, enrolled }
// =============================================================================

export const createGlobalLeague = onCall(
  { region: 'europe-west1' },
  async (request) => {
    const uid = requireAuth(request);
    await requireAdmin(uid);

    const { name, description } = request.data ?? {};
    if (!validName(name)) {
      throw new HttpsError('invalid-argument', `name must be ${NAME_MIN}-${NAME_MAX} chars`);
    }
    const config = parseConfig(request.data?.globalConfig);

    // Same (comp, season) treatment as createLeague — global leagues
    // are also bound to a specific competition season. The doc on the
    // catalogue side gets its `hasGlobalLeague` flag flipped further
    // down so the picker knows this comp already has a global.
    const compRaw = request.data?.['competitionId'];
    const seasonRaw = request.data?.['season'];
    const competitionId =
      typeof compRaw === 'string' && compRaw.trim().length > 0
        ? compRaw.trim()
        : DEFAULT_COMP_ID;
    const season =
      typeof seasonRaw === 'string' && seasonRaw.trim().length > 0
        ? seasonRaw.trim()
        : DEFAULT_SEASON;

    const db = getFirestore();
    const compRef = db.collection('competitions').doc(competitionId);
    const compSnap = await compRef.get();
    if (!compSnap.exists) {
      throw new HttpsError(
        'not-found',
        `Competition '${competitionId}' not found. Sync it from football-data first.`,
      );
    }
    // No `active` check — global leagues are admin-curated. The admin
    // might want to spin one up before activating polling (e.g. WC
    // months ahead of kickoff). The catalogue having a doc is enough.

    const leagueRef = db.collection('leagues').doc();

    // Initial doc has memberCount=0; syncGlobalLeagueInner fills it in.
    await leagueRef.set({
      name: (name as string).trim(),
      description: typeof description === 'string' ? description.trim() : '',
      type: 'global',
      competitionId,
      season,
      globalConfig: config,
      ownerId: '',
      inviteCode: '',
      memberCount: 0,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: uid,
    });

    // Flip the catalogue flag so the create-league picker can hint
    // "this comp already has a global league" if it wants to.
    await compRef.update({ hasGlobalLeague: true });

    const { added } = await syncGlobalLeagueInner(leagueRef.id);

    logger.info(
      `Global league created: ${leagueRef.id} by ${uid} for ${competitionId} ${season}, enrolled ${added}`,
    );
    return { leagueId: leagueRef.id, enrolled: added };
  },
);

// =============================================================================
// syncGlobalLeague({ leagueId }) → { added, total }
// Re-evaluates conditions against every user doc and enrolls missing members.
// Idempotent — safe to re-run after changing the league's conditions or
// after bulk user imports.
// =============================================================================

export const syncGlobalLeague = onCall(
  { region: 'europe-west1' },
  async (request) => {
    const uid = requireAuth(request);
    await requireAdmin(uid);

    const { leagueId } = request.data ?? {};
    if (typeof leagueId !== 'string') {
      throw new HttpsError('invalid-argument', 'leagueId required');
    }
    return await syncGlobalLeagueInner(leagueId);
  },
);

/** Extracted so createGlobalLeague can call it inline without a recursive
 *  HTTPS round-trip. */
async function syncGlobalLeagueInner(leagueId: string): Promise<{ added: number; total: number }> {
  const db = getFirestore();
  const leagueRef = db.collection('leagues').doc(leagueId);
  const leagueSnap = await leagueRef.get();
  if (!leagueSnap.exists) {
    throw new HttpsError('not-found', 'League not found');
  }
  const data = leagueSnap.data()!;
  if (data['type'] !== 'global') {
    throw new HttpsError('failed-precondition', 'Not a global league');
  }
  const config = parseConfig(data['globalConfig']);

  // 1. Pull every eligible user doc. For `'all'` that's all docs; for
  //    `'filter'` we push the predicate down to a Firestore query so we
  //    don't read users that won't match.
  let usersQuery: FirebaseFirestore.Query = db.collection('users');
  if (config.autoEnroll === 'filter' && config.filter) {
    usersQuery = usersQuery.where(config.filter.field, '==', config.filter.equals);
  }
  const usersSnap = await usersQuery.get();

  // 2. Diff against existing members so we only add missing ones (idempotent).
  const membersRef = leagueRef.collection('members');
  const existingSnap = await membersRef.get();
  const existing = new Set(existingSnap.docs.map((d) => d.id));

  const toAdd = usersSnap.docs.filter((u) => !existing.has(u.id));
  let added = 0;

  for (let i = 0; i < toAdd.length; i += FIRESTORE_BATCH_LIMIT) {
    const batch = db.batch();
    for (const userDoc of toAdd.slice(i, i + FIRESTORE_BATCH_LIMIT)) {
      batch.set(membersRef.doc(userDoc.id), {
        uid: userDoc.id,
        role: 'member',
        joinedAt: FieldValue.serverTimestamp(),
      });
      added++;
    }
    await batch.commit();
  }

  // 3. Refresh memberCount from a recount. Cheaper than tracking deltas and
  //    self-heals from any past drift.
  const total = existing.size + added;
  await leagueRef.update({ memberCount: total });

  logger.info(`syncGlobalLeague ${leagueId}: added ${added}, total ${total}`);
  return { added, total };
}

// =============================================================================
// deleteGlobalLeague({ leagueId })
// Bulk-delete a global league + all its members. Admin only.
// =============================================================================

export const deleteGlobalLeague = onCall(
  { region: 'europe-west1' },
  async (request) => {
    const uid = requireAuth(request);
    await requireAdmin(uid);

    const { leagueId } = request.data ?? {};
    if (typeof leagueId !== 'string') {
      throw new HttpsError('invalid-argument', 'leagueId required');
    }

    const db = getFirestore();
    const leagueRef = db.collection('leagues').doc(leagueId);
    const leagueSnap = await leagueRef.get();
    if (!leagueSnap.exists) {
      throw new HttpsError('not-found', 'League not found');
    }
    if (leagueSnap.data()!['type'] !== 'global') {
      throw new HttpsError('failed-precondition', 'Not a global league. Use deleteLeague for private leagues.');
    }

    const membersRef = leagueRef.collection('members');
    const members = await membersRef.get();
    let batch = db.batch();
    let ops = 0;
    for (const m of members.docs) {
      batch.delete(m.ref);
      ops++;
      if (ops >= FIRESTORE_BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    batch.delete(leagueRef);
    await batch.commit();

    logger.info(`Global league ${leagueId} deleted by ${uid}`);
    return { ok: true };
  },
);

// =============================================================================
// autoEnrollOnUserCreate (Firestore trigger)
// Fires when users/{uid} is created. Enrols the new user in every global
// league whose conditions they satisfy.
// =============================================================================

export const autoEnrollOnUserCreate = onDocumentCreated(
  { document: 'users/{uid}', region: 'europe-west1' },
  async (event) => {
    const uid = event.params.uid;
    const userData = event.data?.data();
    if (!userData) return;

    const db = getFirestore();
    const globalLeagues = await db.collection('leagues').where('type', '==', 'global').get();
    if (globalLeagues.empty) return;

    const batch = db.batch();
    let enrolled = 0;
    for (const leagueDoc of globalLeagues.docs) {
      const config = leagueDoc.data()['globalConfig'];
      if (!config || typeof config !== 'object') continue;
      // Reuse the same predicate the sync uses to avoid drift.
      const parsedConfig = safeParseConfig(config);
      if (!parsedConfig) continue;
      if (!userMatchesConfig(userData, parsedConfig)) continue;

      const memberRef = leagueDoc.ref.collection('members').doc(uid);
      batch.set(memberRef, {
        uid,
        role: 'member',
        joinedAt: FieldValue.serverTimestamp(),
      });
      batch.update(leagueDoc.ref, { memberCount: FieldValue.increment(1) });
      enrolled++;
    }

    if (enrolled > 0) {
      await batch.commit();
      logger.info(`Auto-enrolled new user ${uid} in ${enrolled} global league(s)`);
    }
  },
);

/** Same shape as parseConfig but returns null instead of throwing — the
 *  trigger shouldn't crash on a malformed global league's config; it just
 *  skips that league. */
function safeParseConfig(raw: unknown): GlobalConfigInput | null {
  try {
    return parseConfig(raw);
  } catch {
    return null;
  }
}
