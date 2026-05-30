// Maps football-data.org's `/v4/matches/{id}` detail response into the
// `fixtures/{matchId}/detail/full` document.
//
// This is the RICH endpoint — unlike the `/competitions/{id}/matches` list
// the pollers use (which only carries score + status + clock), the per-match
// detail adds goals, bookings, substitutions, referees and lineups. Coverage
// varies by competition and tier (the free tier often returns empty lineups),
// so every field is parsed defensively and absent data maps to null / [].
//
// Events store only the `teamId` (not a home/away flag) so the client can
// resolve the side itself by comparing against the fixture's home/away team
// ids — the detail doc never needs to duplicate the fixture's team identity.

/** A football-data person reference ({ id, name }) — scorer, player, coach. */
export interface FdPerson {
  id: number | null;
  name: string | null;
}

export interface MatchDetailGoal {
  minute: number | null;
  injuryTime: number | null;
  /** 'REGULAR' | 'OWN' | 'PENALTY' (verbatim from the API). */
  type: string | null;
  teamId: number | null;
  scorer: FdPerson | null;
  assist: FdPerson | null;
}

export interface MatchDetailBooking {
  minute: number | null;
  teamId: number | null;
  player: FdPerson | null;
  /** Normalised to YELLOW or RED — a second yellow ('YELLOW_RED') folds to RED. */
  card: 'YELLOW' | 'RED';
}

export interface MatchDetailSubstitution {
  minute: number | null;
  teamId: number | null;
  playerIn: FdPerson | null;
  playerOut: FdPerson | null;
}

export interface MatchDetailReferee {
  id: number | null;
  name: string | null;
  type: string | null;
  nationality: string | null;
}

export interface MatchDetailPlayer {
  id: number | null;
  name: string | null;
  position: string | null;
  shirtNumber: number | null;
}

export interface MatchDetailLineup {
  formation: string | null;
  coach: FdPerson | null;
  lineup: MatchDetailPlayer[];
  bench: MatchDetailPlayer[];
}

export interface MatchDetailScore {
  winner: string | null;
  /** 'REGULAR' | 'EXTRA_TIME' | 'PENALTY_SHOOTOUT' — how the match was decided. */
  duration: string | null;
  fullTime: { home: number | null; away: number | null } | null;
  halfTime: { home: number | null; away: number | null } | null;
  regularTime: { home: number | null; away: number | null } | null;
  extraTime: { home: number | null; away: number | null } | null;
  penalties: { home: number | null; away: number | null } | null;
}

export interface MatchDetailDoc {
  homeTeamId: number | null;
  awayTeamId: number | null;
  score: MatchDetailScore;
  goals: MatchDetailGoal[];
  bookings: MatchDetailBooking[];
  substitutions: MatchDetailSubstitution[];
  referees: MatchDetailReferee[];
  home: MatchDetailLineup;
  away: MatchDetailLineup;
  venue: string | null;
  attendance: number | null;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function arr(v: unknown): Json[] {
  return Array.isArray(v) ? (v.filter((e) => e && typeof e === 'object') as Json[]) : [];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function person(v: unknown): FdPerson | null {
  const o = obj(v);
  if (!o) return null;
  const id = num(o['id']);
  const name = str(o['name']);
  if (id === null && name === null) return null;
  return { id, name };
}

function scoreLine(v: unknown): { home: number | null; away: number | null } | null {
  const o = obj(v);
  if (!o) return null;
  const home = num(o['home']);
  const away = num(o['away']);
  if (home === null && away === null) return null;
  return { home, away };
}

function mapCard(v: unknown): 'YELLOW' | 'RED' {
  // football-data uses 'YELLOW' | 'RED' | 'YELLOW_RED' (second yellow). Some
  // older payloads use the '*_CARD' suffix. A second yellow is a sending-off,
  // so anything mentioning RED folds to RED; everything else is a caution.
  return String(v ?? '')
    .toUpperCase()
    .includes('RED')
    ? 'RED'
    : 'YELLOW';
}

function player(v: unknown): MatchDetailPlayer {
  const o = obj(v) ?? {};
  return {
    id: num(o['id']),
    name: str(o['name']),
    position: str(o['position']),
    shirtNumber: num(o['shirtNumber']),
  };
}

function lineup(v: unknown): MatchDetailLineup {
  const o = obj(v) ?? {};
  return {
    formation: str(o['formation']),
    coach: person(o['coach']),
    lineup: arr(o['lineup']).map(player),
    bench: arr(o['bench']).map(player),
  };
}

/** Maps a raw `/v4/matches/{id}` JSON body into the stored detail doc. Pure
 *  and null-safe — never returns `undefined` (Firestore rejects it). */
export function mapMatchDetail(raw: unknown): MatchDetailDoc {
  const m = obj(raw) ?? {};
  const home = obj(m['homeTeam']) ?? {};
  const away = obj(m['awayTeam']) ?? {};
  const score = obj(m['score']) ?? {};

  return {
    homeTeamId: num(home['id']),
    awayTeamId: num(away['id']),
    score: {
      winner: str(score['winner']),
      duration: str(score['duration']),
      fullTime: scoreLine(score['fullTime']),
      halfTime: scoreLine(score['halfTime']),
      regularTime: scoreLine(score['regularTime']),
      extraTime: scoreLine(score['extraTime']),
      penalties: scoreLine(score['penalties']),
    },
    goals: arr(m['goals']).map((g) => ({
      minute: num(g['minute']),
      injuryTime: num(g['injuryTime']),
      type: str(g['type']),
      teamId: num(obj(g['team'])?.['id']),
      scorer: person(g['scorer']),
      assist: person(g['assist']),
    })),
    bookings: arr(m['bookings']).map((b) => ({
      minute: num(b['minute']),
      teamId: num(obj(b['team'])?.['id']),
      player: person(b['player']),
      card: mapCard(b['card']),
    })),
    substitutions: arr(m['substitutions']).map((s) => ({
      minute: num(s['minute']),
      teamId: num(obj(s['team'])?.['id']),
      playerIn: person(s['playerIn']),
      playerOut: person(s['playerOut']),
    })),
    referees: arr(m['referees']).map((r) => ({
      id: num(r['id']),
      name: str(r['name']),
      type: str(r['type']),
      nationality: str(r['nationality']),
    })),
    home: lineup(home),
    away: lineup(away),
    venue: str(m['venue']),
    attendance: num(m['attendance']),
  };
}
