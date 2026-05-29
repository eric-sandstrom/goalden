/* Firebase Cloud Messaging service worker — handles PUSH while the app is in
 * the background or fully closed.
 *
 * Coexists with the Angular service worker (ngsw-worker.js, scope '/'): this
 * one is registered by NotificationsService at the scope
 * '/firebase-cloud-messaging-push-scope', so the two never clash.
 *
 * Uses the compat SDK via importScripts (the modular SDK can't run in a classic
 * worker). Version is pinned to the app's installed firebase major.
 */
importScripts('https://www.gstatic.com/firebasejs/12.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.13.0/firebase-messaging-compat.js');

// Public config — same values as src/environments (safe to ship client-side).
firebase.initializeApp({
  apiKey: 'AIzaSyD9egJ0Stg8wLagcDQw7YU-OU33cHMhc2Y',
  authDomain: 'goalden-693dc.firebaseapp.com',
  projectId: 'goalden-693dc',
  storageBucket: 'goalden-693dc.firebasestorage.app',
  messagingSenderId: '766356664978',
  appId: '1:766356664978:web:6fb1cb9346cbde7fd96c4b',
});

const messaging = firebase.messaging();

// Messages that carry a `notification` block are shown automatically by the
// SDK. This handler covers data-only messages so they still surface.
messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  self.registration.showNotification(n.title || 'Goalden', {
    body: n.body || '',
    icon: 'icons/icon-192x192.png',
    // Monochrome silhouette for the Android status bar (alpha-masked to white).
    badge: 'icons/badge-96x96.png',
    data: payload.data || {},
  });
});

// Focus (or open) the app when a notification is tapped.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.link) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
