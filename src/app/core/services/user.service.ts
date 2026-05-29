import { Injectable, Signal, computed, effect, inject, signal } from '@angular/core';
import {
  Timestamp,
  collection,
  doc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
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

/** One per-(competition, season) totals shard at
 *  `users/{uid}/totals/{compId}_{season}`. */
export interface CompetitionTotals {
  readonly competitionId: string;
  readonly season: string;
  readonly totals: UserTotals;
}

export const EMPTY_TOTALS: UserTotals = {
  total: 0,
  match: 0,
  podium: 0,
  bracket: 0,
  exactScoreHits: 0,
  correctOutcomeHits: 0,
};

/**
 * Roles granted via `users/{uid}.roles`. Two-tier hierarchy:
 *
 *   - `'owner'` — top tier. Bootstrapped manually in the Firestore
 *     console (one-time). Owners can grant/revoke `'admin'` via the
 *     `grantAdminRole` / `revokeAdminRole` callables (surfaced in the
 *     dev-tools UI). Owner implies admin.
 *
 *   - `'admin'` — granted by an owner. Unlocks the dev-tools surface
 *     in production, the /admin section, and the global-leagues
 *     callables. Cannot mutate any role assignments.
 *
 * The Firestore security rules deny client writes to the `roles`
 * field, so escalation can only happen through owner-gated callables.
 */
export type UserRole = 'admin' | 'owner';

export interface UserDoc {
  readonly uid: string;
  readonly displayName: string;
  readonly photoURL: string | null;
  readonly createdAt: Date | null;
  readonly totals: UserTotals;
  readonly roles: readonly UserRole[];
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

  /** True when the current user has the 'admin' role OR the 'owner'
   *  role (owner implies admin). Used to gate the /admin section +
   *  admin-only UI affordances. The server enforces the same hierarchy
   *  via requireAdminOrEmulator, so this is purely a UX guard. */
  readonly isAdmin = computed(() => {
    const u = this._userDoc();
    if (!u) return false;
    return u.roles.includes('admin') || u.roles.includes('owner');
  });

  /** True when the current user has the 'owner' role. Owners can
   *  promote/demote other users to/from admin via the dev-tools UI. */
  readonly isOwner = computed(() => {
    const u = this._userDoc();
    return u !== null && u.roles.includes('owner');
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
      const unsub = onSnapshot(
        ref,
        (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            const created = data['createdAt'];
            this._userDoc.set({
              uid,
              displayName: data['displayName'] ?? '',
              photoURL: data['photoURL'] ?? null,
              createdAt: created instanceof Timestamp ? created.toDate() : null,
              totals: parseTotals(data['totals']),
              roles: parseRoles(data['roles']),
            });
          } else {
            this._userDoc.set(null);
          }
          this._loaded.set(true);
        },
        (err) => {
          // Auth-stale detection. The rule on users/{uid} says any
          // signed-in user can read; a permission-denied here while we
          // still hold a uid means the server doesn't recognize our
          // auth anymore (emulator restart wiped the user store, token
          // got revoked, etc.). Force a sign-out so the AuthService
          // redirect-on-null fires and the user lands on /login.
          if (err.code === 'permission-denied' || err.code === 'unauthenticated') {
            console.warn('[UserService] auth-stale signal — forcing sign-out');
            void this.auth.signOut();
          } else {
            console.error('[UserService] user-doc listener error:', err);
          }
          this._loaded.set(true);
        },
      );

      onCleanup(() => unsub());
    });
  }

  /**
   * One-shot load of every per-competition totals shard for a user, for the
   * lifetime-totals card. Lists `users/{uid}/totals` (the security rules
   * allow LIST so this single query covers all comps). Reads the stored
   * `competitionId` / `season` fields, falling back to parsing the doc id
   * (`${compId}_${season}`) for older shards that predate those fields.
   *
   * Pure read, no signals — designed to back an Angular `resource()`.
   */
  async loadTotalsShards(uid: string): Promise<readonly CompetitionTotals[]> {
    const snap = await getDocs(collection(this.db, 'users', uid, 'totals'));
    const out: CompetitionTotals[] = [];
    snap.forEach((d) => {
      const data = d.data();
      const sep = d.id.indexOf('_');
      const competitionId =
        typeof data['competitionId'] === 'string'
          ? data['competitionId']
          : sep > 0
            ? d.id.slice(0, sep)
            : d.id;
      const season =
        typeof data['season'] === 'string'
          ? data['season']
          : sep > 0
            ? d.id.slice(sep + 1)
            : '';
      out.push({ competitionId, season, totals: parseTotals(data) });
    });
    return out;
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

/** Defensive parse of `users/{uid}.roles`. Validates each entry against
 *  the known UserRole union; unknown strings are dropped silently. */
export function parseRoles(raw: unknown): readonly UserRole[] {
  if (!Array.isArray(raw)) return [];
  const valid: UserRole[] = [];
  for (const entry of raw) {
    if (entry === 'admin' || entry === 'owner') valid.push(entry);
  }
  return valid;
}
