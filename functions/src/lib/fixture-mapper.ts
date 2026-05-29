import { Timestamp } from 'firebase-admin/firestore';

export interface FootballDataMatch {
  readonly id: number;
  readonly utcDate: string;
  readonly status: string;
  readonly stage: string;
  readonly group: string | null;
  readonly homeTeam: { id: number | null; name: string | null; tla: string | null; crest: string | null };
  readonly awayTeam: { id: number | null; name: string | null; tla: string | null; crest: string | null };
  readonly score: {
    winner: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
    fullTime: { home: number | null; away: number | null };
  };
}

export interface FootballDataResponse {
  readonly matches: readonly FootballDataMatch[];
}

// Maps football-data.org's cup stage labels to our compact codes. Any stage
// not listed here passes through verbatim (see mapFixture) — that's how the
// league-phase labels 'REGULAR_SEASON' and the CL 'LEAGUE_STAGE' reach
// Firestore unchanged. Keep the client's `FixtureStage` union in sync with
// these compact codes plus the verbatim passthrough values.
const STAGE_MAP: Record<string, string> = {
  GROUP_STAGE: 'GROUP',
  LAST_32: 'R32',
  LAST_16: 'R16',
  QUARTER_FINALS: 'QF',
  SEMI_FINALS: 'SF',
  FINAL: 'F',
  THIRD_PLACE: 'THIRD_PLACE',
};

const STATUS_MAP: Record<string, string> = {
  SCHEDULED: 'TIMED',
  TIMED: 'TIMED',
  IN_PLAY: 'IN_PLAY',
  PAUSED: 'PAUSED',
  FINISHED: 'FINISHED',
  POSTPONED: 'POSTPONED',
  CANCELLED: 'CANCELLED',
  AWARDED: 'AWARDED',
  SUSPENDED: 'POSTPONED',
};

export interface FixtureDoc {
  /** Competition shortcode (e.g. 'WC', 'PL', 'CL'). Injected by the
   *  polling loop from the competitions/{code} doc it's currently
   *  iterating. Defaults to 'WC' when `mapFixture` is called without
   *  context so legacy callers (the single-comp pollFootballData) keep
   *  working until the multi-comp polling refactor lands. */
  competitionId: string;
  /** Season starting year as a string (e.g. '2025' for the 2025–26
   *  league seasons, '2026' for WC 2026). Same default + reasoning as
   *  competitionId. */
  season: string;
  homeTeam: {
    id: number | null;
    name: string | null;
    tla: string | null;
    crest: string | null;
  };
  awayTeam: {
    id: number | null;
    name: string | null;
    tla: string | null;
    crest: string | null;
  };
  utcKickoff: Timestamp;
  status: string;
  stage: string;
  group: string | null;
  score: {
    fullTime: { home: number; away: number } | null;
    winner: 'HOME' | 'AWAY' | 'DRAW' | null;
  };
}

/** Context the polling loop passes to mapFixture so the produced doc
 *  carries its (comp, season) tag without inspecting the API response.
 *  Defaults exist to keep the single-comp pollFootballData working
 *  until task #65 swaps it for the multi-comp loop. */
export interface FixtureMapContext {
  readonly competitionId: string;
  readonly season: string;
}

const DEFAULT_CONTEXT: FixtureMapContext = {
  competitionId: 'WC',
  season: '2026',
};

export function mapWinner(w: string | null): 'HOME' | 'AWAY' | 'DRAW' | null {
  if (w === 'HOME_TEAM') return 'HOME';
  if (w === 'AWAY_TEAM') return 'AWAY';
  if (w === 'DRAW') return 'DRAW';
  return null;
}

export function mapGroup(g: string | null): string | null {
  return g ? g.replace(/^GROUP_/, '') : null;
}

export function mapFixture(
  m: FootballDataMatch,
  ctx: FixtureMapContext = DEFAULT_CONTEXT,
): FixtureDoc {
  return {
    competitionId: ctx.competitionId,
    season: ctx.season,
    homeTeam: {
      id: m.homeTeam.id,
      name: m.homeTeam.name,
      tla: m.homeTeam.tla,
      crest: m.homeTeam.crest,
    },
    awayTeam: {
      id: m.awayTeam.id,
      name: m.awayTeam.name,
      tla: m.awayTeam.tla,
      crest: m.awayTeam.crest,
    },
    utcKickoff: Timestamp.fromDate(new Date(m.utcDate)),
    status: STATUS_MAP[m.status] ?? 'TIMED',
    stage: STAGE_MAP[m.stage] ?? m.stage,
    group: mapGroup(m.group),
    score: {
      fullTime:
        m.score.fullTime.home !== null && m.score.fullTime.away !== null
          ? { home: m.score.fullTime.home, away: m.score.fullTime.away }
          : null,
      winner: mapWinner(m.score.winner),
    },
  };
}

/** Returns true if the relevant subset of the doc has changed. */
export function fixtureChanged(existing: FixtureDoc | undefined, next: FixtureDoc): boolean {
  if (!existing) return true;
  if (existing.status !== next.status) return true;
  if (existing.utcKickoff.toMillis() !== next.utcKickoff.toMillis()) return true;
  const a = existing.score;
  const b = next.score;
  if (a.winner !== b.winner) return true;
  if ((a.fullTime?.home ?? null) !== (b.fullTime?.home ?? null)) return true;
  if ((a.fullTime?.away ?? null) !== (b.fullTime?.away ?? null)) return true;
  return false;
}
