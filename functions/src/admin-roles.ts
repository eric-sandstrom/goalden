import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { requireOwnerOrEmulator } from './lib/admin-check';

/**
 * Owner-only role-management callables.
 *
 * Goalden's role hierarchy is:
 *   - owner: top tier, bootstrapped manually via the Firestore console.
 *     Can grant/revoke admin to anyone except themselves and other
 *     owners. Owner implies admin (so admin-gated tools work for them
 *     out of the box).
 *   - admin: granted by an owner via the dev-tools UI. Can use the
 *     promoted dev tools (set fixture state, finish match, etc.) in
 *     production. Cannot grant or revoke roles.
 *   - (no role): standard user.
 *
 * The Firestore security rules already deny client-side writes to the
 * `roles` field — the only path to mutate it is through these callables
 * (Admin SDK bypasses rules), so there's no way for an admin to
 * self-promote to owner or grant admin to a friend without going
 * through `grantAdminRole`.
 */

function requireUid(data: unknown): string {
  const uid = (data as { uid?: unknown } | null)?.uid;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new HttpsError('invalid-argument', 'uid (string) is required');
  }
  return uid;
}

export const grantAdminRole = onCall(
  { region: 'europe-west1' },
  async (request) => {
    await requireOwnerOrEmulator(request);
    const targetUid = requireUid(request.data);

    const db = getFirestore();
    const ref = db.doc(`users/${targetUid}`);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError('not-found', `User ${targetUid} not found`);
    }

    await ref.update({
      // arrayUnion is idempotent — granting an already-admin user is
      // a no-op rather than producing a duplicate entry.
      roles: FieldValue.arrayUnion('admin'),
    });

    logger.info(
      `grantAdminRole: ${targetUid} promoted by ${request.auth?.uid ?? '(emulator)'}`,
    );
    return { ok: true, uid: targetUid };
  },
);

export const revokeAdminRole = onCall(
  { region: 'europe-west1' },
  async (request) => {
    await requireOwnerOrEmulator(request);
    const targetUid = requireUid(request.data);

    // Self-revoke is blocked. The point of being an owner is that you
    // can always grant/revoke — losing your own admin via this path
    // would be confusing (you'd still have owner, which implies admin,
    // but the visual feedback would suggest you're locked out).
    const callerUid = request.auth?.uid;
    if (callerUid && callerUid === targetUid) {
      throw new HttpsError(
        'failed-precondition',
        'Cannot revoke your own admin role.',
      );
    }

    const db = getFirestore();
    const ref = db.doc(`users/${targetUid}`);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError('not-found', `User ${targetUid} not found`);
    }

    const targetRoles = Array.isArray(snap.data()?.['roles'])
      ? (snap.data()!['roles'] as string[])
      : [];
    if (targetRoles.includes('owner')) {
      // Owners can't be casually demoted by another owner — that's a
      // co-founder dispute, not a dev-tools task. Bootstrap a new
      // owner via the Firestore console if you need to change things.
      throw new HttpsError(
        'failed-precondition',
        'Cannot revoke admin from an owner.',
      );
    }

    await ref.update({
      roles: FieldValue.arrayRemove('admin'),
    });

    logger.info(
      `revokeAdminRole: ${targetUid} demoted by ${callerUid ?? '(emulator)'}`,
    );
    return { ok: true, uid: targetUid };
  },
);
