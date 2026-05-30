# Push notifications in local dev

Push **works against the local emulator**, with one caveat: there is no FCM
emulator, so the *send* step uses **real** Firebase Cloud Messaging. Everything
else (token registration, storage, the callable) runs locally.

```
browser (localhost)                    functions emulator (:5001)        real FCM
  getToken(vapidKey) ──hits real FCM──▶ real token
  store at users/{uid}/devices/{id} ──▶ Firestore emulator (:8080)
                                         sendTestNotification / broadcast
                                         getMessaging().send* ─────────────▶ delivers to the browser
                                         (needs Google credentials) ───────┘
```

Why it works: `getToken()` and `getMessaging()` have **no emulator** — they
always talk to production FCM. The dev VAPID key is the real one, and
`firebase-messaging-sw.js` (in `public/`) is served by `ng serve` on
`localhost` (a secure context for service workers). So a real, valid FCM token
is minted and stored in the Firestore emulator.

The only missing piece is that the **functions emulator's Admin SDK needs
Google credentials** to call FCM (the no-arg `initializeApp()` has none).

## One-time setup

Pick either option, then **restart the emulator** so it inherits the credential.

### Option A — service account key (no extra tooling)

1. Firebase console → `goalden-693dc` → Project settings → **Service accounts**
   → **Generate new private key**. Save it in the repo root as
   `service-account.json` (already git-ignored).
2. Start the emulator with the env var set (PowerShell):
   ```powershell
   $env:GOOGLE_APPLICATION_CREDENTIALS = "$PWD\service-account.json"
   npm run emulators
   ```

### Option B — gcloud Application Default Credentials

```bash
gcloud auth application-default login   # sign in with an account on the project
npm run emulators                       # emulator picks up ADC automatically
```

## Try it

1. `npm run emulators` (with a credential from above) and `npm start`.
2. Sign in, open **Profile → Notifications → Enable**, and **grant** the browser
   permission prompt. This stores a token under `users/{uid}/devices/{id}`.
3. **Send test** (Profile) or **Profile → Admin → Broadcast notification**. The
   notification is delivered by real FCM to this browser — even with the app in
   the background.

Without a credential the callables fail at the `getMessaging().send*` step
(auth error); the rest of the flow still works, and the token is still stored.
