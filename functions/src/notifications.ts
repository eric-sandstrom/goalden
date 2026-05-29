import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

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
      notification: { icon: '/icons/icon-192x192.png' },
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
