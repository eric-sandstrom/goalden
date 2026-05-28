export type FixtureStatus =
  | 'TIMED'
  | 'IN_PLAY'
  | 'PAUSED'
  | 'FINISHED'
  | 'POSTPONED'
  | 'CANCELLED'
  | 'AWARDED';

export type FixtureStage = 'GROUP' | 'R32' | 'R16' | 'QF' | 'SF' | 'F' | 'THIRD_PLACE';

export interface Team {
  readonly id: number | null;
  readonly name: string | null;
  readonly tla: string | null;
  readonly crest: string | null;
}

export interface FixtureScore {
  readonly fullTime: { readonly home: number; readonly away: number } | null;
  readonly winner: 'HOME' | 'AWAY' | 'DRAW' | null;
}

export interface Fixture {
  readonly id: string;
  /** Competition shortcode (e.g. 'WC', 'PL', 'CL'). Matches the
   *  `competitions/{compId}` doc id. Always present on freshly polled
   *  fixtures; legacy WC fixtures get this backfilled by the
   *  `migrateToMultiComp` admin callable. Until that runs, client code
   *  should treat a missing value as 'WC' for backwards compat. */
  readonly competitionId: string;
  /** Season identifier — uses the starting calendar year of the season
   *  (e.g. '2025' for EPL 2025–26, '2026' for WC 2026, Allsvenskan
   *  2026). Pairs with competitionId to form the totals-shard key
   *  `${competitionId}_${season}`. Backwards-compat: missing means
   *  '2026' (the WC season). */
  readonly season: string;
  readonly homeTeam: Team;
  readonly awayTeam: Team;
  readonly utcKickoff: Date;
  readonly status: FixtureStatus;
  readonly stage: FixtureStage;
  readonly group: string | null;
  readonly score: FixtureScore | null;
}

export function isLocked(fixture: Fixture, now: Date = new Date()): boolean {
  if (fixture.status !== 'TIMED') return true;
  return fixture.utcKickoff.getTime() <= now.getTime();
}

/**
 * True when either team isn't decided yet — typical of knockout fixtures
 * before the preceding round resolves. We can't usefully predict a TBD
 * fixture (no team to bet on), so the UI hides it from the
 * predict-next-card and disables the score inputs on a regular row.
 */
export function isTbd(fixture: Fixture): boolean {
  return fixture.homeTeam.id === null || fixture.awayTeam.id === null;
}

export function isKnockout(stage: FixtureStage): boolean {
  return stage !== 'GROUP';
}
