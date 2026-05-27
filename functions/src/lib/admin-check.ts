import { HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';

/**
 * Fetch the caller's roles from /users/{uid}. Returns an empty array
 * if the doc doesn't exist or the field is missing — never throws on
 * read errors, so callers can rely on the predicate semantics below.
 */
async function rolesFor(uid: string): Promise<readonly string[]> {
  const db = getFirestore();
  const snap = await db.doc(`users/${uid}`).get();
  const data = snap.data() ?? {};
  const raw = data['roles'];
  return Array.isArray(raw) ? (raw as string[]) : [];
}

/**
 * Allow a callable to run when EITHER:
 *   - the caller is in the local Functions emulator
 *     (FUNCTIONS_EMULATOR=true), so day-to-day dev doesn't require
 *     granting yourself the admin role just to push the buttons; OR
 *   - the caller is a signed-in user whose user-doc `roles` array
 *     includes `'admin'` or `'owner'` (owner implies admin).
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

  const roles = await rolesFor(request.auth.uid);
  if (!roles.includes('admin') && !roles.includes('owner')) {
    throw new HttpsError('permission-denied', 'Admins only.');
  }
}

/**
 * Stricter gate than `requireAdminOrEmulator`: only `'owner'` in the
 * caller's roles passes. Used by the role-management callables
 * (`grantAdminRole`, `revokeAdminRole`) so that admins can't promote
 * other admins — only the owner(s) can.
 *
 * Owner is bootstrapped manually via the Firestore console; from then
 * on owners can grant/revoke admin through the dev-tools UI.
 *
 * The emulator escape hatch still applies — local dev assumes the
 * developer is acting as the owner without needing the role granted.
 */
export async function requireOwnerOrEmulator(
  request: { auth?: { uid: string } | null },
): Promise<void> {
  if (process.env['FUNCTIONS_EMULATOR'] === 'true') return;

  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }

  const roles = await rolesFor(request.auth.uid);
  if (!roles.includes('owner')) {
    throw new HttpsError('permission-denied', 'Owners only.');
  }
}
