// Maps football-data.org's `/v4/matches/{id}/head2head` subresource into the
// `fixtures/{matchId}/detail/head2head` document.
//
// Head-to-head is immutable history relative to a match ("former encounters
// between these teams up to this fixture"), so the poller captures it ONCE when
// a match's lineup first appears and never rewrites it. Like the match-detail
// mapper, every field is parsed defensively — the exact response shape varies
// by tier/competition, and absent data maps to null / [].
//
// Response shape (v4): { aggregates: { numberOfMatches, totalGoals,
// homeTeam: {id,name,wins,draws,losses}, awayTeam: {...} }, matches: [...] }.

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

/** One team's record across the prior encounters. */
export interface H2HTeamRecord {
  id: number | null;
  name: string | null;
  wins: number | null;
  draws: number | null;
  losses: number | null;
}

export interface H2HAggregates {
  numberOfMatches: number | null;
  totalGoals: number | null;
  home: H2HTeamRecord;
  away: H2HTeamRecord;
}

/** A trimmed previous encounter — enough to list it, not the full match doc. */
export interface H2HMatch {
  id: number | null;
  utcDate: string | null;
  competition: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  winner: string | null;
  home: number | null;
  away: number | null;
}

export interface Head2HeadDoc {
  aggregates: H2HAggregates | null;
  matches: H2HMatch[];
}

function teamRecord(v: unknown): H2HTeamRecord {
  const o = obj(v) ?? {};
  return {
    id: num(o['id']),
    name: str(o['name']),
    wins: num(o['wins']),
    draws: num(o['draws']),
    losses: num(o['losses']),
  };
}

/** Maps a raw `/v4/matches/{id}/head2head` body into the stored doc. Pure and
 *  null-safe — never returns `undefined` (Firestore rejects it). */
export function mapHead2Head(raw: unknown): Head2HeadDoc {
  const root = obj(raw) ?? {};
  const agg = obj(root['aggregates']);

  return {
    aggregates: agg
      ? {
          numberOfMatches: num(agg['numberOfMatches']),
          totalGoals: num(agg['totalGoals']),
          home: teamRecord(agg['homeTeam']),
          away: teamRecord(agg['awayTeam']),
        }
      : null,
    matches: arr(root['matches']).map((m) => {
      const score = obj(m['score']) ?? {};
      const ft = obj(score['fullTime']) ?? {};
      return {
        id: num(m['id']),
        utcDate: str(m['utcDate']),
        competition: str(obj(m['competition'])?.['name']),
        homeTeam: str(obj(m['homeTeam'])?.['name']),
        awayTeam: str(obj(m['awayTeam'])?.['name']),
        winner: str(score['winner']),
        home: num(ft['home']),
        away: num(ft['away']),
      };
    }),
  };
}
