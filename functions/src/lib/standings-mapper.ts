import { mapGroup } from './fixture-mapper';

/**
 * Mapping for football-data.org's `/v4/competitions/{id}/standings` payload.
 *
 * The API returns one or more "standings" blocks. League comps (PL, BL1, …)
 * return three — TOTAL / HOME / AWAY — all for `stage: 'REGULAR_SEASON'`.
 * Group tournaments (WC, CL group stage) return one TOTAL block per group
 * (`stage: 'GROUP_STAGE'`, `group: 'GROUP_A'`, …). Knockout-only phases
 * return an empty `standings` array.
 *
 * We persist only the `TOTAL` blocks — that's the canonical table the
 * predicted-vs-real comparison and the standings view need; the HOME/AWAY
 * splits aren't surfaced anywhere, so dropping them keeps the rollup lean.
 */

// --- football-data API shapes ------------------------------------------------

export interface FootballDataStandingsTeam {
  readonly id: number | null;
  readonly name: string | null;
  readonly shortName: string | null;
  readonly tla: string | null;
  readonly crest: string | null;
}

export interface FootballDataStandingsRow {
  readonly position: number;
  readonly team: FootballDataStandingsTeam;
  readonly playedGames: number;
  readonly form: string | null;
  readonly won: number;
  readonly draw: number;
  readonly lost: number;
  readonly points: number;
  readonly goalsFor: number;
  readonly goalsAgainst: number;
  readonly goalDifference: number;
}

export interface FootballDataStandingsTable {
  readonly stage: string;
  readonly type: string; // 'TOTAL' | 'HOME' | 'AWAY'
  readonly group: string | null;
  readonly table: readonly FootballDataStandingsRow[];
}

export interface FootballDataStandingsResponse {
  readonly standings?: readonly FootballDataStandingsTable[];
}

// --- persisted doc shapes ----------------------------------------------------

export interface StandingsRowDoc {
  position: number;
  team: {
    id: number | null;
    name: string | null;
    shortName: string | null;
    tla: string | null;
    crest: string | null;
  };
  playedGames: number;
  won: number;
  draw: number;
  lost: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  form: string | null;
}

export interface StandingsTableDoc {
  /** Raw football-data stage (e.g. 'REGULAR_SEASON', 'GROUP_STAGE'). */
  stage: string;
  /** Group label with the `GROUP_` prefix stripped (e.g. 'A'), or null for
   *  league tables that aren't split into groups. */
  group: string | null;
  table: StandingsRowDoc[];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function mapRow(row: FootballDataStandingsRow): StandingsRowDoc {
  const team = row.team ?? ({} as FootballDataStandingsTeam);
  return {
    position: num(row.position),
    team: {
      id: typeof team.id === 'number' ? team.id : null,
      name: str(team.name),
      shortName: str(team.shortName),
      tla: str(team.tla),
      crest: str(team.crest),
    },
    playedGames: num(row.playedGames),
    won: num(row.won),
    draw: num(row.draw),
    lost: num(row.lost),
    points: num(row.points),
    goalsFor: num(row.goalsFor),
    goalsAgainst: num(row.goalsAgainst),
    goalDifference: num(row.goalDifference),
    form: str(row.form),
  };
}

/**
 * Reduces the API response to the TOTAL tables we persist, normalised into
 * the doc shape and ordered by position within each table. Group labels are
 * stripped of the `GROUP_` prefix to match how fixtures store `group`.
 */
export function mapStandings(
  res: FootballDataStandingsResponse,
): StandingsTableDoc[] {
  const blocks = (res.standings ?? []).filter((b) => b.type === 'TOTAL');
  return blocks.map((b) => ({
    stage: typeof b.stage === 'string' ? b.stage : 'REGULAR_SEASON',
    group: mapGroup(b.group),
    table: (b.table ?? [])
      .map(mapRow)
      .sort((a, b) => a.position - b.position),
  }));
}

/**
 * Compact signature of a standings snapshot for change detection. Captures
 * the fields that move when results come in (position, points, GD, goals,
 * games played) so we only rewrite the rollup when the table actually
 * changed — standings poll on their own cadence but most cycles are no-ops.
 */
export function standingsSignature(tables: readonly StandingsTableDoc[]): string {
  return tables
    .map(
      (t) =>
        `${t.group ?? '_'}:` +
        t.table
          .map(
            (r) =>
              `${r.position},${r.team.id ?? ''},${r.playedGames},${r.points},${r.goalDifference},${r.goalsFor}`,
          )
          .join('|'),
    )
    .join(';');
}
