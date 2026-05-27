import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

/**
 * Dev-only one-click sign-in as a permanent admin user.
 *
 * Firebase Auth requires email/password for the public sign-in flow,
 * which means literally "admin" / "admin" as username/password isn't
 * possible — emails must contain @, passwords must be >= 6 chars.
 *
 * The workaround: mint a Firebase custom auth token server-side for
 * a fixed `dev-admin` uid. The client signs in with that token via
 * `signInWithCustomToken()`. No email, no password, no typing — just
 * a button click on the login page.
 *
 * This function:
 *   1. Ensures the dev-admin user exists in the Auth emulator.
 *   2. Ensures the user doc has displayName + admin role in Firestore.
 *   3. Returns a custom token bound to the dev-admin uid.
 *
 * Refuses to run anywhere except the local Functions emulator — same
 * gate as the other dev callables. The custom-token path itself is a
 * production-grade Firebase feature, but the WIDE-OPEN admin-role
 * grant absolutely must not happen in prod.
 */

const DEV_ADMIN_UID = 'dev-admin';
const DEV_ADMIN_EMAIL = 'admin@goalden.dev';
const DEV_ADMIN_NAME = 'Admin';

export const devSignInAsAdmin = onCall(
  { region: 'europe-west1' },
  async () => {
    if (process.env['FUNCTIONS_EMULATOR'] !== 'true') {
      throw new HttpsError('failed-precondition', 'Dev sign-in is emulator-only.');
    }
    // No auth check on this one — the whole point is to sign IN, so
    // the caller is necessarily unauthenticated.

    const auth = getAuth();
    const db = getFirestore();

    // 1. Ensure the Auth user exists. createUser throws if the uid is
    //    already taken; we swallow that and continue — the user just
    //    persists across emulator runs (handy for keeping data linked
    //    to the same uid).
    try {
      await auth.getUser(DEV_ADMIN_UID);
    } catch {
      await auth.createUser({
        uid: DEV_ADMIN_UID,
        email: DEV_ADMIN_EMAIL,
        displayName: DEV_ADMIN_NAME,
        emailVerified: true,
      });
      logger.info(`Created dev-admin user (uid=${DEV_ADMIN_UID})`);
    }

    // 2. Ensure the Firestore user doc carries the admin role. Merged
    //    so we don't clobber displayName edits or totals from previous
    //    sessions when the same uid signs back in.
    await db.doc(`users/${DEV_ADMIN_UID}`).set(
      {
        displayName: DEV_ADMIN_NAME,
        photoURL: null,
        roles: ['admin'],
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // 3. Mint a short-lived custom token. The client exchanges this
    //    for a regular ID token via signInWithCustomToken().
    const token = await auth.createCustomToken(DEV_ADMIN_UID);

    return { token };
  },
);
