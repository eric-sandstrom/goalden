import { Injectable, inject } from '@angular/core';
import { doc, getDoc } from 'firebase/firestore';
import { FIRESTORE } from '../firebase/firebase.providers';
import { CompetitionStandings, parseStandings } from '../models/standings.model';

/**
 * Read-side gateway to the real competition standings cached at
 * `cache/standings-{compId}` by the `pollStandings` Cloud Function.
 *
 * Exposes a single one-shot loader designed to back an Angular `resource()`
 * (see the `resource()` convention in CLAUDE.md): `loadStandings` returns the
 * data and writes nothing to shared signals, so it's safe to call from a
 * resource loader. Standings change slowly and are always read as a whole
 * table, so there's no live `onSnapshot` store here — consumers key a
 * resource on the selected (comp, season) and re-load on change.
 */

interface CacheEnvelope {
  standings: CompetitionStandings;
  cachedAt: number;
}

/** 15-minute freshness window. Standings only move when matches finish and
 *  the cron polls every 30 min, so a warm cache this side of a poll cycle is
 *  still accurate enough for instant paint; the loader refetches past it. */
const CACHE_TTL_MS = 15 * 60 * 1000;

function cacheKeyFor(compId: string, season: string): string {
  return `goalden:standings-${compId}-${season}`;
}

@Injectable({ providedIn: 'root' })
export class StandingsService {
  private readonly db = inject(FIRESTORE);

  /**
   * One-shot async load of one comp's real standings, for use as a
   * `resource()` loader. Returns `null` when no standings exist yet (e.g. a
   * tournament before its group draw, or a knockout-only phase) so the view
   * can show an empty state rather than an error.
   *
   * Fast path: a fresh localStorage cache is returned without a network
   * round-trip. On network failure a stale cache is served if present;
   * otherwise the error propagates so the resource surfaces `.error()`.
   */
  async loadStandings(
    compId: string,
    season: string,
  ): Promise<CompetitionStandings | null> {
    const fresh = this.readCache(compId, season, true);
    if (fresh) return fresh.standings;

    try {
      const snap = await getDoc(doc(this.db, 'cache', `standings-${compId}`));
      if (!snap.exists()) return null;
      const standings = parseStandings(compId, season, snap.data());
      this.writeCache(compId, season, standings);
      return standings;
    } catch (err) {
      const cached = this.readCache(compId, season, false);
      if (cached) {
        console.warn(
          `[StandingsService] loadStandings(${compId}/${season}) network failed — serving cache`,
          err,
        );
        return cached.standings;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Cache I/O
  // ---------------------------------------------------------------------------

  /** Reads the cached envelope. When `requireFresh` is true, returns null if
   *  the entry is older than the TTL (used for the fast path); when false,
   *  returns any parseable entry regardless of age (the offline fallback). */
  private readCache(
    compId: string,
    season: string,
    requireFresh: boolean,
  ): CacheEnvelope | null {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(cacheKeyFor(compId, season));
    if (!raw) return null;
    try {
      const env = JSON.parse(raw) as CacheEnvelope;
      if (!env.standings || typeof env.cachedAt !== 'number') return null;
      if (requireFresh && Date.now() - env.cachedAt > CACHE_TTL_MS) return null;
      return env;
    } catch {
      return null;
    }
  }

  private writeCache(
    compId: string,
    season: string,
    standings: CompetitionStandings,
  ): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const envelope: CacheEnvelope = { standings, cachedAt: Date.now() };
      localStorage.setItem(cacheKeyFor(compId, season), JSON.stringify(envelope));
    } catch {
      // Quota exceeded / storage disabled — network path still works.
    }
  }
}
