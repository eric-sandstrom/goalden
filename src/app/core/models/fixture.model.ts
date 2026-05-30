export type FixtureStatus =
  | 'TIMED'
  | 'IN_PLAY'
  | 'PAUSED'
  | 'FINISHED'
  | 'POSTPONED'
  | 'CANCELLED'
  | 'AWARDED';

export type FixtureStage =
  | 'GROUP'
  | 'REGULAR_SEASON'
  | 'LEAGUE_STAGE'
  | 'R32'
  | 'R16'
  | 'QF'
  | 'SF'
  | 'F'
  | 'THIRD_PLACE';

export interface Team {
  readonly id: number | null;
  readonly name: string | null;
  readonly tla: string | null;
  readonly crest: string | null;
}

export interface FixtureScore {
  /** Final result incl. extra time + penalties (and the live running score).
   *  The game does NOT grade on this — see `regularTime`. */
  readonly fullTime: { readonly home: number; readonly away: number } | null;
  /** Score after 90 minutes — what predictions are graded against. Present
   *  only when the match went to extra time; otherwise `fullTime` is the
   *  90-minute score. */
  readonly regularTime?: { readonly home: number; readonly away: number } | null;
  readonly winner: 'HOME' | 'AWAY' | 'DRAW' | null;
}

/** ESPN match state from the live overlay: pre-match, in progress, ended. */
export type LiveState = 'pre' | 'in' | 'post';

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

  // --- Live match clock (authoritative, from football-data) ----------------
  // Refreshed every poll while live. The UI anchors `minute`/`injuryTime` to
  // `lastSyncedAt` and ticks forward in real time for an accurate live clock
  // (incl. stoppage/extra time) across every competition. Display-only.
  /** Current match minute while live (caps at 45/90/120; stoppage in
   *  `injuryTime`). Null outside live play. */
  readonly minute?: number | null;
  /** Added (stoppage) minutes on top of `minute`, e.g. 90 + 4. Null when not
   *  in stoppage. */
  readonly injuryTime?: number | null;
  /** When the fixture was last written by the poller — the anchor the live
   *  clock ticks from. Null on docs/rollups without it. */
  readonly lastSyncedAt?: Date | null;

  // --- ESPN live overlay (display-only) ------------------------------------
  // Written server-side by the poller's ESPN pass, never by the
  // authoritative football-data path. The UI prefers these while a match is
  // in progress (football-data's free tier lags), but they NEVER affect
  // scoring or lock state — `isLocked` and points read `status`/`score` only.
  /** ESPN's event id, the resolved cross-provider link. */
  readonly espnEventId?: string | null;
  /** ESPN's live score; null before kickoff. */
  readonly liveScore?: { readonly home: number; readonly away: number } | null;
  /** ESPN match state: 'pre' | 'in' | 'post'. */
  readonly liveState?: LiveState | null;
  /** ESPN display clock, e.g. "67'". */
  readonly liveClock?: string | null;
  /** ESPN short status label, e.g. 'HT', 'Final'. */
  readonly liveDetail?: string | null;
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

/**
 * Single-elimination knockout stages, denylisted explicitly. Every other
 * stage is table-forming: the WC 'GROUP', a league 'REGULAR_SEASON', the
 * CL 'LEAGUE_STAGE', and any future league-phase label the polling mapper
 * passes through verbatim. Do NOT reduce this to `stage !== 'GROUP'` — that
 * mislabels every league match as a knockout.
 */
const KNOCKOUT_STAGES: ReadonlySet<FixtureStage> = new Set<FixtureStage>([
  'R32',
  'R16',
  'QF',
  'SF',
  'F',
  'THIRD_PLACE',
]);

export function isKnockout(stage: FixtureStage): boolean {
  return KNOCKOUT_STAGES.has(stage);
}

/** A fixture's position within a two-legged knockout tie. */
export interface LegInfo {
  /** 1 = first leg, 2 = second leg (by kickoff order). */
  readonly leg: 1 | 2;
  /** Kickoff of the tie's other leg — for context labelling. */
  readonly otherLegKickoff: Date;
}

/**
 * Identifies two-legged knockout ties within a set of fixtures and returns a
 * `matchId → leg position` map for the fixtures that belong to one.
 *
 * A two-legged tie is two knockout fixtures in the same stage between the same
 * pair of teams, home/away swapped — as the Champions League knockout rounds
 * are. Single-match knockouts (the World Cup, a final) and not-yet-drawn TBD
 * fixtures (whose null team ids can't be paired) belong to no tie and are
 * absent from the map. This is the same pairing the bracket view uses to
 * collapse legs into one tie; here it just tags each leg for the Predict list.
 */
export function buildLegMap(fixtures: readonly Fixture[]): ReadonlyMap<string, LegInfo> {
  const groups = new Map<string, Fixture[]>();
  for (const f of fixtures) {
    if (!isKnockout(f.stage)) continue;
    const a = f.homeTeam.id;
    const b = f.awayTeam.id;
    if (a === null || b === null) continue;
    const pair = a < b ? `${a}-${b}` : `${b}-${a}`;
    const key = `${f.stage}:${pair}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(f);
    else groups.set(key, [f]);
  }
  const out = new Map<string, LegInfo>();
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue; // single-match knockout — not a tie
    const sorted = bucket
      .slice()
      .sort((x, y) => x.utcKickoff.getTime() - y.utcKickoff.getTime());
    const [first, second] = sorted; // a tie has exactly two legs; ignore extras
    out.set(first.id, { leg: 1, otherLegKickoff: second.utcKickoff });
    out.set(second.id, { leg: 2, otherLegKickoff: first.utcKickoff });
  }
  return out;
}
