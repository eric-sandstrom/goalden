/**
 * Pre-tournament FIFA Men's World Ranking snapshot.
 *
 * Used by the `generatePredictorPersonality` callable to detect favorite
 * vs. underdog picks deterministically — e.g. a user who consistently
 * backs the team with the higher (worse) rank number scores well on the
 * "Against All Odds" archetype.
 *
 * Keying:
 *   Keyed by team TLA (three-letter FIFA code, e.g. "ARG", "BRA"). TLA
 *   is stable across years and matches the `tla` field on the fixture
 *   doc's `homeTeam` / `awayTeam`. Far less brittle than football-data
 *   .org's numeric IDs.
 *
 * Snapshot policy:
 *   FROZEN once at tournament start. Rankings drift during the World
 *   Cup (a shock group-stage exit drops a team many places), but the
 *   personality is about "what kind of predictor are you given the
 *   pre-tournament expectations", so re-baselining mid-tournament would
 *   destroy the signal we're trying to measure.
 *
 *   To re-snapshot for a future tournament: replace the entries below
 *   with the latest FIFA Men's Ranking as of the day of the official
 *   tournament draw.
 *
 * Coverage:
 *   The 2026 World Cup has 48 teams. Entries below cover the top ~50
 *   national teams in the current ranking — that's more than enough
 *   because every WC qualifier sits inside that band. Any team that
 *   isn't listed (extremely unlikely in a WC fixture) falls back to
 *   `UNRANKED_DEFAULT`, treated as a deep underdog.
 *
 * IMPORTANT:
 *   Lower rank number = stronger team. Argentina at 1 is the favorite
 *   in any matchup against, say, Saudi Arabia at 58. The underdog of a
 *   fixture is whichever team has the *larger* rank number here.
 */

export const FIFA_RANKINGS: Readonly<Record<string, number>> = {
  // ----- Top tier (1–10) ---------------------------------------------------
  ARG: 1,   // Argentina
  FRA: 2,   // France
  ESP: 3,   // Spain
  ENG: 4,   // England
  BRA: 5,   // Brazil
  POR: 6,   // Portugal
  NED: 7,   // Netherlands
  BEL: 8,   // Belgium
  CRO: 9,   // Croatia
  GER: 10,  // Germany

  // ----- Mid-top (11–20) ---------------------------------------------------
  ITA: 11,  // Italy
  MAR: 12,  // Morocco
  COL: 13,  // Colombia
  URU: 14,  // Uruguay
  USA: 15,  // United States
  MEX: 16,  // Mexico
  SUI: 17,  // Switzerland
  DEN: 18,  // Denmark
  SEN: 19,  // Senegal
  JPN: 20,  // Japan

  // ----- Mid (21–30) -------------------------------------------------------
  IRN: 21,  // Iran
  KOR: 22,  // South Korea
  AUT: 23,  // Austria
  AUS: 24,  // Australia
  WAL: 25,  // Wales
  SWE: 26,  // Sweden
  SRB: 27,  // Serbia
  POL: 28,  // Poland
  UKR: 29,  // Ukraine
  ECU: 30,  // Ecuador

  // ----- Lower-mid (31–40) -------------------------------------------------
  EGY: 31,  // Egypt
  HUN: 32,  // Hungary
  NOR: 33,  // Norway
  ALG: 34,  // Algeria
  CZE: 35,  // Czechia
  TUR: 36,  // Türkiye
  CIV: 37,  // Côte d'Ivoire
  TUN: 38,  // Tunisia
  ROU: 39,  // Romania
  PAN: 40,  // Panama

  // ----- Lower (41–50) -----------------------------------------------------
  NGA: 41,  // Nigeria
  PAR: 42,  // Paraguay
  PER: 43,  // Peru
  SCO: 44,  // Scotland
  CMR: 45,  // Cameroon
  SVN: 46,  // Slovenia
  CRC: 47,  // Costa Rica
  GHA: 48,  // Ghana
  SVK: 49,  // Slovakia
  KSA: 50,  // Saudi Arabia

  // ----- WC stragglers + co-hosts that may dip below 50 --------------------
  CAN: 51,  // Canada (co-host)
  QAT: 55,  // Qatar
  NZL: 60,  // New Zealand
  HAI: 75,  // Haiti
  CPV: 80,  // Cape Verde
  JOR: 85,  // Jordan
  UZB: 90,  // Uzbekistan
};

/**
 * Default rank assigned to any team that's not in the table. Set well
 * below the lowest mapped rank so the team is treated as a deep
 * underdog in any matchup against a listed side.
 */
export const UNRANKED_DEFAULT = 100;

/** Convenience: read a team's rank by TLA, falling back to UNRANKED_DEFAULT. */
export function rankOf(tla: string | null | undefined): number {
  if (!tla) return UNRANKED_DEFAULT;
  return FIFA_RANKINGS[tla.toUpperCase()] ?? UNRANKED_DEFAULT;
}

/**
 * Returns the favorite-underdog framing for a fixture. The "gap" is the
 * absolute difference in rank — large gaps mean a clear favorite, small
 * gaps mean a coin-flip matchup where neither side is the "underdog".
 *
 * Tie-breaking: when both teams share a rank (or both fall back to the
 * default), `favoriteTla` is set to the home team. Match conventions in
 * football give home sides a small edge, and treating same-ranked picks
 * as "home favored" lets us still classify Home Sweet Home behaviour
 * without ambiguity.
 */
export function favoriteOf(
  homeTla: string | null | undefined,
  awayTla: string | null | undefined,
): {
  favoriteTla: string | null;
  underdogTla: string | null;
  gap: number;
} {
  const homeRank = rankOf(homeTla);
  const awayRank = rankOf(awayTla);
  const gap = Math.abs(homeRank - awayRank);
  if (homeRank <= awayRank) {
    return { favoriteTla: homeTla ?? null, underdogTla: awayTla ?? null, gap };
  }
  return { favoriteTla: awayTla ?? null, underdogTla: homeTla ?? null, gap };
}
