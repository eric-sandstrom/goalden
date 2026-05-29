/**
 * Real competition standings as polled from football-data.org and cached at
 * `cache/standings-{compId}` by the `pollStandings` Cloud Function.
 *
 * This is the *actual* table — the predicted-standings feature computes a
 * parallel table from a user's predictions and renders the two side by side.
 *
 * A competition has one table for league formats (PL, BL1, …) and one table
 * per group for group-stage tournaments (WC, CL group stage). Knockout-only
 * phases have no standings, so `tables` can be empty.
 */
import { DocumentData } from 'firebase/firestore';

export interface StandingsTeam {
  /** football-data numeric team id. Null for placeholder rows (rare). */
  readonly id: number | null;
  readonly name: string | null;
  readonly shortName: string | null;
  readonly tla: string | null;
  readonly crest: string | null;
}

export interface StandingRow {
  readonly position: number;
  readonly team: StandingsTeam;
  readonly playedGames: number;
  readonly won: number;
  readonly draw: number;
  readonly lost: number;
  readonly points: number;
  readonly goalsFor: number;
  readonly goalsAgainst: number;
  readonly goalDifference: number;
  /** Recent results string like 'W,W,D,L,W', or null when unavailable. */
  readonly form: string | null;
}

export interface StandingsTable {
  /** Raw football-data stage (e.g. 'REGULAR_SEASON', 'GROUP_STAGE'). */
  readonly stage: string;
  /** Group label (e.g. 'A') for group-stage tables, null for league tables. */
  readonly group: string | null;
  readonly rows: readonly StandingRow[];
}

export interface CompetitionStandings {
  readonly competitionId: string;
  readonly season: string;
  readonly tables: readonly StandingsTable[];
}

/** True when the standings are split into groups (WC / CL group stage) —
 *  the view renders one mini-table per group rather than a single table. */
export function isGroupStandings(standings: CompetitionStandings): boolean {
  return standings.tables.some((t) => t.group !== null);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function parseRow(data: DocumentData): StandingRow {
  const team = (data['team'] ?? {}) as DocumentData;
  return {
    position: num(data['position']),
    team: {
      id: typeof team['id'] === 'number' ? team['id'] : null,
      name: str(team['name']),
      shortName: str(team['shortName']),
      tla: str(team['tla']),
      crest: str(team['crest']),
    },
    playedGames: num(data['playedGames']),
    won: num(data['won']),
    draw: num(data['draw']),
    lost: num(data['lost']),
    points: num(data['points']),
    goalsFor: num(data['goalsFor']),
    goalsAgainst: num(data['goalsAgainst']),
    goalDifference: num(data['goalDifference']),
    form: str(data['form']),
  };
}

/**
 * Adapts a raw `cache/standings-{compId}` doc into the typed model. Tolerant
 * of missing fields so a transient/partial doc never throws — affected
 * entries fall back to safe defaults until the next poll rewrites them.
 */
export function parseStandings(
  compId: string,
  season: string,
  data: DocumentData,
): CompetitionStandings {
  const rawTables = Array.isArray(data['standings']) ? data['standings'] : [];
  const tables: StandingsTable[] = rawTables.map((t: DocumentData) => ({
    stage: str(t['stage']) ?? 'REGULAR_SEASON',
    group: str(t['group']),
    rows: (Array.isArray(t['table']) ? t['table'] : [])
      .map(parseRow)
      .sort((a: StandingRow, b: StandingRow) => a.position - b.position),
  }));
  return {
    competitionId: typeof data['competitionId'] === 'string' ? data['competitionId'] : compId,
    season: typeof data['season'] === 'string' ? data['season'] : season,
    tables,
  };
}
