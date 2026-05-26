export type PointsCategory = 'exact' | 'outcome' | 'wrong';

export interface ScoreResult {
  readonly points: number;
  readonly category: PointsCategory;
}

/**
 * 3 points for an exact full-time score.
 * 1 point for the correct outcome (W/D/L) only.
 * 0 otherwise.
 */
export function scorePrediction(
  prediction: { homeScore: number; awayScore: number },
  actual: { home: number; away: number },
): ScoreResult {
  if (prediction.homeScore === actual.home && prediction.awayScore === actual.away) {
    return { points: 3, category: 'exact' };
  }
  if (outcomeOf(prediction.homeScore, prediction.awayScore) === outcomeOf(actual.home, actual.away)) {
    return { points: 1, category: 'outcome' };
  }
  return { points: 0, category: 'wrong' };
}

function outcomeOf(home: number, away: number): 'HOME' | 'AWAY' | 'DRAW' {
  if (home > away) return 'HOME';
  if (home < away) return 'AWAY';
  return 'DRAW';
}
