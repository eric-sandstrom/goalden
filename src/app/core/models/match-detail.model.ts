// Client-side shape of the `fixtures/{matchId}/detail/full` document written
// by the `refreshMatchDetail` callable. Mirrors the backend
// `MatchDetailDoc` (functions/src/lib/match-detail-mapper.ts) — keep the two
// in sync. Events carry only `teamId`; the view resolves home/away by
// comparing against the fixture's team ids.

export interface MatchPerson {
  readonly id: number | null;
  readonly name: string | null;
}

export interface MatchGoal {
  readonly minute: number | null;
  readonly injuryTime: number | null;
  /** 'REGULAR' | 'OWN' | 'PENALTY'. */
  readonly type: string | null;
  readonly teamId: number | null;
  readonly scorer: MatchPerson | null;
  readonly assist: MatchPerson | null;
}

export interface MatchBooking {
  readonly minute: number | null;
  readonly teamId: number | null;
  readonly player: MatchPerson | null;
  readonly card: 'YELLOW' | 'RED';
}

export interface MatchSubstitution {
  readonly minute: number | null;
  readonly teamId: number | null;
  readonly playerIn: MatchPerson | null;
  readonly playerOut: MatchPerson | null;
}

export interface MatchReferee {
  readonly id: number | null;
  readonly name: string | null;
  readonly type: string | null;
  readonly nationality: string | null;
}

export interface MatchPlayer {
  readonly id: number | null;
  readonly name: string | null;
  readonly position: string | null;
  readonly shirtNumber: number | null;
}

export interface MatchLineup {
  readonly formation: string | null;
  readonly coach: MatchPerson | null;
  readonly lineup: readonly MatchPlayer[];
  readonly bench: readonly MatchPlayer[];
}

export interface MatchDetailScore {
  readonly winner: string | null;
  readonly duration: string | null;
  readonly fullTime: { readonly home: number | null; readonly away: number | null } | null;
  readonly halfTime: { readonly home: number | null; readonly away: number | null } | null;
  readonly regularTime: { readonly home: number | null; readonly away: number | null } | null;
  readonly extraTime: { readonly home: number | null; readonly away: number | null } | null;
  readonly penalties: { readonly home: number | null; readonly away: number | null } | null;
}

export interface MatchDetail {
  readonly homeTeamId: number | null;
  readonly awayTeamId: number | null;
  readonly score: MatchDetailScore;
  readonly goals: readonly MatchGoal[];
  readonly bookings: readonly MatchBooking[];
  readonly substitutions: readonly MatchSubstitution[];
  readonly referees: readonly MatchReferee[];
  readonly home: MatchLineup;
  readonly away: MatchLineup;
  readonly venue: string | null;
  readonly attendance: number | null;
  /** When the detail was last fetched from football-data; null on legacy docs. */
  readonly detailSyncedAt: Date | null;
}
