import { favoriteOf, rankOf } from '../data/fifa-rankings';
import { ARCHETYPES, type Archetype } from './personality';

/**
 * One row of pre-computed analysis for a single (prediction, fixture)
 * pair. The Cloud Function builds an array of these from the user's
 * predictions and matches them against the fixtures collection before
 * running stat aggregation.
 */
export interface PredictionInput {
  readonly matchId: string;
  readonly homeScore: number;
  readonly awayScore: number;
  readonly submittedAt: number; // epoch ms
  readonly homeTla: string | null;
  readonly awayTla: string | null;
  readonly homeName: string | null;
  readonly awayName: string | null;
}

/**
 * A single user-pick highlighted in the Gemini prompt or fallback
 * reasoning text — e.g. "Saudi Arabia 2-1 Germany" as a concrete
 * example of an upset bet. Keeping the list to a handful keeps the
 * Gemini prompt small.
 */
export interface NotablePick {
  readonly description: string;   // "Saudi Arabia 2-1 Germany"
  readonly category: 'upset' | 'high_scoring' | 'low_scoring' | 'draw' | 'top_team' | 'late_bold';
  readonly detail: string;        // "backed #50 over #10, +40 rank gap"
}

/**
 * Aggregated stats over the user's entire prediction history. Feeds
 * both the deterministic best-fit detector AND the Gemini prompt — so
 * Gemini doesn't have to do its own arithmetic.
 *
 * All rate fields are 0..1 (not percentages) so the scoring function
 * can use them directly as weights. `notablePicks` is the small sample
 * passed to Gemini so its reasoning text can reference specific matches.
 */
export interface PersonalityStats {
  readonly total: number;
  readonly upsetRate: number;
  readonly bigUpsetRate: number;
  readonly favoriteRate: number;
  readonly homePickRate: number;
  readonly drawPickRate: number;
  readonly avgGoalsPerMatch: number;
  readonly highScoringRate: number;
  readonly lowScoringRate: number;
  readonly unusualScoreRate: number;
  readonly scoreEntropy: number;
  readonly topTeamName: string | null;
  readonly topTeamPickCount: number;
  readonly topTeamPickRate: number;
  readonly topTeamWinRate: number;
  readonly earlyAvgGoals: number;
  readonly lateAvgGoals: number;
  readonly earlyUpsetRate: number;
  readonly lateUpsetRate: number;
  readonly notablePicks: readonly NotablePick[];
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Rank-gap threshold for a pick to count as backing the underdog. Below
 *  this, the matchup is too close to call either side an upset. */
const UPSET_GAP = 5;
/** Rank-gap threshold for a "big" upset pick — used to differentiate
 *  AGAINST_ALL_ODDS (consistent underdog backer) from a SNIPER who
 *  happens to nail one shock score. */
const BIG_UPSET_GAP = 15;
/** Common score combos that don't count as "unusual" for the Sniper
 *  detection. Anything outside this set is considered specific. */
const COMMON_SCORES = new Set([
  '0-0', '1-0', '0-1', '1-1', '2-0', '0-2', '2-1', '1-2',
]);

// ---------------------------------------------------------------------------
// Stat computation
// ---------------------------------------------------------------------------

/**
 * Compute the full statistical profile for a user given their parsed
 * predictions. Caller is responsible for filtering out predictions
 * without a corresponding fixture (matchId not found, TBD teams, etc.).
 *
 * Returns a sensible zero-state when given no predictions so callers
 * don't have to special-case empty input.
 */
export function computeStats(predictions: readonly PredictionInput[]): PersonalityStats {
  const total = predictions.length;
  if (total === 0) return EMPTY_STATS;

  let upsetCount = 0;
  let bigUpsetCount = 0;
  let favoriteCount = 0;
  let homeCount = 0;
  let drawCount = 0;
  let totalGoals = 0;
  let highCount = 0;
  let lowCount = 0;
  let unusualCount = 0;

  // Pick distribution per team: name → count of picks where THAT team
  // was selected to win. Used to detect Hometown Hero.
  const teamWinCounts = new Map<string, number>();
  const teamAppearances = new Map<string, number>();

  // Score histogram for Shannon entropy.
  const scoreCounts = new Map<string, number>();

  // Sort by submission time for early/late comparison (Late Bloomer).
  const sorted = [...predictions].sort((a, b) => a.submittedAt - b.submittedAt);
  const half = Math.floor(sorted.length / 2);

  let earlyGoals = 0;
  let lateGoals = 0;
  let earlyUpsets = 0;
  let lateUpsets = 0;
  let earlyCount = 0;
  let lateCount = 0;

  const notable: NotablePick[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const goals = p.homeScore + p.awayScore;
    totalGoals += goals;

    const fav = favoriteOf(p.homeTla, p.awayTla);
    const pickedTeamTla = p.homeScore > p.awayScore
      ? p.homeTla
      : p.awayScore > p.homeScore
        ? p.awayTla
        : null; // draw

    // Drawn picks count as neither upset nor favorite-backed.
    if (pickedTeamTla !== null) {
      if (fav.favoriteTla === pickedTeamTla && fav.gap >= UPSET_GAP) {
        favoriteCount++;
      } else if (fav.underdogTla === pickedTeamTla && fav.gap >= UPSET_GAP) {
        upsetCount++;
        if (fav.gap >= BIG_UPSET_GAP) {
          bigUpsetCount++;
          // Surface as a notable pick — biggest upsets are the juiciest
          // examples for Gemini's reasoning text.
          notable.push({
            description: `${pickedTla(p, pickedTeamTla)} ${p.homeScore}-${p.awayScore} ${otherTeamName(p, pickedTeamTla)}`,
            category: 'upset',
            detail: `backed #${rankOf(pickedTeamTla)} over #${rankOf(fav.favoriteTla)}, +${fav.gap} rank gap`,
          });
        }
      }
    }

    if (p.homeScore > p.awayScore) homeCount++;
    if (p.homeScore === p.awayScore) drawCount++;
    if (goals >= 4) {
      highCount++;
      if (notable.length < 8) {
        notable.push({
          description: `${p.homeName ?? '?'} ${p.homeScore}-${p.awayScore} ${p.awayName ?? '?'}`,
          category: 'high_scoring',
          detail: `${goals} total goals predicted`,
        });
      }
    }
    if (goals <= 1) lowCount++;

    const scoreKey = `${p.homeScore}-${p.awayScore}`;
    if (!COMMON_SCORES.has(scoreKey)) unusualCount++;
    scoreCounts.set(scoreKey, (scoreCounts.get(scoreKey) ?? 0) + 1);

    // Team-picked tally (winner only; draws don't pick a side).
    if (pickedTeamTla !== null) {
      const name = (pickedTeamTla === p.homeTla ? p.homeName : p.awayName) ?? pickedTeamTla;
      teamWinCounts.set(name, (teamWinCounts.get(name) ?? 0) + 1);
    }
    if (p.homeName) teamAppearances.set(p.homeName, (teamAppearances.get(p.homeName) ?? 0) + 1);
    if (p.awayName) teamAppearances.set(p.awayName, (teamAppearances.get(p.awayName) ?? 0) + 1);

    if (i < half) {
      earlyGoals += goals;
      earlyCount++;
      if (pickedTeamTla && fav.underdogTla === pickedTeamTla && fav.gap >= UPSET_GAP) earlyUpsets++;
    } else {
      lateGoals += goals;
      lateCount++;
      if (pickedTeamTla && fav.underdogTla === pickedTeamTla && fav.gap >= UPSET_GAP) lateUpsets++;
    }
  }

  // Top team by win-picks. We require the team to have appeared in at
  // least 2 fixtures — picking a team to win their only group game
  // doesn't make you a Hometown Hero.
  let topTeam: string | null = null;
  let topWins = 0;
  let topAppearances = 0;
  for (const [name, wins] of teamWinCounts) {
    const apps = teamAppearances.get(name) ?? wins;
    if (apps < 2) continue;
    if (wins > topWins || (wins === topWins && apps > topAppearances)) {
      topTeam = name;
      topWins = wins;
      topAppearances = apps;
    }
  }

  // Shannon entropy over the score histogram, normalised to 0..1 by
  // dividing by log2(N) — a flat distribution scores 1, a single-score
  // user scores 0. Used to detect Chaos Goblin.
  const entropy = shannonNormalised(scoreCounts.values(), total);

  return {
    total,
    upsetRate: upsetCount / total,
    bigUpsetRate: bigUpsetCount / total,
    favoriteRate: favoriteCount / total,
    homePickRate: homeCount / total,
    drawPickRate: drawCount / total,
    avgGoalsPerMatch: totalGoals / total,
    highScoringRate: highCount / total,
    lowScoringRate: lowCount / total,
    unusualScoreRate: unusualCount / total,
    scoreEntropy: entropy,
    topTeamName: topTeam,
    topTeamPickCount: topWins,
    topTeamPickRate: topWins / total,
    topTeamWinRate: topAppearances > 0 ? topWins / topAppearances : 0,
    earlyAvgGoals: earlyCount > 0 ? earlyGoals / earlyCount : 0,
    lateAvgGoals: lateCount > 0 ? lateGoals / lateCount : 0,
    earlyUpsetRate: earlyCount > 0 ? earlyUpsets / earlyCount : 0,
    lateUpsetRate: lateCount > 0 ? lateUpsets / lateCount : 0,
    notablePicks: notable.slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Best-fit archetype
// ---------------------------------------------------------------------------

/**
 * Score each archetype 0..1 from the stats. Higher = better fit.
 *
 * Each function picks one or two signals that ARE that archetype, with
 * thresholds chosen to be lenient enough that real users will actually
 * hit them but strict enough that a casual user doesn't get falsely
 * labelled as "Goal Rush" just because the World Cup is a high-scoring
 * tournament.
 *
 * Returned scores are not normalised across archetypes — `bestFit`
 * just takes the argmax, which is fine because we only need ONE label.
 */
export function scoreArchetypes(stats: PersonalityStats): Record<Archetype, number> {
  const s = stats;
  return {
    AGAINST_ALL_ODDS: clamp(s.upsetRate * 1.5 + s.bigUpsetRate * 0.8),
    THE_STATISTICIAN: clamp(s.favoriteRate * 1.4),
    HOME_SWEET_HOME: clamp(Math.max(0, s.homePickRate - 0.45) * 3),
    GOAL_RUSH: clamp(Math.max(0, s.avgGoalsPerMatch - 2.7) * 0.5 + s.highScoringRate * 0.7),
    THE_WALL: clamp(Math.max(0, 2.3 - s.avgGoalsPerMatch) * 0.5 + s.lowScoringRate * 0.7),
    DRAW_DEALER: clamp(Math.max(0, s.drawPickRate - 0.2) * 4),
    CHAOS_GOBLIN: clamp(Math.max(0, s.scoreEntropy - 0.7) * 2.5),
    HOMETOWN_HERO: clamp(s.topTeamPickRate * 1.5 + (s.topTeamWinRate > 0.85 ? 0.3 : 0)),
    SNIPER: clamp(s.unusualScoreRate * 1.2 - 0.1),
    LATE_BLOOMER: clamp(
      Math.max(0, s.lateUpsetRate - s.earlyUpsetRate) * 1.5
        + Math.max(0, s.lateAvgGoals - s.earlyAvgGoals) * 0.3,
    ),
  };
}

/** Return the archetype that best fits the stats. Falls back to
 *  AGAINST_ALL_ODDS only if every score is zero (extremely unlikely;
 *  would require a 1-pick user where the match is a coin-flip, draw,
 *  and a common score). */
export function bestFit(stats: PersonalityStats): Archetype {
  const scores = scoreArchetypes(stats);
  let best: Archetype = 'AGAINST_ALL_ODDS';
  let bestScore = -1;
  for (const a of ARCHETYPES) {
    if (scores[a] > bestScore) {
      bestScore = scores[a];
      best = a;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Fallback reasoning text — used when Gemini is unavailable or returns
// invalid output. Generic enough to apply to anyone in the archetype
// bucket without sounding canned.
// ---------------------------------------------------------------------------

export function fallbackReasoning(archetype: Archetype, stats: PersonalityStats): string {
  const pct = (n: number) => Math.round(n * 100);
  switch (archetype) {
    case 'AGAINST_ALL_ODDS':
      return `${pct(stats.upsetRate)}% of your picks back the FIFA underdog. The bookies don't see you coming.`;
    case 'THE_STATISTICIAN':
      return `${pct(stats.favoriteRate)}% of your picks side with the higher-ranked team. Form table, meet your most devoted reader.`;
    case 'HOME_SWEET_HOME':
      return `${pct(stats.homePickRate)}% of your picks have the home side winning. The crowd matters in your model.`;
    case 'GOAL_RUSH':
      return `You predict an average of ${stats.avgGoalsPerMatch.toFixed(1)} goals per match — you came for the spectacle.`;
    case 'THE_WALL':
      return `${pct(stats.lowScoringRate)}% of your picks end with ≤1 total goal. Tactical and patient.`;
    case 'DRAW_DEALER':
      return `${pct(stats.drawPickRate)}% of your picks end level. You see deadlocks where everyone else sees winners.`;
    case 'CHAOS_GOBLIN':
      return `No two of your picks share the same scoreline — your variance is off the charts.`;
    case 'HOMETOWN_HERO':
      return stats.topTeamName
        ? `You've picked ${stats.topTeamName} to win ${stats.topTeamPickCount} times. Bias confirmed.`
        : `One team gets your trust over and over.`;
    case 'SNIPER':
      return `${pct(stats.unusualScoreRate)}% of your picks land on unusual scorelines like 3-2 or 4-1. You don't do 1-0.`;
    case 'LATE_BLOOMER':
      return `Your picks have gotten ${stats.lateAvgGoals > stats.earlyAvgGoals ? 'bolder' : 'sharper'} as the tournament unfolded.`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_STATS: PersonalityStats = {
  total: 0,
  upsetRate: 0,
  bigUpsetRate: 0,
  favoriteRate: 0,
  homePickRate: 0,
  drawPickRate: 0,
  avgGoalsPerMatch: 0,
  highScoringRate: 0,
  lowScoringRate: 0,
  unusualScoreRate: 0,
  scoreEntropy: 0,
  topTeamName: null,
  topTeamPickCount: 0,
  topTeamPickRate: 0,
  topTeamWinRate: 0,
  earlyAvgGoals: 0,
  lateAvgGoals: 0,
  earlyUpsetRate: 0,
  lateUpsetRate: 0,
  notablePicks: [],
};

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function pickedTla(p: PredictionInput, pickedTla: string | null): string {
  return pickedTla === p.homeTla ? (p.homeName ?? p.homeTla ?? '?') : (p.awayName ?? p.awayTla ?? '?');
}

function otherTeamName(p: PredictionInput, pickedTla: string | null): string {
  return pickedTla === p.homeTla ? (p.awayName ?? p.awayTla ?? '?') : (p.homeName ?? p.homeTla ?? '?');
}

function shannonNormalised(counts: IterableIterator<number>, total: number): number {
  let h = 0;
  let distinct = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    distinct++;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  // Normalise by the maximum possible entropy for this many picks
  // (log2(total) when every pick is a different score). Single-pick
  // users get 0 to avoid divide-by-zero; small-sample users get a
  // dampened score so noise doesn't crown them Chaos Goblin.
  if (total <= 1 || distinct <= 1) return 0;
  return h / Math.log2(total);
}
