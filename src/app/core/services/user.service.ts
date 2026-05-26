import { Injectable, Signal, computed, effect, inject, signal } from '@angular/core';
import { Timestamp, doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { FIRESTORE } from '../firebase/firebase.providers';
import { AuthService } from './auth.service';

export interface UserTotals {
  readonly total: number;
  readonly match: number;
  readonly podium: number;
  readonly bracket: number;
  readonly exactScoreHits: number;
  readonly correctOutcomeHits: number;
}

export const EMPTY_TOTALS: UserTotals = {
  total: 0,
  match: 0,
  podium: 0,
  bracket: 0,
  exactScoreHits: 0,
  correctOutcomeHits: 0,
};

export interface UserDoc {
  readonly uid: string;
  readonly displayName: string;
  readonly photoURL: string | null;
  readonly createdAt: Date | null;
  readonly totals: UserTotals;
}

@Injectable({ providedIn: 'root' })
export class UserService {
  private readonly db = inject(FIRESTORE);
  private readonly auth = inject(AuthService);

  private readonly _userDoc = signal<UserDoc | null>(null);
  private readonly _loaded = signal(false);

  readonly userDoc: Signal<UserDoc | null> = this._userDoc.asReadonly();
  readonly loaded: Signal<boolean> = this._loaded.asReadonly();
  readonly totals: Signal<UserTotals> = computed(() => this._userDoc()?.totals ?? EMPTY_TOTALS);

  readonly hasDisplayName = computed(() => {
    const u = this._userDoc();
    return u !== null && u.displayName.trim().length > 0;
  });

  constructor() {
    effect((onCleanup) => {
      const uid = this.auth.uid();
      if (!uid) {
        this._userDoc.set(null);
        this._loaded.set(false);
        return;
      }

      this._loaded.set(false);
      const ref = doc(this.db, 'users', uid);
      const unsub = onSnapshot(ref, (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          const created = data['createdAt'];
          this._userDoc.set({
            uid,
            displayName: data['displayName'] ?? '',
            photoURL: data['photoURL'] ?? null,
            createdAt: created instanceof Timestamp ? created.toDate() : null,
            totals: parseTotals(data['totals']),
          });
        } else {
          this._userDoc.set(null);
        }
        this._loaded.set(true);
      });

      onCleanup(() => unsub());
    });
  }

  async setDisplayName(name: string): Promise<void> {
    const uid = this.auth.uid();
    if (!uid) throw new Error('Not authenticated');

    const ref = doc(this.db, 'users', uid);
    const trimmed = name.trim();

    if (this._userDoc()) {
      await updateDoc(ref, { displayName: trimmed });
    } else {
      await setDoc(ref, {
        displayName: trimmed,
        photoURL: this.auth.user()?.photoURL ?? null,
        createdAt: serverTimestamp(),
      });
    }
  }
}

export function parseTotals(t: unknown): UserTotals {
  if (!t || typeof t !== 'object') return EMPTY_TOTALS;
  const d = t as Record<string, unknown>;
  return {
    total: typeof d['total'] === 'number' ? d['total'] : 0,
    match: typeof d['match'] === 'number' ? d['match'] : 0,
    podium: typeof d['podium'] === 'number' ? d['podium'] : 0,
    bracket: typeof d['bracket'] === 'number' ? d['bracket'] : 0,
    exactScoreHits: typeof d['exactScoreHits'] === 'number' ? d['exactScoreHits'] : 0,
    correctOutcomeHits:
      typeof d['correctOutcomeHits'] === 'number' ? d['correctOutcomeHits'] : 0,
  };
}
