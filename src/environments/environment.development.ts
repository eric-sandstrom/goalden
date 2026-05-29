import type { FirebaseOptions } from 'firebase/app';

export const environment = {
  production: false,
  useEmulators: true,
  functionsRegion: 'europe-west1',
  // Web Push (FCM) public VAPID key — see environment.ts. Empty in dev: the
  // service worker is disabled under `ng serve` anyway, so push can't run
  // locally. Local/OS notifications (e.g. app-update alerts) still work.
  vapidKey: 'BFt_87PImCIXAOVW_cywPC6AKeec1I8b13s6EJdFAtcza2tc1M8RfI173fz5qBPOzIUXq4QHbCpi1JMciWLwCjw',
  firebase: {
    apiKey: 'AIzaSyD9egJ0Stg8wLagcDQw7YU-OU33cHMhc2Y',
    authDomain: 'goalden-693dc.firebaseapp.com',
    projectId: 'goalden-693dc',
    storageBucket: 'goalden-693dc.firebasestorage.app',
    messagingSenderId: '766356664978',
    appId: '1:766356664978:web:6fb1cb9346cbde7fd96c4b',
    measurementId: 'G-ZTQZQ18874',
  } satisfies FirebaseOptions,
};
