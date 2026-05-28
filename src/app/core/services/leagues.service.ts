import { DestroyRef, Injectable, Signal, computed, effect, inject, signal } from '@angular/core';
import {
  Timestamp,
  collection,
  collectionGroup,
  doc,
  documentId,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { FIRESTORE, FUNCTIONS } from '../firebase/firebase.providers';
import {
  League,
  LeagueGlobalConfig,
  LeagueMember,
  LeaguePublic,
  MyLeagueMembership,
} from '../models/league.model';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class LeaguesService {
  private readonly db = inject(FIRESTORE);
  private readonly functions = inject(FUNCTIONS);
  private readonly auth = inject(AuthService);

  private readonly _myMemberships = signal<readonly MyLeagueMembership[]>([]);
  private readonly _myLeagues = signal<ReadonlyMap<string, League>>(new Map());
  private readonly _membershipsLoaded = signal(false);

  // League IDs whose first snapshot has settled (either populated `_myLeagues`
  // or fired an error). Used to wait for ALL leagues to be ready before
  // flipping `fullyLoaded`, so the UI doesn't render one league then trickle
  // the rest in afterward.
  private readonly _settledLeagues = signal<ReadonlySet<string>>(new Set());

  // Per-league snapshot listeners. Keyed by leagueId. Reused across re-renders.
  private readonly leagueListeners = new Map<string, () => void>();

  readonly myMemberships: Signal<readonly MyLeagueMembership[]> = this._myMemberships.asReadonly();
  readonly myLeagues: Signal<ReadonlyMap<string, League>> = this._myLeagues.asReadonly();
  readonly membershipsLoaded: Signal<boolean> = this._membershipsLoaded.asReadonly();

  /**
   * True once memberships AND every per-league listener have reported in. We
   * wait for ALL leagues to settle (success or error) before flipping this so
   * the UI doesn't render one league, pause, then flicker the rest in.
   */
  readonly fullyLoaded = computed<boolean>(() => {
    if (!this._membershipsLoaded()) return false;
    const memberships = this._myMemberships();
    if (memberships.length === 0) return true;
    const settled = this._settledLeagues();
    return memberships.every((m) => settled.has(m.leagueId));
  });

  readonly myLeagueList = computed<readonly { league: League; role: 'owner' | 'member' }[]>(() => {
    const memberships = this._myMemberships();
    const leagues = this._myLeagues();
    const list: { league: League; role: 'owner' | 'member' }[] = [];
    for (const m of memberships) {
      const l = leagues.get(m.leagueId);
      if (l) list.push({ league: l, role: m.role });
    }
    return list;
  });

  constructor() {
    const destroyRef = inject(DestroyRef);

    effect((onCleanup) => {
      const uid = this.auth.uid();
      if (!uid) {
        this.tearDownAllLeagueListeners();
        this._myMemberships.set([]);
        this._myLeagues.set(new Map());
        this._membershipsLoaded.set(false);
        return;
      }

      this._membershipsLoaded.set(false);
      const q = query(collectionGroup(this.db, 'members'), where('uid', '==', uid));
      const unsub = onSnapshot(
        q,
        (snap) => {
          const memberships: MyLeagueMembership[] = [];
          snap.forEach((d) => {
            const leagueId = d.ref.parent.parent?.id;
            if (!leagueId) return;
            const data = d.data();
            memberships.push({
              leagueId,
              role: (data['role'] as 'owner' | 'member') ?? 'member',
              joinedAt: data['joinedAt'] instanceof Timestamp ? data['joinedAt'].toDate() : null,
            });
          });
          this._myMemberships.set(memberships);
          this._membershipsLoaded.set(true);
          this.reconcileLeagueListeners(memberships.map((m) => m.leagueId));
        },
        (error) => {
          console.error('[LeaguesService] memberships query failed:', error);
          this.tearDownAllLeagueListeners();
          this._myMemberships.set([]);
          this._myLeagues.set(new Map());
          this._membershipsLoaded.set(true);
        },
      );

      onCleanup(() => {
        unsub();
        this.tearDownAllLeagueListeners();
      });
    });

    destroyRef.onDestroy(() => this.tearDownAllLeagueListeners());
  }

  // ---------------------------------------------------------------------------
  // Per-league listener reconciliation
  // ---------------------------------------------------------------------------
  //
  // When membership snapshot fires we don't want to re-read every league doc.
  // Instead: keep a listener per league. Add listeners for newly-joined leagues,
  // tear down listeners for leagues we've left. Existing leagues' data stays
  // cached and updates live (e.g. memberCount when others join).

  private reconcileLeagueListeners(currentIds: readonly string[]): void {
    const wanted = new Set(currentIds);

    // Tear down listeners for leagues we're no longer in.
    for (const [id, unsub] of this.leagueListeners) {
      if (!wanted.has(id)) {
        unsub();
        this.leagueListeners.delete(id);
        const map = new Map(this._myLeagues());
        map.delete(id);
        this._myLeagues.set(map);
        this.markUnsettled(id);
      }
    }

    // Set up listeners for newly-joined leagues.
    for (const id of currentIds) {
      if (this.leagueListeners.has(id)) continue;
      const unsub = onSnapshot(
        doc(this.db, 'leagues', id),
        (snap) => {
          const map = new Map(this._myLeagues());
          if (snap.exists()) {
            map.set(id, this.parseLeague(id, snap.data()));
          } else {
            map.delete(id);
          }
          this._myLeagues.set(map);
          this.markSettled(id);
        },
        (err) => {
          console.error(`[LeaguesService] league ${id} listener failed:`, err);
          // Settle even on error so `fullyLoaded` can progress instead of
          // hanging the skeleton forever waiting for a doc that won't load.
          this.markSettled(id);
        },
      );
      this.leagueListeners.set(id, unsub);
    }
  }

  private markSettled(id: string): void {
    this._settledLeagues.update((s) => {
      if (s.has(id)) return s;
      const next = new Set(s);
      next.add(id);
      return next;
    });
  }

  private markUnsettled(id: string): void {
    this._settledLeagues.update((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }

  private tearDownAllLeagueListeners(): void {
    for (const unsub of this.leagueListeners.values()) unsub();
    this.leagueListeners.clear();
    this._settledLeagues.set(new Set());
  }

  private parseLeague(id: string, data: Record<string, unknown>): League {
    const rawType = data['type'];
    const type =
      rawType === 'global' ? 'global' : rawType === 'public' ? 'public' : 'private';
    const globalConfig = type === 'global' ? parseGlobalConfig(data['globalConfig']) : null;
    return {
      id,
      name: (data['name'] as string) ?? '',
      type,
      globalConfig,
      // Legacy leagues from before multi-comp lack these fields entirely.
      // Default both to WC/2026 — the only thing every existing league is.
      // migrateToMultiComp persists explicit values so the fallback only
      // activates during the cutover gap.
      competitionId:
        typeof data['competitionId'] === 'string' ? data['competitionId'] : 'WC',
      season: typeof data['season'] === 'string' ? data['season'] : '2026',
      ownerId: (data['ownerId'] as string) ?? '',
      inviteCode: (data['inviteCode'] as string) ?? '',
      memberCount: (data['memberCount'] as number) ?? 0,
      createdAt: data['createdAt'] instanceof Timestamp ? data['createdAt'].toDate() : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Detail-view listeners
  // ---------------------------------------------------------------------------

  /** League members snapshot listener. Used by LeagueDetailComponent. */
  listenToMembers(
    leagueId: string,
    cb: (members: readonly LeagueMember[]) => void,
  ): () => void {
    const ref = collection(this.db, `leagues/${leagueId}/members`);
    return onSnapshot(ref, (snap) => {
      const members: LeagueMember[] = [];
      snap.forEach((d) => {
        const data = d.data();
        members.push({
          uid: d.id,
          role: (data['role'] as 'owner' | 'member') ?? 'member',
          joinedAt: data['joinedAt'] instanceof Timestamp ? data['joinedAt'].toDate() : null,
        });
      });
      cb(members);
    });
  }

  /** Lookup a single league by id from the cached set. */
  leagueById(leagueId: string): League | null {
    return this._myLeagues().get(leagueId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Public league lookup (for /j/CODE landing)
  // ---------------------------------------------------------------------------

  async getPublicLeague(inviteCode: string): Promise<LeaguePublic | null> {
    const ref = doc(this.db, 'leagues_public', inviteCode.toUpperCase());
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const data = snap.data();
    return {
      inviteCode: snap.id,
      leagueId: (data['leagueId'] as string) ?? '',
      name: (data['name'] as string) ?? '',
      memberCount: (data['memberCount'] as number) ?? 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Bulk user lookup for the league leaderboard
  // ---------------------------------------------------------------------------

  async getMemberUserDocs(uids: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    const result = new Map<string, Record<string, unknown>>();
    if (uids.length === 0) return result;
    // Firestore `in` queries support up to 30 ids per query.
    for (let i = 0; i < uids.length; i += 30) {
      const chunk = uids.slice(i, i + 30);
      const q = query(collection(this.db, 'users'), where(documentId(), 'in', chunk));
      const snap = await getDocs(q);
      snap.forEach((d) => result.set(d.id, d.data()));
    }
    return result;
  }

  /**
   * Fetches each member's per-(comp, season) totals shard. Used by the
   * league detail leaderboard to render points scoped to that league's
   * competition rather than the legacy global `users/{uid}.totals`
   * nested field (which only carries WC data during the dual-write
   * window and would show 0 for non-WC leagues).
   *
   * One round-trip per member doc — Firestore doesn't have a "batch
   * get by full path" primitive in the client SDK. For a 500-member
   * league that's 500 reads on each load; acceptable today and could
   * later be optimized via a denormalized leaderboard collection if
   * needed.
   */
  async getMemberTotals(
    uids: readonly string[],
    competitionId: string,
    season: string,
  ): Promise<Map<string, Record<string, unknown>>> {
    const result = new Map<string, Record<string, unknown>>();
    if (uids.length === 0) return result;
    const shardId = `${competitionId}_${season}`;
    const settled = await Promise.allSettled(
      uids.map(async (uid) => {
        const snap = await getDoc(doc(this.db, `users/${uid}/totals/${shardId}`));
        return { uid, data: snap.exists() ? snap.data() : null };
      }),
    );
    for (const entry of settled) {
      if (entry.status !== 'fulfilled') continue;
      const { uid, data } = entry.value;
      if (data) result.set(uid, data);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Callable wrappers
  // ---------------------------------------------------------------------------

  /**
   * Creates a private or public league tied to a specific (comp, season).
   * Both `competitionId` and `season` are immutable after creation — the
   * league's leaderboard, predicted standings, and fixture scope are all
   * derived from this pair. The callable server-side (see task #73)
   * validates that the comp exists in `competitions/` and rejects
   * unknown shortcodes.
   *
   * Defaults exist so callers that haven't been multi-comp-aware'd yet
   * (e.g. legacy create-league UI surfaces) still produce a working WC
   * league. Once task #74 lands the comp picker, callers always pass
   * an explicit competitionId.
   */
  async createLeague(
    name: string,
    type: 'private' | 'public' = 'private',
    competitionId: string = 'WC',
    season: string = '2026',
  ): Promise<{
    leagueId: string;
    inviteCode: string;
    type: 'private' | 'public';
  }> {
    const call = httpsCallable<
      {
        name: string;
        type: 'private' | 'public';
        competitionId: string;
        season: string;
      },
      { leagueId: string; inviteCode: string; type: 'private' | 'public' }
    >(this.functions, 'createLeague');
    const res = await call({ name, type, competitionId, season });
    return res.data;
  }

  async joinByCode(inviteCode: string): Promise<{ leagueId: string }> {
    const call = httpsCallable<{ inviteCode: string }, { leagueId: string }>(
      this.functions,
      'joinLeague',
    );
    const res = await call({ inviteCode });
    return res.data;
  }

  async joinPublicLeague(leagueId: string): Promise<{ leagueId: string }> {
    const call = httpsCallable<{ leagueId: string }, { leagueId: string }>(
      this.functions,
      'joinLeague',
    );
    const res = await call({ leagueId });
    return res.data;
  }

  /** Snapshot listener over every public league. Used by the leagues-browse
   *  section so users can discover and join without an invite code. */
  listenToPublicLeagues(cb: (leagues: readonly League[]) => void): () => void {
    const q = query(collection(this.db, 'leagues'), where('type', '==', 'public'));
    return onSnapshot(q, (snap) => {
      const list: League[] = [];
      snap.forEach((d) => list.push(this.parseLeague(d.id, d.data())));
      cb(list);
    });
  }

  async leaveLeague(leagueId: string): Promise<void> {
    const call = httpsCallable<{ leagueId: string }, { ok: boolean }>(
      this.functions,
      'leaveLeague',
    );
    await call({ leagueId });
  }

  async deleteLeague(leagueId: string): Promise<void> {
    const call = httpsCallable<{ leagueId: string }, { ok: boolean }>(
      this.functions,
      'deleteLeague',
    );
    await call({ leagueId });
  }

  async regenerateInviteCode(leagueId: string): Promise<{ inviteCode: string }> {
    const call = httpsCallable<{ leagueId: string }, { inviteCode: string }>(
      this.functions,
      'regenerateInviteCode',
    );
    const res = await call({ leagueId });
    return res.data;
  }

  async transferOwnership(leagueId: string, newOwnerUid: string): Promise<void> {
    const call = httpsCallable<{ leagueId: string; newOwnerUid: string }, { ok: boolean }>(
      this.functions,
      'transferOwnership',
    );
    await call({ leagueId, newOwnerUid });
  }

  async kickMember(leagueId: string, memberUid: string): Promise<void> {
    const call = httpsCallable<{ leagueId: string; memberUid: string }, { ok: boolean }>(
      this.functions,
      'kickMember',
    );
    await call({ leagueId, memberUid });
  }

  // ---------------------------------------------------------------------------
  // Admin-only callables for global leagues
  // ---------------------------------------------------------------------------

  async createGlobalLeague(args: {
    name: string;
    description: string;
    globalConfig: LeagueGlobalConfig;
  }): Promise<{ leagueId: string; enrolled: number }> {
    const call = httpsCallable<typeof args, { leagueId: string; enrolled: number }>(
      this.functions,
      'createGlobalLeague',
    );
    const res = await call(args);
    return res.data;
  }

  async syncGlobalLeague(leagueId: string): Promise<{ added: number; total: number }> {
    const call = httpsCallable<{ leagueId: string }, { added: number; total: number }>(
      this.functions,
      'syncGlobalLeague',
    );
    const res = await call({ leagueId });
    return res.data;
  }

  async deleteGlobalLeague(leagueId: string): Promise<void> {
    const call = httpsCallable<{ leagueId: string }, { ok: boolean }>(
      this.functions,
      'deleteGlobalLeague',
    );
    await call({ leagueId });
  }

  /** Snapshot listener over every global league. Used by the admin UI to
   *  show all globals, not just the ones the caller is a member of. */
  listenToGlobalLeagues(cb: (leagues: readonly League[]) => void): () => void {
    const q = query(collection(this.db, 'leagues'), where('type', '==', 'global'));
    return onSnapshot(q, (snap) => {
      const list: League[] = [];
      snap.forEach((d) => list.push(this.parseLeague(d.id, d.data())));
      cb(list);
    });
  }

  /**
   * Computes the caller's rank inside a single league. Fetches the league's
   * members + their `users/{uid}.totals.total` and sorts desc. One-shot,
   * not reactive — meant to be called on mount and refreshed on demand.
   * Tiebreakers are intentionally skipped here; this is the summary view's
   * approximation, not the full per-league leaderboard.
   */
  async getLeagueStanding(
    leagueId: string,
    uid: string,
  ): Promise<{ rank: number; total: number; points: number }> {
    const membersRef = collection(this.db, `leagues/${leagueId}/members`);
    const membersSnap = await getDocs(membersRef);
    const memberUids = membersSnap.docs.map((d) => d.id);
    if (memberUids.length === 0) {
      return { rank: 0, total: 0, points: 0 };
    }
    const userDocs = await this.getMemberUserDocs(memberUids);
    const scored = memberUids.map((memberUid) => {
      const data = userDocs.get(memberUid);
      const totals = (data?.['totals'] ?? {}) as Record<string, unknown>;
      const points = typeof totals['total'] === 'number' ? totals['total'] : 0;
      return { uid: memberUid, points };
    });
    scored.sort((a, b) => b.points - a.points);
    const idx = scored.findIndex((s) => s.uid === uid);
    if (idx < 0) {
      return { rank: 0, total: scored.length, points: 0 };
    }
    return { rank: idx + 1, total: scored.length, points: scored[idx].points };
  }
}

/** Defensive parse — global leagues from the server should always have a
 *  well-formed config, but bad data shouldn't crash the UI. Returns null
 *  if the shape doesn't validate. */
function parseGlobalConfig(raw: unknown): LeagueGlobalConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const autoEnroll = data['autoEnroll'];
  if (autoEnroll !== 'all' && autoEnroll !== 'filter') return null;
  const allowLeave = data['allowLeave'] === true;
  const config: LeagueGlobalConfig = autoEnroll === 'filter' && data['filter']
    ? {
        autoEnroll: 'filter',
        filter: parseFilter(data['filter']),
        allowLeave,
      }
    : { autoEnroll: 'all', allowLeave };
  return config;
}

function parseFilter(raw: unknown): { field: string; equals: string | number | boolean } {
  if (!raw || typeof raw !== 'object') return { field: '', equals: '' };
  const f = raw as Record<string, unknown>;
  const field = typeof f['field'] === 'string' ? f['field'] : '';
  const equals = f['equals'];
  const safe =
    typeof equals === 'string' || typeof equals === 'number' || typeof equals === 'boolean'
      ? equals
      : '';
  return { field, equals: safe };
}
