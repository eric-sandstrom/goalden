import * as logger from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { generateUniqueInviteCode } from './lib/invite-code';

const MEMBER_CAP = 500;
const NAME_MIN = 2;
const NAME_MAX = 40;

function requireAuth(request: { auth?: { uid: string } | null }): string {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  return request.auth.uid;
}

function validName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length >= NAME_MIN && name.trim().length <= NAME_MAX;
}

// ---------------------------------------------------------------------------
// createLeague({ name }) -> { leagueId, inviteCode }
// ---------------------------------------------------------------------------

export const createLeague = onCall({ region: 'europe-west1' }, async (request) => {
  const uid = requireAuth(request);
  const { name } = request.data ?? {};
  if (!validName(name)) {
    throw new HttpsError('invalid-argument', `name must be ${NAME_MIN}-${NAME_MAX} chars`);
  }

  const db = getFirestore();
  const inviteCode = await generateUniqueInviteCode();
  const leagueRef = db.collection('leagues').doc();
  const memberRef = leagueRef.collection('members').doc(uid);
  const publicRef = db.collection('leagues_public').doc(inviteCode);

  const trimmed = (name as string).trim();
  const batch = db.batch();
  batch.set(leagueRef, {
    name: trimmed,
    ownerId: uid,
    inviteCode,
    memberCount: 1,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(memberRef, {
    uid,
    role: 'owner',
    joinedAt: FieldValue.serverTimestamp(),
  });
  batch.set(publicRef, {
    leagueId: leagueRef.id,
    name: trimmed,
    memberCount: 1,
  });
  await batch.commit();

  logger.info(`League created: ${leagueRef.id} (${inviteCode}) by ${uid}`);
  return { leagueId: leagueRef.id, inviteCode };
});

// ---------------------------------------------------------------------------
// joinLeague({ inviteCode }) -> { leagueId }
// ---------------------------------------------------------------------------

export const joinLeague = onCall({ region: 'europe-west1' }, async (request) => {
  const uid = requireAuth(request);
  const { inviteCode } = request.data ?? {};
  if (typeof inviteCode !== 'string' || inviteCode.length === 0) {
    throw new HttpsError('invalid-argument', 'inviteCode required');
  }
  const normalized = inviteCode.toUpperCase().trim();

  const db = getFirestore();
  const publicRef = db.collection('leagues_public').doc(normalized);
  const publicSnap = await publicRef.get();
  if (!publicSnap.exists) {
    throw new HttpsError('not-found', 'Invalid invite code');
  }

  const leagueId = publicSnap.data()?.['leagueId'] as string;
  const leagueRef = db.collection('leagues').doc(leagueId);
  const memberRef = leagueRef.collection('members').doc(uid);

  await db.runTransaction(async (tx) => {
    const leagueSnap = await tx.get(leagueRef);
    if (!leagueSnap.exists) {
      throw new HttpsError('not-found', 'League no longer exists');
    }
    const data = leagueSnap.data()!;
    if (data['memberCount'] >= MEMBER_CAP) {
      throw new HttpsError('resource-exhausted', `League is full (cap ${MEMBER_CAP})`);
    }

    const existingMember = await tx.get(memberRef);
    if (existingMember.exists) return; // idempotent

    tx.set(memberRef, {
      uid,
      role: 'member',
      joinedAt: FieldValue.serverTimestamp(),
    });
    tx.update(leagueRef, { memberCount: FieldValue.increment(1) });
    tx.update(publicRef, { memberCount: FieldValue.increment(1) });
  });

  logger.info(`User ${uid} joined league ${leagueId}`);
  return { leagueId };
});

// ---------------------------------------------------------------------------
// leaveLeague({ leagueId })
// ---------------------------------------------------------------------------

export const leaveLeague = onCall({ region: 'europe-west1' }, async (request) => {
  const uid = requireAuth(request);
  const { leagueId } = request.data ?? {};
  if (typeof leagueId !== 'string') {
    throw new HttpsError('invalid-argument', 'leagueId required');
  }

  const db = getFirestore();
  const leagueRef = db.collection('leagues').doc(leagueId);
  const memberRef = leagueRef.collection('members').doc(uid);

  await db.runTransaction(async (tx) => {
    const leagueSnap = await tx.get(leagueRef);
    if (!leagueSnap.exists) {
      throw new HttpsError('not-found', 'League does not exist');
    }
    const data = leagueSnap.data()!;

    // Global leagues: respect globalConfig.allowLeave. Owners don't exist
    // for global leagues so the ownership check below is skipped for them.
    if (data['type'] === 'global') {
      const allowLeave = data['globalConfig']?.allowLeave === true;
      if (!allowLeave) {
        throw new HttpsError(
          'failed-precondition',
          'This league is mandatory — you cannot leave.',
        );
      }
      const memberSnap = await tx.get(memberRef);
      if (!memberSnap.exists) return; // already not a member
      tx.delete(memberRef);
      tx.update(leagueRef, { memberCount: FieldValue.increment(-1) });
      // Global leagues have no leagues_public mirror — no second update.
      return;
    }

    // Private league: existing owner-cannot-leave + mirror update logic.
    if (data['ownerId'] === uid) {
      throw new HttpsError(
        'failed-precondition',
        'Transfer ownership before leaving your own league.',
      );
    }
    const memberSnap = await tx.get(memberRef);
    if (!memberSnap.exists) return;

    tx.delete(memberRef);
    tx.update(leagueRef, { memberCount: FieldValue.increment(-1) });
    const publicRef = db.collection('leagues_public').doc(data['inviteCode']);
    tx.update(publicRef, { memberCount: FieldValue.increment(-1) });
  });

  return { ok: true };
});

// ---------------------------------------------------------------------------
// deleteLeague({ leagueId })
// ---------------------------------------------------------------------------

export const deleteLeague = onCall({ region: 'europe-west1' }, async (request) => {
  const uid = requireAuth(request);
  const { leagueId } = request.data ?? {};
  if (typeof leagueId !== 'string') {
    throw new HttpsError('invalid-argument', 'leagueId required');
  }

  const db = getFirestore();
  const leagueRef = db.collection('leagues').doc(leagueId);
  const leagueSnap = await leagueRef.get();
  if (!leagueSnap.exists) {
    throw new HttpsError('not-found', 'League does not exist');
  }
  const data = leagueSnap.data()!;
  // Global leagues route through deleteGlobalLeague (admin-only). Refuse
  // here so a private-league owner can't trip into a global-league code
  // path with the wrong assumptions.
  if (data['type'] === 'global') {
    throw new HttpsError(
      'failed-precondition',
      'Global leagues can only be removed via deleteGlobalLeague (admin only).',
    );
  }
  if (data['ownerId'] !== uid) {
    throw new HttpsError('permission-denied', 'Only the owner can delete a league.');
  }

  // Bulk delete all members.
  const membersRef = leagueRef.collection('members');
  const members = await membersRef.get();
  let batch = db.batch();
  let ops = 0;
  for (const m of members.docs) {
    batch.delete(m.ref);
    ops++;
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  batch.delete(leagueRef);
  batch.delete(db.collection('leagues_public').doc(data['inviteCode']));
  await batch.commit();

  logger.info(`League ${leagueId} deleted by ${uid}`);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// regenerateInviteCode({ leagueId }) -> { inviteCode }
// ---------------------------------------------------------------------------

export const regenerateInviteCode = onCall({ region: 'europe-west1' }, async (request) => {
  const uid = requireAuth(request);
  const { leagueId } = request.data ?? {};
  if (typeof leagueId !== 'string') {
    throw new HttpsError('invalid-argument', 'leagueId required');
  }

  const db = getFirestore();
  const leagueRef = db.collection('leagues').doc(leagueId);
  const leagueSnap = await leagueRef.get();
  if (!leagueSnap.exists) throw new HttpsError('not-found', 'League does not exist');
  const data = leagueSnap.data()!;
  if (data['ownerId'] !== uid) {
    throw new HttpsError('permission-denied', 'Only the owner can regenerate the invite code.');
  }

  const oldCode = data['inviteCode'] as string;
  const newCode = await generateUniqueInviteCode();
  const oldPublicRef = db.collection('leagues_public').doc(oldCode);
  const newPublicRef = db.collection('leagues_public').doc(newCode);

  const batch = db.batch();
  batch.update(leagueRef, { inviteCode: newCode });
  batch.delete(oldPublicRef);
  batch.set(newPublicRef, {
    leagueId,
    name: data['name'],
    memberCount: data['memberCount'],
  });
  await batch.commit();

  return { inviteCode: newCode };
});

// ---------------------------------------------------------------------------
// transferOwnership({ leagueId, newOwnerUid })
// ---------------------------------------------------------------------------

export const transferOwnership = onCall({ region: 'europe-west1' }, async (request) => {
  const uid = requireAuth(request);
  const { leagueId, newOwnerUid } = request.data ?? {};
  if (typeof leagueId !== 'string' || typeof newOwnerUid !== 'string') {
    throw new HttpsError('invalid-argument', 'leagueId and newOwnerUid required');
  }
  if (newOwnerUid === uid) {
    throw new HttpsError('invalid-argument', 'You already own this league.');
  }

  const db = getFirestore();
  const leagueRef = db.collection('leagues').doc(leagueId);

  await db.runTransaction(async (tx) => {
    const leagueSnap = await tx.get(leagueRef);
    if (!leagueSnap.exists) throw new HttpsError('not-found', 'League does not exist');
    if (leagueSnap.data()!['ownerId'] !== uid) {
      throw new HttpsError('permission-denied', 'Only the owner can transfer ownership.');
    }
    const newOwnerMemberRef = leagueRef.collection('members').doc(newOwnerUid);
    const oldOwnerMemberRef = leagueRef.collection('members').doc(uid);
    const newOwnerMember = await tx.get(newOwnerMemberRef);
    if (!newOwnerMember.exists) {
      throw new HttpsError('not-found', 'New owner must already be a member of the league.');
    }
    tx.update(leagueRef, { ownerId: newOwnerUid });
    tx.update(newOwnerMemberRef, { role: 'owner' });
    tx.update(oldOwnerMemberRef, { role: 'member' });
  });

  return { ok: true };
});

// ---------------------------------------------------------------------------
// kickMember({ leagueId, memberUid })
// ---------------------------------------------------------------------------

export const kickMember = onCall({ region: 'europe-west1' }, async (request) => {
  const uid = requireAuth(request);
  const { leagueId, memberUid } = request.data ?? {};
  if (typeof leagueId !== 'string' || typeof memberUid !== 'string') {
    throw new HttpsError('invalid-argument', 'leagueId and memberUid required');
  }
  if (memberUid === uid) {
    throw new HttpsError('invalid-argument', "You can't kick yourself; use leaveLeague.");
  }

  const db = getFirestore();
  const leagueRef = db.collection('leagues').doc(leagueId);

  await db.runTransaction(async (tx) => {
    const leagueSnap = await tx.get(leagueRef);
    if (!leagueSnap.exists) throw new HttpsError('not-found', 'League does not exist');
    const data = leagueSnap.data()!;
    if (data['ownerId'] !== uid) {
      throw new HttpsError('permission-denied', 'Only the owner can kick members.');
    }
    const memberRef = leagueRef.collection('members').doc(memberUid);
    const memberSnap = await tx.get(memberRef);
    if (!memberSnap.exists) return;
    tx.delete(memberRef);
    tx.update(leagueRef, { memberCount: FieldValue.increment(-1) });
    tx.update(db.collection('leagues_public').doc(data['inviteCode']), {
      memberCount: FieldValue.increment(-1),
    });
  });

  return { ok: true };
});
