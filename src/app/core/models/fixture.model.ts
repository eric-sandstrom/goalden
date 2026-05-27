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
