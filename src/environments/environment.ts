import type { FirebaseOptions } from 'firebase/app';

export const environment = {
  production: true,
  useEmulators: false,
  functionsRegion: 'europe-west1',
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
