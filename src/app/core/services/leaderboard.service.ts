import { DestroyRef, Injectable, Signal, computed, inject, signal } from '@angular/core';
import { DocumentData, doc, onSnapshot } from 'firebase/firestore';
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
    // Read the server-maintained rollup at `cache/leaderboard` — ONE doc —
    // rather than listening to the top-100 `users` directly. Cold load goes
    // from ~100 reads to 1, and each scoring burst from ~100 reads/client to
    // 1. The doc is kept current by the `rebuildLeaderboard` Cloud Function.
    const ref = doc(this.db, 'cache', 'leaderboard');
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const data = snap.exists() ? snap.data() : null;
        this._entries.set(parseEntries(data));
        this._loaded.set(true);
      },
      (err) => {
        console.error('[LeaderboardService] rollup listener failed:', err);
        this._loaded.set(true);
      },
    );
    inject(DestroyRef).onDestroy(() => unsub());
  }
}

/** Normalises the rollup doc's `entries` array into typed LeaderboardEntry[].
 *  Defensive — an absent doc (before the first rebuild) or malformed entry
 *  yields an empty/clean list rather than throwing. Falls back to array
 *  order for `rank` if the stored value is missing. */
function parseEntries(data: DocumentData | null): LeaderboardEntry[] {
  const raw = data && Array.isArray(data['entries']) ? data['entries'] : [];
  return raw.map((e: DocumentData, i: number) => ({
    uid: typeof e['uid'] === 'string' ? e['uid'] : '',
    rank: typeof e['rank'] === 'number' ? e['rank'] : i + 1,
    displayName: typeof e['displayName'] === 'string' ? e['displayName'] : 'Unknown',
    photoURL: typeof e['photoURL'] === 'string' ? e['photoURL'] : null,
    totals: parseTotals(e['totals']),
  }));
}

export { EMPTY_TOTALS };
