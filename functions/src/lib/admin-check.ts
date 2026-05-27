import { HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';

/**
 * Allow a callable to run when EITHER:
 *   - the caller is in the local Functions emulator
 *     (FUNCTIONS_EMULATOR=true), so day-to-day dev doesn't require
 *     granting yourself the admin role just to push the buttons; OR
 *   - the caller is a signed-in user whose user-doc `roles` array
 *     includes `'admin'`.
 *
 * Use on dev-flavoured callables we want to expose in production for
 * the "friends-test" workflow — e.g. setting a fixture to FINISHED with
 * a chosen score so we can watch scoreMatch run end-to-end on real
 * users' predictions.
 *
 * Throws an HttpsError that the client surfaces as a snackbar via the
 * existing dev-tools runCallable error path.
 */
export async function requireAdminOrEmulator(
  request: { auth?: { uid: string } | null },
): Promise<void> {
  if (process.env['FUNCTIONS_EMULATOR'] === 'true') return;

  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }

  const db = getFirestore();
  const snap = await db.doc(`users/${request.auth.uid}`).get();
  const data = snap.data() ?? {};
  const roles = Array.isArray(data['roles']) ? (data['roles'] as unknown[]) : [];
  if (!roles.includes('admin')) {
    throw new HttpsError('permission-denied', 'Admins only.');
  }
}
