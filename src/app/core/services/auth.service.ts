import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  GoogleAuthProvider,
  User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { FIREBASE_AUTH, FUNCTIONS } from '../firebase/firebase.providers';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly auth = inject(FIREBASE_AUTH);
  private readonly functions = inject(FUNCTIONS);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _user = signal<User | null>(null);
  private readonly _initialized = signal(false);

  readonly user = this._user.asReadonly();
  readonly initialized = this._initialized.asReadonly();

  readonly isAuthenticated = computed(() => this._user() !== null);
  readonly uid = computed(() => this._user()?.uid ?? null);

  constructor() {
    const unsub = onAuthStateChanged(this.auth, (u) => {
      // Capture the previous state BEFORE we update the signal so we
      // can detect a signed-in → signed-out transition. We don't want
      // to redirect on the initial `null → null` callback at startup
      // when there's never been an authenticated session.
      const wasAuthenticated = this._user() !== null;
      this._user.set(u);
      this._initialized.set(true);

      // Force-navigate to /login on any signed-in → signed-out
      // transition. Covers three cases at once:
      //   1. Explicit signOut() — user clicked the button.
      //   2. Token expiry — Firebase Auth detected an invalid token.
      //   3. Server-side invalidation — emulator restart wiped the
      //      user store, our token got rejected, SDK auto-cleared.
      // Without this, the UI sits with a stale "logged in" shell and
      // every Firestore listener errors with permission-denied until
      // the user manually refreshes.
      if (wasAuthenticated && u === null) {
        void this.router.navigate(['/login']);
      }
    });
    this.destroyRef.onDestroy(() => unsub());

    // Auth re-validation against the server.
    //
    // The cached JWT stays cryptographically valid even when the
    // backing user is gone (emulator wiped, account deleted in prod).
    // The only way to know is to ASK the server. We do that on two
    // signals:
    //   (1) When the tab regains focus — covers the dev case of
    //       restarting the emulator in another window.
    //   (2) Every 30 seconds while the tab is visible — covers the
    //       case where focus never moves (split-screen, hotkey restart).
    //
    // `currentUser.reload()` is the right call (NOT `getIdToken(true)`
    // — that only refreshes the token via the refresh endpoint, which
    // can succeed against a stale user). `reload()` hits accounts:lookup
    // which is exactly what a page refresh does — and is exactly what
    // returns 400 when the user no longer exists on the server.

    if (typeof document !== 'undefined') {
      const handler = () => void this.revalidateAuth('visibility');
      document.addEventListener('visibilitychange', handler);
      this.destroyRef.onDestroy(() =>
        document.removeEventListener('visibilitychange', handler),
      );
    }
    if (typeof window !== 'undefined') {
      const handler = () => void this.revalidateAuth('focus');
      window.addEventListener('focus', handler);
      this.destroyRef.onDestroy(() => window.removeEventListener('focus', handler));

      // Polling safety net for split-screen / hotkey workflows where
      // focus never moves. 30s feels right: long enough to be cheap,
      // short enough to feel responsive after an emulator restart.
      const intervalId = setInterval(() => void this.revalidateAuth('poll'), 30_000);
      this.destroyRef.onDestroy(() => clearInterval(intervalId));
    }
  }

  /** Active server-side auth check via accounts:lookup. Failures force
   *  a local sign-out. Called on tab focus, visibility change, and a
   *  30s timer; gated on the user being signed-in and the tab visible. */
  private async revalidateAuth(source: 'visibility' | 'focus' | 'poll'): Promise<void> {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return;
    }
    const user = this.auth.currentUser;
    if (!user) return;
    try {
      await user.reload();
    } catch (e: unknown) {
      console.warn(`[AuthService] auth revalidation (${source}) failed — signing out`, e);
      try {
        await fbSignOut(this.auth);
      } catch {
        void this.router.navigate(['/login']);
      }
    }
  }

  async signInWithGoogle(): Promise<void> {
    await signInWithPopup(this.auth, new GoogleAuthProvider());
  }

  async signInWithEmail(email: string, password: string): Promise<void> {
    await signInWithEmailAndPassword(this.auth, email, password);
  }

  async signUpWithEmail(email: string, password: string): Promise<void> {
    await createUserWithEmailAndPassword(this.auth, email, password);
  }

  async signOut(): Promise<void> {
    await fbSignOut(this.auth);
  }

  /**
   * Dev-only one-click sign-in as a permanent admin user.
   *
   * Calls the `devSignInAsAdmin` Cloud Function which mints a Firebase
   * custom auth token bound to a fixed `dev-admin` uid. We then sign
   * in with that token — no email/password typing required. The
   * function refuses to run outside the emulator, so attempts to call
   * this in production fail with `failed-precondition`.
   *
   * The login page only exposes this when `environment.useEmulators`
   * is true; the AuthService method is otherwise unguarded so it can
   * also be invoked from dev tools or tests.
   */
  async signInAsDevAdmin(): Promise<void> {
    const callable = httpsCallable<unknown, { token: string }>(
      this.functions,
      'devSignInAsAdmin',
    );
    const res = await callable({});
    await signInWithCustomToken(this.auth, res.data.token);
  }
}
