import { Injectable, Signal, computed, effect, inject, signal } from '@angular/core';
import {
  DocumentData,
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
} from 'firebase/firestore';
import { FIRESTORE } from '../firebase/firebase.providers';
import {
  Coach,
  Player,
  PlayerPosition,
  Team,
} from '../models/team.model';
import { AuthService } from './auth.service';
import { CompetitionsService } from './competitions.service';

const CACHE_KEY = 'goalden:teams-cache';
/**
 * 24-hour TTL — the data changes at most a few times across the tournament
 * (transfers, injury list updates). Polling more aggressively just burns
 * Firestore reads. Users can force a refresh via `refresh()` if needed.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Cached representation — Dates serialise as ISO strings so JSON survives a
 *  localStorage round-trip. Mirrors `Team` / `Player` / `Coach` field-for-field
 *  apart from the date types. */
interface CachedCoach {
  id: number | null;
  name: string;
  nationality: string | null;
  dateOfBirth: string | null;
}

interface CachedPlayer {
  id: number;
  name: string;
  position: PlayerPosition;
  nationality: string | null;
  dateOfBirth: string | null;
  shirtNumber: number | null;
}

interface CachedTeam {
  id: string;
  externalId: number;
  name: string;
  shortName: string | null;
  tla: string | null;
  crest: string | null;
  founded: number | null;
  clubColors: string | null;
  venue: string | null;
  website: string | null;
  coach: CachedCoach | null;
  squad: CachedPlayer[];
  lastSyncedAt: string | null;
}

interface CacheEnvelope {
  teams: CachedTeam[];
  /** Active competition ids this merged list was built from. The cache is
   *  treated as stale when the active set changes (a comp activated/deactivated)
   *  so newly-added comps' teams appear without waiting out the TTL. */
  compIds: string[];
  cachedAt: number;
}

@Injectable({ providedIn: 'root' })
export class TeamsService {
  private readonly db = inject(FIRESTORE);
  private readonly auth = inject(AuthService);
  private readonly competitions = inject(CompetitionsService);

  private readonly _teams = signal<readonly Team[]>([]);
  private readonly _loaded = signal(false);

  readonly teams: Signal<readonly Team[]> = this._teams.asReadonly();
  readonly loaded: Signal<boolean> = this._loaded.asReadonly();

  readonly teamsById = computed<ReadonlyMap<string, Team>>(() => {
    const m = new Map<string, Team>();
    for (const t of this._teams()) m.set(t.id, t);
    return m;
  });

  readonly teamsByExternalId = computed<ReadonlyMap<number, Team>>(() => {
    const m = new Map<number, Team>();
    for (const t of this._teams()) m.set(t.externalId, t);
    return m;
  });

  /** Sorted active competition ids — the set of per-comp team rollups to read.
   *  Sorted so it's a stable cache key regardless of catalogue ordering. */
  private readonly activeCompIds = computed<readonly string[]>(() =>
    this.competitions.activeCompetitions()
      .map((c) => c.id)
      .sort((a, b) => a.localeCompare(b)),
  );

  constructor() {
    // 1. Populate from cache immediately — no auth required, no network. The
    //    UI gets to render real team data on first paint when the cache is
    //    warm, which is the common case for returning users.
    this.hydrateFromCache();

    // 2. Auth-gated fresh fetch, keyed on the active competition set. Teams
    //    live in per-comp rollups, so we wait until the competitions catalogue
    //    has loaded, then read one rollup per active comp and merge. Re-runs
    //    when the active set changes (admin toggles a comp). Only hits the
    //    network when the cache is missing or stale for the current set.
    effect(() => {
      const uid = this.auth.uid();
      if (!uid) return;
      const compIds = this.activeCompIds();
      if (compIds.length === 0) return;
      if (this.cacheIsFresh(compIds)) return;
      this.fetchTeams(compIds).catch((err) => {
        console.error('[TeamsService] fetch failed:', err);
      });
    });
  }

  byExternalId(id: number | null | undefined): Team | null {
    if (id == null) return null;
    return this.teamsByExternalId().get(id) ?? null;
  }

  byId(id: string): Team | null {
    return this.teamsById().get(id) ?? null;
  }

  /** Force a network refresh, bypassing the TTL. No-op when signed out. */
  async refresh(): Promise<void> {
    if (!this.auth.uid()) return;
    await this.fetchTeams(this.activeCompIds());
  }

  // ---------------------------------------------------------------------------
  // Cache I/O
  // ---------------------------------------------------------------------------

  private hydrateFromCache(): void {
    const cached = this.readCache();
    if (!cached) return;
    this._teams.set(cached.teams.map(teamFromCache));
    this._loaded.set(true);
  }

  private cacheIsFresh(compIds: readonly string[]): boolean {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    try {
      const env = JSON.parse(raw) as CacheEnvelope;
      if (typeof env.cachedAt !== 'number') return false;
      // An empty cache should never count as fresh — otherwise a single
      // failed fetch (or one happening before pollTeams populates the
      // rollup) would lock the user out of teams data for 24h.
      if (!Array.isArray(env.teams) || env.teams.length === 0) return false;
      // Stale if the active competition set changed since we cached, so a
      // newly-activated comp's teams show up without waiting out the TTL.
      if (!sameIds(env.compIds, compIds)) return false;
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
      if (!Array.isArray(env.teams) || typeof env.cachedAt !== 'number') return null;
      return env;
    } catch {
      return null;
    }
  }

  private writeCache(teams: readonly Team[], compIds: readonly string[]): void {
    if (typeof localStorage === 'undefined') return;
    // Don't persist an empty result — that would poison the cache and
    // suppress re-fetches until the TTL expires, even though the underlying
    // problem (no data yet) might resolve in minutes.
    if (teams.length === 0) return;
    try {
      const envelope: CacheEnvelope = {
        teams: teams.map(teamToCache),
        compIds: [...compIds],
        cachedAt: Date.now(),
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(envelope));
    } catch {
      // Quota exceeded or storage disabled — cache simply won't help next
      // time, the network path still works.
    }
  }

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

  /**
   * Reads the per-comp rollup docs at `cache/teams-{compId}` — one per active
   * competition — and merges them into a single flat, de-duplicated list
   * (a club can play in more than one comp). One read per active comp, vs.
   * one-per-team if we queried the collection. Per-comp rollups keep each doc
   * well under Firestore's 1 MiB limit no matter how many comps are active.
   */
  private async fetchTeams(compIds: readonly string[]): Promise<void> {
    const snaps = await Promise.all(
      compIds.map((id) => getDoc(doc(this.db, 'cache', `teams-${id}`))),
    );

    const byId = new Map<string, Team>();
    let anyRollup = false;
    for (const snap of snaps) {
      if (!snap.exists()) continue;
      anyRollup = true;
      const rawTeams = Array.isArray(snap.data()['teams']) ? snap.data()['teams'] : [];
      for (const entry of rawTeams as DocumentData[]) {
        const id = typeof entry['id'] === 'string' ? entry['id'] : null;
        if (!id) continue;
        // Last write wins on duplicates — same team, same payload.
        byId.set(id, this.parse(id, entry));
      }
    }

    if (!anyRollup) {
      // No rollups yet (e.g. before the first pollTeams cycle) — fall back to
      // a one-shot read of the canonical collection. Self-heals: the next poll
      // writes the rollups and this branch stops running.
      console.warn(
        '[TeamsService] no cache/teams-* rollups, falling back to teams collection',
      );
      try {
        await this.fetchTeamsFromCollection(compIds);
      } catch (err) {
        console.error('[TeamsService] fallback collection read failed', err);
        this._loaded.set(true);
      }
      return;
    }

    const teams = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    this._teams.set(teams);
    this._loaded.set(true);
    this.writeCache(teams, compIds);
  }

  /** Per-doc read of the entire teams collection — fallback when no rollup
   *  exists yet. ~N reads vs one-per-comp from the rollups. */
  private async fetchTeamsFromCollection(compIds: readonly string[]): Promise<void> {
    const q = query(collection(this.db, 'teams'), orderBy('name'));
    const snap = await getDocs(q);
    const teams: Team[] = [];
    snap.forEach((d) => teams.push(this.parse(d.id, d.data())));
    this._teams.set(teams);
    this._loaded.set(true);
    this.writeCache(teams, compIds);
  }

  private parse(id: string, data: DocumentData): Team {
    const synced = data['lastSyncedAt'];
    return {
      id,
      externalId: typeof data['externalId'] === 'number' ? data['externalId'] : 0,
      name: data['name'] ?? '',
      shortName: data['shortName'] ?? null,
      tla: data['tla'] ?? null,
      crest: data['crest'] ?? null,
      founded: typeof data['founded'] === 'number' ? data['founded'] : null,
      clubColors: data['clubColors'] ?? null,
      venue: data['venue'] ?? null,
      website: data['website'] ?? null,
      coach: parseCoach(data['coach']),
      squad: parseSquad(data['squad']),
      lastSyncedAt: synced instanceof Timestamp ? synced.toDate() : null,
    };
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** Order-insensitive equality for two id lists. Both are produced sorted by
 *  `activeCompIds`, so a positional compare suffices. */
function sameIds(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// =============================================================================
// Cache serialisation helpers
// =============================================================================

function teamToCache(t: Team): CachedTeam {
  return {
    id: t.id,
    externalId: t.externalId,
    name: t.name,
    shortName: t.shortName,
    tla: t.tla,
    crest: t.crest,
    founded: t.founded,
    clubColors: t.clubColors,
    venue: t.venue,
    website: t.website,
    coach: t.coach
      ? {
          id: t.coach.id,
          name: t.coach.name,
          nationality: t.coach.nationality,
          dateOfBirth: t.coach.dateOfBirth?.toISOString() ?? null,
        }
      : null,
    squad: t.squad.map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      nationality: p.nationality,
      dateOfBirth: p.dateOfBirth?.toISOString() ?? null,
      shirtNumber: p.shirtNumber,
    })),
    lastSyncedAt: t.lastSyncedAt?.toISOString() ?? null,
  };
}

function teamFromCache(c: CachedTeam): Team {
  return {
    id: c.id,
    externalId: c.externalId,
    name: c.name,
    shortName: c.shortName,
    tla: c.tla,
    crest: c.crest,
    founded: c.founded,
    clubColors: c.clubColors,
    venue: c.venue,
    website: c.website,
    coach: c.coach
      ? {
          id: c.coach.id,
          name: c.coach.name,
          nationality: c.coach.nationality,
          dateOfBirth: c.coach.dateOfBirth ? new Date(c.coach.dateOfBirth) : null,
        }
      : null,
    squad: c.squad.map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      nationality: p.nationality,
      dateOfBirth: p.dateOfBirth ? new Date(p.dateOfBirth) : null,
      shirtNumber: p.shirtNumber,
    })),
    lastSyncedAt: c.lastSyncedAt ? new Date(c.lastSyncedAt) : null,
  };
}

// =============================================================================
// Firestore document parsing helpers (shared with parse() on the class)
// =============================================================================

function parseCoach(raw: unknown): Coach | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  return {
    id: typeof c['id'] === 'number' ? c['id'] : null,
    name: typeof c['name'] === 'string' ? c['name'] : '',
    nationality: typeof c['nationality'] === 'string' ? c['nationality'] : null,
    dateOfBirth: c['dateOfBirth'] instanceof Timestamp ? c['dateOfBirth'].toDate() : null,
  };
}

function parseSquad(raw: unknown): readonly Player[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parsePlayer);
}

function parsePlayer(raw: unknown): Player {
  const p = (raw ?? {}) as Record<string, unknown>;
  const pos = typeof p['position'] === 'string' ? p['position'] : 'UNKNOWN';
  return {
    id: typeof p['id'] === 'number' ? p['id'] : 0,
    name: typeof p['name'] === 'string' ? p['name'] : '',
    position: normalisePosition(pos),
    nationality: typeof p['nationality'] === 'string' ? p['nationality'] : null,
    dateOfBirth: p['dateOfBirth'] instanceof Timestamp ? p['dateOfBirth'].toDate() : null,
    shirtNumber: typeof p['shirtNumber'] === 'number' ? p['shirtNumber'] : null,
  };
}

function normalisePosition(value: string): PlayerPosition {
  switch (value) {
    case 'GOALKEEPER':
    case 'DEFENDER':
    case 'MIDFIELDER':
    case 'FORWARD':
    case 'UNKNOWN':
      return value;
    default:
      return 'UNKNOWN';
  }
}
