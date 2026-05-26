import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
  GoogleAuthProvider,
  User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
} from 'firebase/auth';
import { FIREBASE_AUTH } from '../firebase/firebase.providers';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly auth = inject(FIREBASE_AUTH);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _user = signal<User | null>(null);
  private readonly _initialized = signal(false);

  readonly user = this._user.asReadonly();
  readonly initialized = this._initialized.asReadonly();

  readonly isAuthenticated = computed(() => this._user() !== null);
  readonly uid = computed(() => this._user()?.uid ?? null);

  constructor() {
    const unsub = onAuthStateChanged(this.auth, (u) => {
      this._user.set(u);
      this._initialized.set(true);
    });
    this.destroyRef.onDestroy(() => unsub());
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
}
