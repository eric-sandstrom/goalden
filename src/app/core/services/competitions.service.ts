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

  /** Subset that's currently being polled by pollFootballData. Used
   *  internally and by admin surfaces; user-facing pickers use the
   *  season-aware `selectableCompetitions` below instead. */
  readonly activeCompetitions = computed(() =>
    this._competitions().filter((c) => c.active),
  );

  /**
   * Subset surfaced to users in pickers (create-league, Predict tabs).
   * A comp is "selectable" when its `currentSeason.endDate` is in the
   * future — that auto-includes upcoming comps (WC before kickoff) and
   * auto-excludes comps whose season just ended (EPL 2025–26 the
   * moment football-data hasn't yet flipped currentSeason to 2026–27).
   *
   * Comps with no currentSeason at all are kept in the list — those
   * are typically freshly-synced entries where football-data hasn't
   * surfaced season metadata yet; hiding them would create a chicken-
   * and-egg problem.
   *
   * The `active` flag is NOT consulted here. Admins can activate a
   * comp early (to seed fixtures) without making it disappear post-
   * season, and a comp can be selectable before polling starts so
   * users can pre-create leagues for upcoming tournaments.
   */
  readonly selectableCompetitions = computed(() =>
    this._competitions().filter(isSelectable),
  );

  /** O(1) lookup by shortcode (e.g. 'WC', 'PL'). Used everywhere a
   *  comp id needs to be resolved to its display data — fixture
   *  cards, league detail header, lifetime-totals breakdown. */
  readonly competitionsById = computed<ReadonlyMap<string, Competition>>(() => {
    const m = new Map<string, Competition>();
    for (const c of this._competitions()) m.set(c.id, c);
    return m;
  });

  /** Active competitions partitioned by football-data type. Kept for
   *  admin surfaces that want to see polling state at a glance. */
  readonly activeByType = computed<{
    readonly leagues: readonly Competition[];
    readonly cups: readonly Competition[];
  }>(() => partitionByType(this.activeCompetitions()));

  /** Selectable competitions partitioned by football-data type — the
   *  source for the create-league picker's Tournaments / Domestic
   *  Leagues optgroups. Uses the same season-aware filter as
   *  `selectableCompetitions`. */
  readonly selectableByType = computed<{
    readonly leagues: readonly Competition[];
    readonly cups: readonly Competition[];
  }>(() => partitionByType(this.selectableCompetitions()));

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
 * True when the competition's `currentSeason.endDate` is in the future
 * (the season is upcoming or in progress), OR no season metadata is
 * known yet. Used to gate which comps users can create leagues for —
 * past seasons are out of scope, but freshly-synced comps stay
 * available until football-data populates their season info.
 */
function isSelectable(c: Competition): boolean {
  if (!c.currentSeason) return true;
  const endDate = c.currentSeason.endDate;
  if (!endDate) return true;
  // YYYY-MM-DD parsed by Date → midnight UTC. That's accurate enough
  // for "has this season wrapped up". Tournaments end on a specific
  // calendar day; whatever timezone the user is in, we want the
  // comp to disappear roughly when the trophy is lifted.
  const end = new Date(endDate).getTime();
  if (Number.isNaN(end)) return true; // unparseable string → don't filter out
  return end > Date.now();
}

/** Splits a competition list into the CUP / LEAGUE buckets the picker
 *  uses for its optgroups. Hybrid formats collapse into LEAGUE since
 *  they share the round-robin spine. */
function partitionByType(comps: readonly Competition[]): {
  readonly leagues: readonly Competition[];
  readonly cups: readonly Competition[];
} {
  const leagues: Competition[] = [];
  const cups: Competition[] = [];
  for (const c of comps) {
    (c.type === 'CUP' ? cups : leagues).push(c);
  }
  return { leagues, cups };
}

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
