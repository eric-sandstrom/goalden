import * as logger from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { requireAdminOrEmulator } from './lib/admin-check';

/** FCM caps a single multicast at 500 tokens, so we chunk the broadcast. */
const MULTICAST_CHUNK = 500;

/** FCM error codes that mean the token is permanently dead — safe to delete. */
function isDeadToken(code: string | undefined): boolean {
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-argument' ||
    code === 'messaging/invalid-registration-token'
  );
}

/**
 * Sends a test web-push to every device the caller has registered
 * (users/{uid}/devices/*). Lets a user confirm notifications actually arrive
 * after opting in, and exercises the full pipeline (token → FCM → SW). Also
 * the reference implementation for any future push (match reminders, etc.):
 * fetch tokens → sendEachForMulticast → prune the ones FCM rejects.
 */
export const sendTestNotification = onCall(async (req) => {
  const uid = req.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign in to send a test notification.');
  }

  const db = getFirestore();
  const snap = await db.collection(`users/${uid}/devices`).get();
  const docs = snap.docs.filter((d) => {
    const t = d.get('fcmToken');
    return typeof t === 'string' && t.length > 0;
  });
  const tokens = docs.map((d) => d.get('fcmToken') as string);

  if (tokens.length === 0) {
    return { sent: 0, failed: 0, devices: 0 };
  }

  const res = await getMessaging().sendEachForMulticast({
    tokens,
    notification: {
      title: 'Goalden',
      body: 'Push notifications are working 🎉',
    },
    webpush: {
      notification: {
        icon: '/icons/icon-192x192.png',
        // Monochrome status-bar silhouette on Android (alpha-masked to white).
        badge: '/icons/badge-96x96.png',
      },
      fcmOptions: { link: '/' },
    },
  });

  // Prune tokens FCM permanently rejected so dead devices don't accumulate.
  const deletions = res.responses
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !r.success && isDeadToken(r.error?.code))
    .map(({ i }) => docs[i].ref.delete());
  await Promise.allSettled(deletions);

  return { sent: res.successCount, failed: res.failureCount, devices: tokens.length };
});

/**
 * Admin-only broadcast: pushes a one-off announcement to every registered
 * device across all users (outages, schedule changes, "podium picks lock
 * tonight", etc.). Distinct from the per-user `sendTestNotification` and the
 * scheduled match reminders — this is the manual "tell everyone" lever.
 *
 * Collects every `users/{uid}/devices/*` token via a collection-group query,
 * sends in ≤500-token multicast chunks, and prunes the tokens FCM rejects
 * (same dead-token cleanup as the test push).
 */
export const broadcastNotification = onCall(
  { region: 'europe-west1', timeoutSeconds: 300 },
  async (request) => {
    await requireAdminOrEmulator(request);

    const { title, body, link } = request.data ?? {};
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'title required');
    }
    if (typeof body !== 'string' || body.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'body required');
    }
    const targetLink = typeof link === 'string' && link.trim().length > 0 ? link.trim() : '/';

    const db = getFirestore();
    const snap = await db.collectionGroup('devices').get();
    const docs = snap.docs.filter((d) => {
      const t = d.get('fcmToken');
      return typeof t === 'string' && t.length > 0;
    });
    const users = new Set(
      docs.map((d) => d.ref.parent.parent?.id).filter((id): id is string => Boolean(id)),
    );

    if (docs.length === 0) {
      return { users: 0, devices: 0, sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;
    const deletions: Promise<unknown>[] = [];

    for (let i = 0; i < docs.length; i += MULTICAST_CHUNK) {
      const chunk = docs.slice(i, i + MULTICAST_CHUNK);
      const res = await getMessaging().sendEachForMulticast({
        tokens: chunk.map((d) => d.get('fcmToken') as string),
        notification: { title: title.trim(), body: body.trim() },
        webpush: {
          notification: {
            icon: '/icons/icon-192x192.png',
            badge: '/icons/badge-96x96.png',
          },
          fcmOptions: { link: targetLink },
        },
      });
      sent += res.successCount;
      failed += res.failureCount;
      res.responses.forEach((r, j) => {
        if (!r.success && isDeadToken(r.error?.code)) {
          deletions.push(chunk[j].ref.delete());
        }
      });
    }
    await Promise.allSettled(deletions);

    logger.info(
      `broadcastNotification: ${sent} sent / ${failed} failed across ${users.size} users`,
    );
    return { users: users.size, devices: docs.length, sent, failed };
  },
);
