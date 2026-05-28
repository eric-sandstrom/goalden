import { Injectable, Signal, computed, effect, inject, signal } from '@angular/core';
import {
  DocumentData,
  QuerySnapshot,
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { FIRESTORE } from '../firebase/firebase.providers';
import { Fixture, FixtureStage, FixtureStatus } from '../models/fixture.model';
import { KnownTeam, asKnownTeam } from '../models/podium.model';
import { AuthService } from './auth.service';

/**
 * Per-(competition, season) fixture store.
 *
 * Consumers ask for a specific comp via `fixturesFor(compId, season)`,
 * which returns a memoized signal scoped to that comp. The first such
 * call kicks off a load (cache hydration then network fetch); repeat
 * calls return the same signal so binding into a template is stable.
 *
 * Cross-comp conveniences (`fixturesById`, `teams`, `nextFixture`,
 * etc.) compute over every comp that's currently in memory. So a
 * surface like Home's "next match across all my comps" works simply
 * by calling `fixturesFor()` on each comp the user is in to load
 * them, then reading the cross-comp derived signal.
 *
 * Live overlay: a single `onSnapshot` watches every fixture with
 * status IN_PLAY or PAUSED across the entire collection (typically
 * 0–5 docs at any time). Updates are routed to the appropriate
 * per-comp signal by the doc's `competitionId` / `season` fields,
 * so live scores propagate without any per-comp listener overhead.
 */

interface CacheEnvelope {
  fixtures: CachedFixture[];
  cachedAt: number;
}

/** Cached representation. utcKickoff serialises as ISO string for JSON. */
interface CachedFixture {
  id: string;
  competitionId: string;
  season: string;
  homeTeam: Fixture['homeTeam'];
  awayTeam: Fixture['awayTeam'];
  utcKickoff: string;
  status: FixtureStatus;
  stage: FixtureStage;
  group: string | null;
  score: Fixture['score'];
}

/** 5-minute cache freshness window — short enough that kickoff time
 *  edits propagate fast on warm caches, long enough to span typical
 *  navigation within a session. Live overlay handles in-progress
 *  score updates so the TTL doesn't need to chase those. */
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKeyFor(compId: string, season: string): string {
  return `goalden:fixtures-${compId}-${season}`;
}

function mapKeyFor(compId: string, season: string): string {
  return `${compId}_${season}`;
}

@Injectable({ providedIn: 'root' })
export class FixturesService {
  private readonly db = inject(FIRESTORE);
  private readonly auth = inject(AuthService);

  /**
   * Authoritative state. Keyed by `${compId}_${season}` — a single
   * source of truth for both the per-comp signals and the cross-comp
   * derivations. Updates go through `_all.update(m => new Map(m)…)`
   * so consumers re-render on any per-comp change.
   */
  private readonly _all = signal<ReadonlyMap<string, readonly Fixture[]>>(new Map());

  /**
   * Tracks load status per (comp, season). 'loaded' means the signal
   * has the latest network-fetched data; 'cached' means we have
   * something from localStorage but a fresh fetch is still in flight
   * (the UI can render but treat as stale).
   */
  private readonly _status = signal<ReadonlyMap<string, 'loading' | 'cached' | 'loaded'>>(
    new Map(),
  );

  /**
   * The set of (comp, season) keys some consumer has asked for. Auth-
   * gated effect uses this to drive network fetches: when uid changes
   * or a new key is requested, the effect re-runs and fetches anything
   * that isn't 'loaded' yet. This means lazy requests still trigger a
   * fetch the moment auth is available.
   */
  private readonly _requested = signal<ReadonlySet<string>>(new Set());

  /** Memoized per-(comp, season) signals. The map outlives auth state so
   *  templates binding to the same signal don't get torn down on sign-
   *  out/sign-in cycles. */
  private readonly _fixturesSignals = new Map<string, Signal<readonly Fixture[]>>();
  private readonly _loadedSignals = new Map<string, Signal<boolean>>();

  /** Tracks fetches currently in flight so the auth effect doesn't kick
   *  off duplicate requests when it re-runs (e.g. a new comp gets
   *  requested while another is still loading). Internal mutation —
   *  not a signal because nothing should react to "in flight"; the
   *  data itself drives the UI via `_all` / `_status`. */
  private readonly _inFlight = new Set<string>();

  // ---------------------------------------------------------------------------
  // Cross-comp derived signals
  // ---------------------------------------------------------------------------

  /** ID → Fixture across every loaded comp. Used for one-off lookups
   *  (FixtureRow finding a fixture by id, dev-tools resolving a target). */
  readonly fixturesById = computed<ReadonlyMap<string, Fixture>>(() => {
    const m = new Map<string, Fixture>();
    for (const list of this._all().values()) {
      for (const f of list) m.set(f.id, f);
    }
    return m;
  });

  /** Distinct teams across every loaded comp, sorted by name. Driven
   *  cross-comp because no individual consumer would want to filter
   *  per-comp here — surfaces using this (podium picks, theme picker,
   *  team browser) explicitly load the comps they need first. */
  readonly teams = computed<readonly KnownTeam[]>(() => {
    const seen = new Map<number, KnownTeam>();
    for (const list of this._all().values()) {
      for (const f of list) {
        const home = asKnownTeam(f.homeTeam);
        const away = asKnownTeam(f.awayTeam);
        if (home && !seen.has(home.id)) seen.set(home.id, home);
        if (away && !seen.has(away.id)) seen.set(away.id, away);
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  });

  readonly teamsById = computed<ReadonlyMap<number, KnownTeam>>(() => {
    const m = new Map<number, KnownTeam>();
    for (const t of this.teams()) m.set(t.id, t);
    return m;
  });

  /** Earliest upcoming TIMED fixture across every loaded comp. Powers
   *  Home's "next match" surface — once Home loads each of the user's
   *  comps, this signal naturally reflects whichever has the soonest
   *  kickoff. */
  readonly nextFixture = computed<Fixture | null>(() => {
    const now = Date.now();
    let next: Fixture | null = null;
    for (const list of this._all().values()) {
      for (const f of list) {
        if (f.status !== 'TIMED') continue;
        if (f.utcKickoff.getTime() <= now) continue;
        if (!next || f.utcKickoff < next.utcKickoff) next = f;
      }
    }
    return next;
  });

  constructor() {
    // Auth-gated bulk fetch. Re-fires whenever the set of requested
    // (comp, season) keys grows OR the user signs in. Idempotent —
    // already-loaded entries are skipped inside fetchFor.
    effect(() => {
      const uid = this.auth.uid();
      if (!uid) return;
      for (const key of this._requested()) {
        const [compId, season] = key.split('_');
        if (!compId || !season) continue;
        const status = this._status().get(key);
        if (status === 'loaded') continue; // already fresh
        // Treat 'cached' as "needs network refresh" too — the cache
        // got us through first paint, now we want the latest.
        void this.fetchFor(compId, season).catch((err) => {
          console.error(`[FixturesService] fetch failed for ${key}`, err);
        });
      }
    });

    // Live overlay — one global listener for every active live match
    // across every comp. Routes incoming updates into the per-comp
    // signal by inspecting each doc's competitionId/season.
    effect((onCleanup) => {
      const uid = this.auth.uid();
      if (!uid) return;
      const liveQuery = query(
        collection(this.db, 'fixtures'),
        where('status', 'in', ['IN_PLAY', 'PAUSED']),
      );
      const unsub = onSnapshot(
        liveQuery,
        (snap) => this.mergeLiveUpdates(snap),
        (err) => console.error('[FixturesService] live listener failed:', err),
      );
      onCleanup(() => unsub());
    });
  }

  // ---------------------------------------------------------------------------
  // Public per-comp accessors
  // ---------------------------------------------------------------------------

  /**
   * Primary entry point. Returns a memoized signal for the given
   * (comp, season) and registers the comp as requested — the auth
   * effect will fetch fresh data as soon as it can.
   *
   * If a cached version exists in localStorage it's hydrated
   * synchronously so the first paint of the consumer has data.
   */
  fixturesFor(compId: string, season: string): Signal<readonly Fixture[]> {
    const key = mapKeyFor(compId, season);
    let sig = this._fixturesSignals.get(key);
    if (sig) return sig;

    sig = computed(() => this._all().get(key) ?? []);
    this._fixturesSignals.set(key, sig);
    this.markRequested(key);
    this.hydrateFromCache(compId, season);
    return sig;
  }

  /**
   * True once a network fetch for the given (comp, season) has
   * settled. Stays false while only the localStorage cache has
   * populated the signal — consumers can use this to distinguish
   * "showing stale-but-instant data" from "definitely up to date".
   */
  loadedFor(compId: string, season: string): Signal<boolean> {
    const key = mapKeyFor(compId, season);
    let sig = this._loadedSignals.get(key);
    if (sig) return sig;
    sig = computed(() => this._status().get(key) === 'loaded');
    this._loadedSignals.set(key, sig);
    return sig;
  }

  /** Force a fresh network fetch for one comp, bypassing the
   *  cache-fresh check. No-op when signed out. */
  async refresh(compId: string, season: string): Promise<void> {
    if (!this.auth.uid()) return;
    await this.fetchFor(compId, season);
  }

  // ---------------------------------------------------------------------------
  // Internals — fetching
  // ---------------------------------------------------------------------------

  private markRequested(key: string): void {
    if (this._requested().has(key)) return;
    this._requested.update((s) => new Set([...s, key]));
  }

  /**
   * Reads the per-comp rollup at `cache/fixtures-{compId}`. For the
   * WC special case during the cutover window, falls back to the
   * legacy `cache/fixtures` doc if the new rollup isn't there yet
   * (the polling cron keeps the legacy doc dual-written so it stays
   * a valid WC source until the cutover completes).
   *
   * Final fallback for any comp: a collection query filtered by
   * (competitionId, season). ~N reads, used only when neither
   * rollup exists.
   */
  private async fetchFor(compId: string, season: string): Promise<void> {
    const key = mapKeyFor(compId, season);
    if (this._inFlight.has(key)) return; // dedupe concurrent triggers
    // Skip if a recent successful fetch lives in cache and the user
    // hasn't explicitly forced a refresh through `refresh()`.
    if (this.cacheIsFresh(compId, season) && this._status().get(key) === 'loaded') {
      return;
    }

    this._inFlight.add(key);
    try {
      // 1. Try the per-comp rollup.
      const compRollupSnap = await getDoc(doc(this.db, 'cache', `fixtures-${compId}`));
      if (compRollupSnap.exists()) {
        this.populateFromRollup(compId, season, compRollupSnap.data());
        return;
      }

      // 2. WC during cutover: legacy single rollup at `cache/fixtures`.
      //    The polling cron writes WC fixtures there for backwards-
      //    compat; once #71's downstream tasks ship and the legacy
      //    write goes away, this branch becomes dead code and can be
      //    removed.
      if (compId === 'WC') {
        const legacySnap = await getDoc(doc(this.db, 'cache', 'fixtures'));
        if (legacySnap.exists()) {
          console.info('[FixturesService] WC: using legacy cache/fixtures rollup');
          this.populateFromRollup(compId, season, legacySnap.data());
          return;
        }
      }

      // 3. Last resort: scan the fixtures collection filtered by
      //    (compId, season). ~N reads but self-heals — first poll
      //    cycle after this writes a proper rollup and step 1 takes
      //    over.
      console.warn(
        `[FixturesService] no rollup for ${compId} ${season}, falling back to collection scan`,
      );
      try {
        await this.fetchFromCollection(compId, season);
      } catch (err) {
        console.error('[FixturesService] collection fallback failed', err);
        this._status.update((m) => new Map(m).set(key, 'loaded'));
      }
    } finally {
      this._inFlight.delete(key);
    }
  }

  /** Reads the rollup doc payload, normalises into Fixture[], updates
   *  state + cache. Used by both the per-comp and legacy rollup paths. */
  private populateFromRollup(
    compId: string,
    season: string,
    data: DocumentData,
  ): void {
    const key = mapKeyFor(compId, season);
    const rawFixtures = Array.isArray(data['fixtures']) ? data['fixtures'] : [];
    const fixtures: Fixture[] = rawFixtures
      .map((entry: DocumentData) => {
        const id = typeof entry['id'] === 'string' ? entry['id'] : null;
        if (!id) return null;
        return this.parse(id, entry, compId, season);
      })
      .filter((f: Fixture | null): f is Fixture => f !== null)
      .sort((a: Fixture, b: Fixture) => a.utcKickoff.getTime() - b.utcKickoff.getTime());
    this._all.update((m) => new Map(m).set(key, fixtures));
    this._status.update((m) => new Map(m).set(key, 'loaded'));
    this.writeCache(compId, season, fixtures);
  }

  private async fetchFromCollection(compId: string, season: string): Promise<void> {
    const key = mapKeyFor(compId, season);
    const q = query(
      collection(this.db, 'fixtures'),
      where('competitionId', '==', compId),
      where('season', '==', season),
    );
    const snap = await getDocs(q);
    const fixtures: Fixture[] = [];
    snap.forEach((d) => fixtures.push(this.parse(d.id, d.data(), compId, season)));
    fixtures.sort((a, b) => a.utcKickoff.getTime() - b.utcKickoff.getTime());
    this._all.update((m) => new Map(m).set(key, fixtures));
    this._status.update((m) => new Map(m).set(key, 'loaded'));
    this.writeCache(compId, season, fixtures);
  }

  /**
   * Merges incoming live-overlay updates into the appropriate per-comp
   * signal. Each doc is routed by its (competitionId, season). Comps
   * that haven't been loaded yet are skipped — they'll pick up the
   * latest state via their initial fetch when first requested.
   */
  private mergeLiveUpdates(snap: QuerySnapshot): void {
    const grouped = new Map<string, Map<string, Fixture>>();
    snap.forEach((d) => {
      const data = d.data();
      const compId =
        typeof data['competitionId'] === 'string' ? data['competitionId'] : 'WC';
      const season = typeof data['season'] === 'string' ? data['season'] : '2026';
      const key = mapKeyFor(compId, season);
      if (!grouped.has(key)) grouped.set(key, new Map());
      grouped.get(key)!.set(d.id, this.parse(d.id, data, compId, season));
    });
    if (grouped.size === 0) return;

    this._all.update((current) => {
      const next = new Map(current);
      for (const [key, updates] of grouped) {
        const existing = next.get(key);
        if (!existing) continue; // comp not loaded — nothing to merge into
        next.set(
          key,
          existing.map((f) => updates.get(f.id) ?? f),
        );
      }
      return next;
    });
  }

  // ---------------------------------------------------------------------------
  // Internals — cache I/O
  // ---------------------------------------------------------------------------

  /** Synchronous cache hydration. Triggered on first `fixturesFor()`
   *  call for a (comp, season) so consumers see real data immediately
   *  if it's been cached locally before. */
  private hydrateFromCache(compId: string, season: string): void {
    const key = mapKeyFor(compId, season);
    if (this._status().has(key)) return; // already populated this session
    const cached = this.readCache(compId, season);
    if (!cached || cached.fixtures.length === 0) {
      this._status.update((m) => new Map(m).set(key, 'loading'));
      return;
    }
    const fixtures = cached.fixtures.map(fixtureFromCache);
    this._all.update((m) => new Map(m).set(key, fixtures));
    // Mark as 'cached' — the auth-effect will still trigger a network
    // fetch to refresh. Consumers can read fixtures immediately; the
    // 'loaded' flag flips true once the fetch settles.
    this._status.update((m) => new Map(m).set(key, 'cached'));
  }

  private cacheIsFresh(compId: string, season: string): boolean {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem(cacheKeyFor(compId, season));
    if (!raw) return false;
    try {
      const env = JSON.parse(raw) as CacheEnvelope;
      if (typeof env.cachedAt !== 'number') return false;
      if (!Array.isArray(env.fixtures) || env.fixtures.length === 0) return false;
      return Date.now() - env.cachedAt < CACHE_TTL_MS;
    } catch {
      return false;
    }
  }

  private readCache(compId: string, season: string): CacheEnvelope | null {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(cacheKeyFor(compId, season));
    if (!raw) return null;
    try {
      const env = JSON.parse(raw) as CacheEnvelope;
      if (!Array.isArray(env.fixtures) || typeof env.cachedAt !== 'number') return null;
      return env;
    } catch {
      return null;
    }
  }

  private writeCache(
    compId: string,
    season: string,
    fixtures: readonly Fixture[],
  ): void {
    if (typeof localStorage === 'undefined') return;
    if (fixtures.length === 0) return; // poisoning guard
    try {
      const envelope: CacheEnvelope = {
        fixtures: fixtures.map(fixtureToCache),
        cachedAt: Date.now(),
      };
      localStorage.setItem(cacheKeyFor(compId, season), JSON.stringify(envelope));
    } catch {
      // Quota exceeded or storage disabled — network path still works.
    }
  }

  // ---------------------------------------------------------------------------
  // Document parsing
  // ---------------------------------------------------------------------------

  /**
   * Adapts a raw fixture doc into the typed Fixture. The (compId,
   * season) context is passed in so legacy docs missing those fields
   * still produce well-tagged Fixtures (the polling refactor in #65
   * defaults missing fields to WC/2026 too — this is the same fallback
   * on the read side).
   */
  private parse(
    id: string,
    data: DocumentData,
    compId: string,
    season: string,
  ): Fixture {
    const kickoff = data['utcKickoff'];
    let parsedKickoff: Date;
    if (kickoff instanceof Timestamp) {
      parsedKickoff = kickoff.toDate();
    } else if (
      kickoff &&
      typeof kickoff === 'object' &&
      'seconds' in kickoff &&
      'nanoseconds' in kickoff
    ) {
      // Rollup-doc embedded Timestamps come through as plain objects
      // rather than Timestamp instances when read from an array field.
      const seconds = (kickoff as { seconds: number; nanoseconds: number }).seconds;
      const ns = (kickoff as { seconds: number; nanoseconds: number }).nanoseconds;
      parsedKickoff = new Date(seconds * 1000 + ns / 1_000_000);
    } else {
      parsedKickoff = new Date(0);
    }
    return {
      id,
      competitionId:
        typeof data['competitionId'] === 'string' ? data['competitionId'] : compId,
      season: typeof data['season'] === 'string' ? data['season'] : season,
      homeTeam: data['homeTeam'],
      awayTeam: data['awayTeam'],
      utcKickoff: parsedKickoff,
      status: (data['status'] as FixtureStatus) ?? 'TIMED',
      stage: (data['stage'] as FixtureStage) ?? 'GROUP',
      group: data['group'] ?? null,
      score: data['score'] ?? null,
    };
  }
}

// =============================================================================
// Cache serialisation helpers (Date <-> ISO string)
// =============================================================================

function fixtureToCache(f: Fixture): CachedFixture {
  return {
    id: f.id,
    competitionId: f.competitionId,
    season: f.season,
    homeTeam: f.homeTeam,
    awayTeam: f.awayTeam,
    utcKickoff: f.utcKickoff.toISOString(),
    status: f.status,
    stage: f.stage,
    group: f.group,
    score: f.score,
  };
}

function fixtureFromCache(c: CachedFixture): Fixture {
  return {
    id: c.id,
    competitionId: c.competitionId ?? 'WC',
    season: c.season ?? '2026',
    homeTeam: c.homeTeam,
    awayTeam: c.awayTeam,
    utcKickoff: new Date(c.utcKickoff),
    status: c.status,
    stage: c.stage,
    group: c.group,
    score: c.score,
  };
}
