import { DestroyRef, Injectable, Signal, computed, inject, signal } from '@angular/core';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { FIRESTORE } from '../firebase/firebase.providers';
import { AuthService } from './auth.service';
import { EMPTY_TOTALS, parseTotals, UserTotals } from './user.service';

export interface LeaderboardEntry {
  readonly uid: string;
  readonly rank: number;
  readonly displayName: string;
  readonly photoURL: string | null;
  readonly totals: UserTotals;
}

const PAGE_SIZE = 100;

@Injectable({ providedIn: 'root' })
export class LeaderboardService {
  private readonly db = inject(FIRESTORE);
  private readonly auth = inject(AuthService);

  private readonly _entries = signal<readonly LeaderboardEntry[]>([]);
  private readonly _loaded = signal(false);

  readonly entries: Signal<readonly LeaderboardEntry[]> = this._entries.asReadonly();
  readonly loaded: Signal<boolean> = this._loaded.asReadonly();

  readonly myEntry = computed<LeaderboardEntry | null>(() => {
    const uid = this.auth.uid();
    if (!uid) return null;
    return this._entries().find((e) => e.uid === uid) ?? null;
  });

  constructor() {
    const q = query(
      collection(this.db, 'users'),
      orderBy('totals.total', 'desc'),
      limit(PAGE_SIZE),
    );
    const unsub = onSnapshot(q, (snap) => {
      const list: LeaderboardEntry[] = [];
      let rank = 1;
      snap.forEach((d) => {
        const data = d.data();
        const totals = parseTotals(data['totals']);
        list.push({
          uid: d.id,
          rank: rank++,
          displayName: data['displayName'] ?? 'Unknown',
          photoURL: data['photoURL'] ?? null,
          totals,
        });
      });
      this._entries.set(list);
      this._loaded.set(true);
    });
    inject(DestroyRef).onDestroy(() => unsub());
  }
}

export { EMPTY_TOTALS };
