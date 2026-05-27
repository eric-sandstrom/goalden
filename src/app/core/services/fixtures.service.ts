import { Injectable, Signal, computed, effect, inject, signal } from '@angular/core';
import {
  DocumentData,
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { FIRESTORE } from '../firebase/firebase.providers';
import { Fixture, FixtureStage, FixtureStatus } from '../models/fixture.model';
import { KnownTeam, asKnownTeam } from '../models/podium.model';
import { AuthService } from './auth.service';

/**
 * Two-tier caching strategy:
 *
 *  1. **Bulk path** — read the `cache/fixtures` rollup (one doc, all 104
 *     fixtures inside an array). Combined with a 5-min localStorage TTL,
 *     this saves ~100 reads per cold app open vs. the old collection-wide
 *     `onSnapshot`.
 *
 *  2. **Live overlay** — a small `onSnapshot` scoped to status IN_PLAY /
 *     PAUSED (typically 0-4 fixtures during a match window, empty
 *     otherwise). When score / status updates fire, we merge them into the
 *     bulk-loaded state in place, so the UI shows live scores in real time
 *     without waiting on the rollup's poll cadence.
 *
 * The localStorage cache survives sign-out — fixtures are public data.
 */

const CACHE_KEY = 'goalden:fixtures-cache';
/**
 * 5 min TTL — short enough that kickoff time updates and stage changes
 * propagate fast, long enough to cover typical navigation within a session.
 * Real-time score updates are handled by the live overlay, so the TTL
 * doesn't need to be aggressive.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Cached representation. utcKickoff serialises as ISO string for JSON. */
interface CachedFixture {
  id: string;
  homeTeam: Fixture['homeTeam'];
  awayTeam: Fixture['awayTeam'];
  utcKickoff: string;
  status: FixtureStatus;
  stage: FixtureStage;
  group: string | null;
  score: Fixture['score'];
}

interface CacheEnvelope {
  fixtures: CachedFixture[];
  cachedAt: number;
}

@Injectable({ providedIn: 'root' })
export class FixturesService {
  private readonly db = inject(FIRESTORE);
  private readonly auth = inject(AuthService);

  private readonly _fixtures = signal<readonly Fixture[]>([]);
  private readonly _loaded = signal(false);

  readonly fixtures: Signal<readonly Fixture[]> = this._fixtures.asReadonly();
  readonly loaded: Signal<boolean> = this._loaded.asReadonly();

  readonly fixturesById = computed<ReadonlyMap<string, Fixture>>(() => {
    const map = new Map<string, Fixture>();
    for (const f of this._fixtures()) map.set(f.id, f);
    return map;
  });

  readonly teams = computed<readonly KnownTeam[]>(() => {
    const seen = new Map<number, KnownTeam>();
    for (const f of this._fixtures()) {
      const home = asKnownTeam(f.homeTeam);
      const away = asKnownTeam(f.awayTeam);
      if (home && !seen.has(home.id)) seen.set(home.id, home);
      if (away && !seen.has(away.id)) seen.set(away.id, away);
    }
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  });

  readonly teamsById = computed<ReadonlyMap<number, KnownTeam>>(() => {
    const m = new Map<number, KnownTeam>();
    for (const t of this.teams()) m.set(t.id, t);
    return m;
  });

  readonly nextFixture = computed<Fixture | null>(() => {
    const now = Date.now();
    // The bulk rollup isn't pre-sorted; sort the chrono walk on the fly.
    let next: Fixture | null = null;
    for (const f of this._fixtures()) {
      if (f.status !== 'TIMED') continue;
      if (f.utcKickoff.getTime() <= now) continue;
      if (!next || f.utcKickoff < next.utcKickoff) next = f;
    }
    return next;
  });

  constructor() {
    // Hydrate immediately from cache — no auth, no network. Returning users
    // see fixtures on first paint.
    this.hydrateFromCache();

    // Auth-gated fresh fetch and live overlay listener. The cache check
    // gates bulk reads; the live listener always runs while signed in
    // (typically returns 0 fixtures and costs essentially nothing).
    effect((onCleanup) => {
      const uid = this.auth.uid();
      if (!uid) return;

      if (!this.cacheIsFresh()) {
        this.fetchFixtures().catch((err) => {
          console.error('[FixturesService] bulk fetch failed:', err);
        });
      }

      const liveQuery = query(
        collection(this.db, 'fixtures'),
        where('status', 'in', ['IN_PLAY', 'PAUSED']),
      );
      const unsubLive = onSnapshot(
        liveQuery,
        (snap) => {
          if (snap.empty && snap.docChanges().length === 0) return;
          // Merge each live fixture into the in-memory state in place,
          // matching by id. Non-live fixtures stay as they were from the
          // bulk load.
          const updates = new Map<string, Fixture>();
          snap.forEach((d) => updates.set(d.id, this.parse(d.id, d.data())));
          if (updates.size === 0) return;
          this._fixtures.update((current) =>
            current.map((f) => updates.get(f.id) ?? f),
          );
        },
        (err) => {
          console.error('[FixturesService] live listener failed:', err);
        },
      );
      onCleanup(() => unsubLive());
    });
  }

  /** Force a fresh bulk fetch, bypassing TTL. No-op when signed out. */
  async refresh(): Promise<void> {
    if (!this.auth.uid()) return;
    await this.fetchFixtures();
  }

  // ---------------------------------------------------------------------------
  // Cache I/O
  // ---------------------------------------------------------------------------

  private hydrateFromCache(): void {
    const cached = this.readCache();
    if (!cached) return;
    this._fixtures.set(cached.fixtures.map(fixtureFromCache));
    this._loaded.set(true);
  }

  private cacheIsFresh(): boolean {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    try {
      const env = JSON.parse(raw) as CacheEnvelope;
      if (typeof env.cachedAt !== 'number') return false;
      // An empty cache should never count as fresh — see TeamsService for
      // rationale. Without this, a single empty fetch poisons the cache.
      if (!Array.isArray(env.fixtures) || env.fixtures.length === 0) return false;
      return Date.now() - env.cachedAt < CACHE_TTL_MS;
    } catch {
      return false;
    }
  }

  private readCache(): CacheEnvelope | null {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    try {
      const env = JSON.parse(raw) as CacheEnvelope;
      if (!Array.isArray(env.fixtures) || typeof env.cachedAt !== 'number') return null;
      return env;
    } catch {
      return null;
    }
  }

  private writeCache(fixtures: readonly Fixture[]): void {
    if (typeof localStorage === 'undefined') return;
    // Don't persist an empty result — would poison the cache and suppress
    // re-fetches until TTL expires.
    if (fixtures.length === 0) return;
    try {
      const envelope: CacheEnvelope = {
        fixtures: fixtures.map(fixtureToCache),
        cachedAt: Date.now(),
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(envelope));
    } catch {
      // Quota exceeded — fine, network path still works.
    }
  }

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

  /**
   * Reads the rollup at `cache/fixtures` (1 Firestore read) and populates
   * the signal + localStorage cache.
   *
   * Fallback: if the rollup doc doesn't exist (fresh deploy, manual delete,
   * pollFootballData hasn't run yet), we read the `fixtures` collection
   * directly. That's the expensive path (~100 reads) but it self-heals —
   * the user still sees data, their localStorage caches it, and the next
   * pollFootballData cycle regenerates the rollup for everyone.
   */
  private async fetchFixtures(): Promise<void> {
    const snap = await getDoc(doc(this.db, 'cache', 'fixtures'));
    if (snap.exists()) {
      this.populateFromRollup(snap.data());
      return;
    }

    // Rollup missing — try the canonical collection as a fallback.
    console.warn(
      '[FixturesService] cache/fixtures missing, falling back to fixtures collection',
    );
    try {
      await this.fetchFixturesFromCollection();
    } catch (err) {
      console.error('[FixturesService] fallback collection read failed', err);
      this._loaded.set(true);
    }
  }

  /** Decodes an embedded rollup payload into Fixture[] and updates state. */
  private populateFromRollup(data: DocumentData): void {
    const rawFixtures = Array.isArray(data['fixtures']) ? data['fixtures'] : [];
    const fixtures: Fixture[] = rawFixtures
      .map((entry: DocumentData) => {
        const id = typeof entry['id'] === 'string' ? entry['id'] : null;
        if (!id) return null;
        return this.parse(id, entry);
      })
      .filter((f: Fixture | null): f is Fixture => f !== null)
      .sort((a: Fixture, b: Fixture) => a.utcKickoff.getTime() - b.utcKickoff.getTime());
    this._fixtures.set(fixtures);
    this._loaded.set(true);
    this.writeCache(fixtures);
  }

  /** Per-doc read of the entire fixtures collection. Used only when the
   *  rollup doc is missing — costs ~100 reads but self-heals the UX. */
  private async fetchFixturesFromCollection(): Promise<void> {
    const q = query(collection(this.db, 'fixtures'), orderBy('utcKickoff'));
    const snap = await getDocs(q);
    const fixtures: Fixture[] = [];
    snap.forEach((d) => fixtures.push(this.parse(d.id, d.data())));
    this._fixtures.set(fixtures);
    this._loaded.set(true);
    this.writeCache(fixtures);
  }

  private parse(id: string, data: DocumentData): Fixture {
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
      // Rollup-doc embedded Timestamps come through as plain objects rather
      // than instances when read from an array field. Reconstruct manually.
      const seconds = (kickoff as { seconds: number; nanoseconds: number }).seconds;
      const ns = (kickoff as { seconds: number; nanoseconds: number }).nanoseconds;
      parsedKickoff = new Date(seconds * 1000 + ns / 1_000_000);
    } else {
      parsedKickoff = new Date(0);
    }
    return {
      id,
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
// Cache serialisation helpers
// =============================================================================

function fixtureToCache(f: Fixture): CachedFixture {
  return {
    id: f.id,
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
    homeTeam: c.homeTeam,
    awayTeam: c.awayTeam,
    utcKickoff: new Date(c.utcKickoff),
    status: c.status,
    stage: c.stage,
    group: c.group,
    score: c.score,
  };
}
