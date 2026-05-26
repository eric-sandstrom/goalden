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

export function isKnockout(stage: FixtureStage): boolean {
  return stage !== 'GROUP';
}
