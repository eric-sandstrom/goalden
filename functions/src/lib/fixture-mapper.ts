import { Timestamp } from 'firebase-admin/firestore';

export interface FootballDataMatch {
  readonly id: number;
  /** Present on the cross-competition `/v4/matches` list (and the single-match
   *  endpoint) but NOT on the per-comp `/competitions/{id}/matches` list. The
   *  bulk live poll reads `competition.id` to map each match back to its
   *  (comp, season) context; the per-comp poller already knows the comp. */
  readonly competition?: { readonly id: number };
  readonly utcDate: string;
  readonly status: string;
  readonly stage: string;
  readonly group: string | null;
  /** Current match minute while IN_PLAY/PAUSED (caps at the half's nominal
   *  end — 45/90/120 — with stoppage carried in `injuryTime`). Null/absent
   *  outside live play. */
  readonly minute?: number | null;
  /** Added (stoppage) minutes on top of `minute`, e.g. `minute:90,
   *  injuryTime:4` → "90+4". Null/absent when not in stoppage. */
  readonly injuryTime?: number | null;
  readonly homeTeam: { id: number | null; name: string | null; tla: string | null; crest: string | null };
  readonly awayTeam: { id: number | null; name: string | null; tla: string | null; crest: string | null };
  readonly score: {
    winner: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
    /** Final result INCLUDING extra time and penalty-shootout goals (e.g.
     *  a 1-1 match won on pens reads "7-6"). Also the running score while
     *  live. NOT what we score on — see `regularTime`. */
    fullTime: { home: number | null; away: number | null };
    /** Score after 90 minutes (regular time). Populated by football-data
     *  only when the match went to extra time; absent otherwise (when
     *  `fullTime` already is the 90-minute score). This is the score the
     *  game grades on — ET/penalties are ignored. */
    regularTime?: { home: number | null; away: number | null } | null;
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
  /** Our normalised status. Mostly football-data's status mapped through
   *  STATUS_MAP, but a non-live match that carries a final score is forced
   *  to 'FINISHED' even if the provider labelled it CANCELLED/POSTPONED —
   *  see normalizeStatus. This is the status every consumer (lock, scoring,
   *  UI, filters) reads. */
  status: string;
  /** Raw football-data status, kept verbatim for traceability so we never
   *  lose what the provider actually reported when `status` was normalised. */
  apiStatus: string;
  stage: string;
  group: string | null;
  score: {
    /** Final result incl. extra time + penalties (and the live running
     *  score). Kept for traceability/display; scoring reads `regularTime`. */
    fullTime: { home: number; away: number } | null;
    /** Score after 90 minutes — the value the game grades on. Present only
     *  for matches that went to extra time; null otherwise (use `fullTime`,
     *  which is the 90-minute score for a match decided in regulation). */
    regularTime?: { home: number; away: number } | null;
    winner: 'HOME' | 'AWAY' | 'DRAW' | null;
  };

  // --- Live match clock (authoritative, from football-data) ----------------
  // The current minute + stoppage time, refreshed every poll while the match
  // is live (see fixtureChanged). The client anchors these to `lastSyncedAt`
  // and ticks forward for a smooth, accurate clock including stoppage/extra
  // time — unlike the ESPN overlay below, this covers every competition.
  /** Match minute while live; caps at 45/90/120 with stoppage in
   *  `injuryTime`. Null outside live play. */
  minute?: number | null;
  /** Added (stoppage) minutes on top of `minute`. Null when not in stoppage. */
  injuryTime?: number | null;

  // --- ESPN live overlay (display-only) ------------------------------------
  // Written EXCLUSIVELY by the ESPN pass in the poller (pollEspnLive), never
  // by mapFixture or scoreMatch, and always via merge so the two write paths
  // don't clobber each other. The authoritative `score`/`status`/`winner`
  // above are the only fields scoring ever reads — these never feed points.
  // Optional because a fixture has no overlay until it first appears on
  // ESPN's scoreboard (around kickoff), and `fixtureChanged` intentionally
  // ignores them (it diffs authoritative fields only).
  /** ESPN's event id, resolved once via natural key then reused for direct
   *  lookups on later polls. */
  espnEventId?: string | null;
  /** Live score per ESPN; null before kickoff. Display-only. */
  liveScore?: { home: number; away: number } | null;
  /** ESPN match state: 'pre' | 'in' | 'post'. */
  liveState?: 'pre' | 'in' | 'post' | null;
  /** Display clock, e.g. "67'". Null when not in play. */
  liveClock?: string | null;
  /** Short status label, e.g. 'HT', 'Final'. */
  liveDetail?: string | null;
  /** When the overlay was last refreshed from ESPN. */
  liveSyncedAt?: Timestamp;
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

/**
 * Normalises a mapped status against whether the match has a final score.
 *
 * football-data occasionally publishes a played match's full-time result
 * while still labelling it CANCELLED (or POSTPONED) — and counts it in the
 * official table. A non-live match that carries a result is, for our
 * purposes, finished: forcing it to 'FINISHED' keeps the one `status` field
 * truthful for every consumer (lock, scoring trigger, UI badges, filters).
 *
 * Pass-through cases: no result yet (nothing to finish), live in-progress
 * (IN_PLAY/PAUSED — a live score isn't a full-time result), and the already
 * meaningful terminal results FINISHED / AWARDED (a walkover stays AWARDED).
 */
export function normalizeStatus(mapped: string, hasResult: boolean): string {
  if (!hasResult) return mapped;
  if (mapped === 'IN_PLAY' || mapped === 'PAUSED') return mapped;
  if (mapped === 'FINISHED' || mapped === 'AWARDED') return mapped;
  return 'FINISHED';
}

export function mapFixture(
  m: FootballDataMatch,
  ctx: FixtureMapContext = DEFAULT_CONTEXT,
): FixtureDoc {
  const mappedStatus = STATUS_MAP[m.status] ?? 'TIMED';
  const fullTime =
    m.score.fullTime.home !== null && m.score.fullTime.away !== null
      ? { home: m.score.fullTime.home, away: m.score.fullTime.away }
      : null;
  const rt = m.score.regularTime;
  const regularTime =
    rt && rt.home !== null && rt.away !== null ? { home: rt.home, away: rt.away } : null;
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
    status: normalizeStatus(mappedStatus, fullTime !== null),
    apiStatus: m.status,
    stage: STAGE_MAP[m.stage] ?? m.stage,
    group: mapGroup(m.group),
    score: {
      fullTime,
      regularTime,
      winner: mapWinner(m.score.winner),
    },
    minute: m.minute ?? null,
    injuryTime: m.injuryTime ?? null,
  };
}

/** Live statuses during which the match clock advances — the only window in
 *  which a `minute`/`injuryTime` change is worth a write. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['IN_PLAY', 'PAUSED']);

/**
 * Returns true if a list-facing field changed — status, raw apiStatus,
 * kickoff, or score. Deliberately EXCLUDES the live match clock
 * (`minute`/`injuryTime`), which ticks every poll. Use this to decide whether
 * the denormalised rollup (and anything the list view reads) needs rewriting:
 * the rollup never shows the live clock (the client overlays live matches from
 * the live `onSnapshot` listeners), so churning it on every clock tick is pure
 * waste. The full `fixtureChanged` below adds the clock for the canonical doc.
 */
export function fixtureListFieldsChanged(
  existing: FixtureDoc | undefined,
  next: FixtureDoc,
): boolean {
  if (!existing) return true;
  if (existing.status !== next.status) return true;
  // Persist raw-status changes too (e.g. CANCELLED→POSTPONED) so the
  // traceability field stays accurate even when the normalised status is
  // unchanged. `existing.apiStatus` is undefined for docs written before
  // this field existed — treat that as changed so they backfill on next poll.
  if ((existing.apiStatus ?? null) !== next.apiStatus) return true;
  if (existing.utcKickoff.toMillis() !== next.utcKickoff.toMillis()) return true;
  const a = existing.score;
  const b = next.score;
  if (a.winner !== b.winner) return true;
  if ((a.fullTime?.home ?? null) !== (b.fullTime?.home ?? null)) return true;
  if ((a.fullTime?.away ?? null) !== (b.fullTime?.away ?? null)) return true;
  // The 90-minute score (the one we grade on) appears when a match goes to
  // extra time — persist it so scoring and the UI pick it up.
  if ((a.regularTime?.home ?? null) !== (b.regularTime?.home ?? null)) return true;
  if ((a.regularTime?.away ?? null) !== (b.regularTime?.away ?? null)) return true;
  return false;
}

/** Returns true if the relevant subset of the doc has changed — the list-facing
 *  fields plus, while live, the match clock. Gates the canonical doc write. */
export function fixtureChanged(existing: FixtureDoc | undefined, next: FixtureDoc): boolean {
  if (fixtureListFieldsChanged(existing, next)) return true;
  // While a match is live, the minute/stoppage tick every poll — persist them
  // so the client clock stays fresh (and `lastSyncedAt` re-anchors). Gated to
  // live statuses so finished/scheduled fixtures (whose minute is a stable
  // 90/null) never churn the doc. This is the one place we accept a per-poll
  // write during a match, in exchange for an accurate live clock. `existing` is
  // defined here — a missing one already returned true above.
  if (existing && LIVE_STATUSES.has(next.status)) {
    if ((existing.minute ?? null) !== (next.minute ?? null)) return true;
    if ((existing.injuryTime ?? null) !== (next.injuryTime ?? null)) return true;
  }
  return false;
}
