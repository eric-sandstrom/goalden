/**
 * Catalogue entry for a football competition Goalden supports. One doc
 * per competition lives at `competitions/{id}` and is the source of truth
 * for which comps the polling cron pulls fixtures for (gated by `active`).
 *
 * Populated entirely by the `syncCompetitionsFromApi` admin callable —
 * which hits football-data.org's /competitions endpoint — so there is no
 * hard-coded list anywhere. New competitions become available simply by
 * re-running the sync.
 *
 * The `active` flag separates discovery from enablement: a fresh sync
 * surfaces every comp our API token can see, but the polling cron only
 * fetches fixtures for the ones an admin has explicitly toggled on. This
 * keeps free-tier API quota in deliberate hands.
 */
export type CompetitionType = 'LEAGUE' | 'CUP';

export interface CompetitionArea {
  readonly id: number;
  readonly name: string;
  readonly code: string | null;
  readonly flag: string | null;
}

export interface CompetitionSeason {
  /** football-data's numeric season id. */
  readonly id: number;
  /** ISO 8601 date (YYYY-MM-DD). Kept as a string to mirror the API and
   *  because we never sort competitions by season start at the DB level. */
  readonly startDate: string;
  readonly endDate: string;
  /** Round number for league-format comps (`null` for cup/tournament
   *  comps that don't use matchdays). */
  readonly currentMatchday: number | null;
}

export interface Competition {
  /** Same as the football-data competition `code` (e.g. `PL`, `WC`,
   *  `CL`). Doubles as the Firestore document id. */
  readonly id: string;
  /** football-data's numeric id (e.g. 2021 for Premier League). Useful
   *  for cross-referencing logs / API responses. */
  readonly fdId: number;

  readonly name: string;
  readonly emblem: string | null;
  readonly type: CompetitionType;
  /** football-data subscription tier this comp belongs to (`TIER_ONE`,
   *  etc.). Preserved for debugging — if a sync ever returns a comp from
   *  a tier we don't expect, this tells us why. */
  readonly plan: string | null;

  readonly area: CompetitionArea;
  readonly currentSeason: CompetitionSeason | null;

  /** Polling gate. Admins flip this via the dev-tools UI — only `true`
   *  comps get their fixtures fetched on each pollFootballData cycle. */
  readonly active: boolean;
  /** Set to `true` when an admin has spun up an auto-enrolled global
   *  league for this competition. WC has one; others opt in. */
  readonly hasGlobalLeague: boolean;
}
