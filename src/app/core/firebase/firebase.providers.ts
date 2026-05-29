import { EnvironmentProviders, InjectionToken, makeEnvironmentProviders } from '@angular/core';
import { FirebaseApp, FirebaseOptions, initializeApp } from 'firebase/app';
import { Auth, connectAuthEmulator, getAuth } from 'firebase/auth';
import {
  Firestore,
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { Functions, connectFunctionsEmulator, getFunctions } from 'firebase/functions';

export const FIREBASE_APP = new InjectionToken<FirebaseApp>('FIREBASE_APP');
export const FIREBASE_AUTH = new InjectionToken<Auth>('FIREBASE_AUTH');
export const FIRESTORE = new InjectionToken<Firestore>('FIRESTORE');
export const FUNCTIONS = new InjectionToken<Functions>('FUNCTIONS');

interface FirebaseProvidersConfig {
  options: FirebaseOptions;
  useEmulators: boolean;
  functionsRegion: string;
}

export function provideFirebase(config: FirebaseProvidersConfig): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: FIREBASE_APP,
      useFactory: () => initializeApp(config.options),
    },
    {
      provide: FIREBASE_AUTH,
      useFactory: (app: FirebaseApp) => {
        const auth = getAuth(app);
        if (config.useEmulators) {
          connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
        }
        return auth;
      },
      deps: [FIREBASE_APP],
    },
    {
      provide: FIRESTORE,
      useFactory: (app: FirebaseApp) => {
        // Emulator keeps the in-memory cache: emulator reads aren't billed,
        // and a persistent IndexedDB cache survives emulator resets, which
        // shows stale dev data. Production uses an IndexedDB cache so
        // listeners hydrate locally across reloads and only fetch the docs
        // that actually changed — cutting billed reads sharply (e.g. the
        // predictions subcollection no longer re-reads ~N docs every load).
        const db = config.useEmulators
          ? getFirestore(app)
          : initializeFirestore(app, {
              localCache: persistentLocalCache({
                tabManager: persistentMultipleTabManager(),
              }),
            });
        if (config.useEmulators) {
          connectFirestoreEmulator(db, 'localhost', 8080);
        }
        return db;
      },
      deps: [FIREBASE_APP],
    },
    {
      provide: FUNCTIONS,
      useFactory: (app: FirebaseApp) => {
        const fns = getFunctions(app, config.functionsRegion);
        if (config.useEmulators) {
          connectFunctionsEmulator(fns, 'localhost', 5001);
        }
        return fns;
      },
      deps: [FIREBASE_APP],
    },
  ]);
}
