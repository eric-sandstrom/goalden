import { Injectable, Signal, computed, effect, inject, signal } from '@angular/core';
import {
  DocumentData,
  collection,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore';
import { FIRESTORE } from '../firebase/firebase.providers';
import {
  Competition,
  CompetitionArea,
  CompetitionSeason,
  CompetitionType,
} from '../models/competition.model';
import { AuthService } from './auth.service';

/**
 * Read-side gateway to the `competitions/` catalogue. Populated by the
 * `syncCompetitionsFromApi` admin callable; surfaced everywhere the UI
 * needs to render or pick a competition (create-league dialog, Predict
 * tab competition tabs, league detail header, dedicated standings
 * route).
 *
 * Storage strategy:
 *   1. Hydrate from localStorage on construct so the first paint of
 *      every signed-in route already has comp data (the catalogue
 *      changes rarely — caching once means we never block UI on it).
 *   2. Subscribe to a live `onSnapshot` once auth resolves so admin
 *      toggles (Activate / Deactivate, hasGlobalLeague) propagate
 *      to every user client within seconds — critical because the
 *      Predict tab visibility depends on `active`.
 *
 * The collection is small (~13 docs * ~500 bytes), so a real-time
 * listener costs roughly nothing in either reads or memory. No
 * fallback path needed.
 */
const CACHE_KEY = 'goalden:competitions-cache';
/**
 * 7-day TTL on the cached envelope. The cache only serves first
 * paint — the live listener replaces it within a second of bootstrap,
 * so the TTL just protects against indefinitely-stale data when a
 * user opens the app offline (or before the listener fires). A week
 * is generous; data goes stale faster than that when admins toggle,
 * but the active listener is the source of truth then.
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cached representation — Competition is already JSON-safe (no
 *  Timestamps; startDate/endDate live as ISO strings), so the cache
 *  shape is the Competition shape verbatim. */
interface CacheEnvelope {
  competitions: Competition[];
  cachedAt: number;
}

@Injectable({ providedIn: 'root' })
export class CompetitionsService {
  private readonly db = inject(FIRESTORE);
  private readonly auth = inject(AuthService);

  private readonly _competitions = signal<readonly Competition[]>([]);
  private readonly _loaded = signal(false);

  readonly competitions: Signal<readonly Competition[]> = this._competitions.asReadonly();
  readonly loaded: Signal<boolean> = this._loaded.asReadonly();

  /** Subset that's currently being polled by pollFootballData. Drives
   *  which comps appear in the Predict tab + the create-league picker. */
  readonly activeCompetitions = computed(() =>
    this._competitions().filter((c) => c.active),
  );

  /** O(1) lookup by shortcode (e.g. 'WC', 'PL'). Used everywhere a
   *  comp id needs to be resolved to its display data — fixture
   *  cards, league detail header, lifetime-totals breakdown. */
  readonly competitionsById = computed<ReadonlyMap<string, Competition>>(() => {
    const m = new Map<string, Competition>();
    for (const c of this._competitions()) m.set(c.id, c);
    return m;
  });

  /** Active competitions partitioned by football-data type — used by
   *  the create-league picker to render the Tournaments / Domestic
   *  Leagues optgroups. CUP covers WC, Euros, CL, EL etc.; LEAGUE
   *  covers EPL, La Liga, etc. Hybrid formats (Championship-style)
   *  collapse into LEAGUE since they share the round-robin spine. */
  readonly activeByType = computed<{
    readonly leagues: readonly Competition[];
    readonly cups: readonly Competition[];
  }>(() => {
    const leagues: Competition[] = [];
    const cups: Competition[] = [];
    for (const c of this.activeCompetitions()) {
      (c.type === 'CUP' ? cups : leagues).push(c);
    }
    return { leagues, cups };
  });

  constructor() {
    // 1. Cache hydration. Lets first paint of any signed-in surface
    //    already have comp data, even before Firestore round-trips.
    this.hydrateFromCache();

    // 2. Live listener. Cheap (small collection), and surfaces admin
    //    activation toggles to every client in real time so users see
    //    new competitions appear without refreshing.
    effect((onCleanup) => {
      const uid = this.auth.uid();
      if (!uid) return;

      const unsub = onSnapshot(
        query(collection(this.db, 'competitions'), orderBy('name')),
        (snap) => {
          const list: Competition[] = [];
          snap.forEach((d) => list.push(parseCompetition(d.id, d.data())));
          this._competitions.set(list);
          this._loaded.set(true);
          this.writeCache(list);
        },
        (err) => {
          console.error('[CompetitionsService] listener failed', err);
        },
      );
      onCleanup(() => unsub());
    });
  }

  /** Convenience accessor that mirrors competitionsById().get(...) for
   *  callers that don't want to read the signal directly. */
  byId(id: string): Competition | null {
    return this.competitionsById().get(id) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Cache I/O
  // ---------------------------------------------------------------------------

  private hydrateFromCache(): void {
    const cached = this.readCache();
    if (!cached) return;
    this._competitions.set(cached.competitions);
    this._loaded.set(true);
  }

  private readCache(): CacheEnvelope | null {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    try {
      const env = JSON.parse(raw) as CacheEnvelope;
      if (!Array.isArray(env.competitions) || typeof env.cachedAt !== 'number') {
        return null;
      }
      if (Date.now() - env.cachedAt > CACHE_TTL_MS) return null;
      return env;
    } catch {
      return null;
    }
  }

  private writeCache(competitions: readonly Competition[]): void {
    if (typeof localStorage === 'undefined') return;
    if (competitions.length === 0) return; // don't poison the cache
    try {
      const envelope: CacheEnvelope = {
        competitions: competitions.slice(),
        cachedAt: Date.now(),
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(envelope));
    } catch {
      // Quota exceeded — fine, listener still keeps memory state fresh.
    }
  }
}

// =============================================================================
// Firestore document parsing
// =============================================================================

/**
 * Adapts a raw Firestore doc into the typed Competition shape. Tolerant
 * of missing/legacy fields so a partially-written or transient doc
 * never throws inside the listener — the affected entry just falls
 * back to safe defaults until the next sync rewrites it.
 *
 * Exported so the dev-tools competitions card can share the same parse
 * logic; CompetitionsService doesn't suit there because dev-tools needs
 * to render BEFORE admin has signed in as a regular user (the auth
 * effect inside the service waits on uid).
 */
export function parseCompetition(id: string, data: DocumentData): Competition {
  const area = (data['area'] ?? {}) as Record<string, unknown>;
  const season = data['currentSeason'] as Record<string, unknown> | null | undefined;
  const parsedArea: CompetitionArea = {
    id: typeof area['id'] === 'number' ? area['id'] : 0,
    name: typeof area['name'] === 'string' ? area['name'] : '',
    code: typeof area['code'] === 'string' ? area['code'] : null,
    flag: typeof area['flag'] === 'string' ? area['flag'] : null,
  };
  const parsedSeason: CompetitionSeason | null = season
    ? {
        id: typeof season['id'] === 'number' ? season['id'] : 0,
        startDate: typeof season['startDate'] === 'string' ? season['startDate'] : '',
        endDate: typeof season['endDate'] === 'string' ? season['endDate'] : '',
        currentMatchday:
          typeof season['currentMatchday'] === 'number'
            ? season['currentMatchday']
            : null,
      }
    : null;
  return {
    id,
    fdId: typeof data['fdId'] === 'number' ? data['fdId'] : 0,
    name: typeof data['name'] === 'string' ? data['name'] : id,
    emblem: typeof data['emblem'] === 'string' ? data['emblem'] : null,
    type: (data['type'] === 'CUP' ? 'CUP' : 'LEAGUE') satisfies CompetitionType,
    plan: typeof data['plan'] === 'string' ? data['plan'] : null,
    area: parsedArea,
    currentSeason: parsedSeason,
    active: data['active'] === true,
    hasGlobalLeague: data['hasGlobalLeague'] === true,
  };
}
