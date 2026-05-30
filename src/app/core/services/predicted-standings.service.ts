import { Injectable } from '@angular/core';
import { Fixture, isKnockout, Team } from '../models/fixture.model';
import { MatchPrediction } from './predictions.service';
import {
  CompetitionStandings,
  StandingRow,
  StandingsTable,
} from '../models/standings.model';

/**
 * Computes a competition table from a user's predictions, to render side by
 * side with the real standings (polled by `pollStandings` → StandingsService).
 *
 * "If all your predictions came true, where would the teams sit?" — for each
 * table-forming fixture we take an *effective result*:
 *   1. the user's predicted score, if they predicted that fixture; else
 *   2. the actual full-time score, if the match has finished; else
 *   3. nothing — a future fixture the user hasn't predicted doesn't count yet.
 *
 * This keeps the predicted table directly comparable to the real one: known
 * results fill the gaps you didn't predict, and your picks override reality
 * only where you actually made a call. Every team that appears in the group's
 * fixtures is seeded into the table (even at 0 played) so the table is
 * complete before any prediction exists — important for the pre-tournament
 * WC group view.
 *
 * Output reuses the `CompetitionStandings` shape so one row component can
 * render both sides. The predicted side carries no `form` and no team
 * `shortName` (fixtures don't include those) — both are left null.
 *
 * Only knockout matches are excluded (they don't form a table). For ranking
 * we use the common points → goal difference → goals-for → name ordering;
 * competition-specific tiebreakers (head-to-head, etc.) aren't reproduced,
 * so a predicted table can differ slightly from how the real provider would
 * break an exact tie. That's an acceptable approximation for a "what if".
 */

/** Mutable per-team accumulator while tallying a group's results. */
interface Tally {
  team: Team;
  played: number;
  won: number;
  draw: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

@Injectable({ providedIn: 'root' })
export class PredictedStandingsService {
  /**
   * Build the predicted standings for one competition from its fixtures and
   * the current user's predictions (keyed by matchId — pass
   * `PredictionsService.matchPredictions()` directly).
   *
   * Pure: no signals, no I/O. Call it from a `computed()` in the view so the
   * predicted table recomputes whenever fixtures or predictions change.
   */
  compute(
    competitionId: string,
    season: string,
    fixtures: readonly Fixture[],
    predictionsById: ReadonlyMap<string, MatchPrediction>,
  ): CompetitionStandings {
    // Only group-stage / regular-season matches between known teams form a
    // table — knockouts and TBD placeholders are out.
    const tableFixtures = fixtures.filter(
      (f) =>
        !isKnockout(f.stage) &&
        f.homeTeam.id !== null &&
        f.awayTeam.id !== null,
    );

    // Bucket by group: a string label ('A', 'B', …) for tournaments, or a
    // single null bucket for league formats.
    const byGroup = new Map<string | null, Fixture[]>();
    for (const f of tableFixtures) {
      const bucket = byGroup.get(f.group) ?? [];
      bucket.push(f);
      byGroup.set(f.group, bucket);
    }

    const tables: StandingsTable[] = [];
    for (const [group, groupFixtures] of byGroup) {
      tables.push(this.buildTable(group, groupFixtures, predictionsById));
    }

    // Group tables in label order ('A' before 'B'); a single league table
    // (null group) is unaffected.
    tables.sort((a, b) => (a.group ?? '').localeCompare(b.group ?? ''));

    return { competitionId, season, tables };
  }

  private buildTable(
    group: string | null,
    fixtures: readonly Fixture[],
    predictionsById: ReadonlyMap<string, MatchPrediction>,
  ): StandingsTable {
    const tallies = new Map<number, Tally>();

    // Seed every team that features in the group so the table is complete
    // even with no results yet.
    for (const f of fixtures) {
      this.seed(tallies, f.homeTeam);
      this.seed(tallies, f.awayTeam);
    }

    // Apply each fixture's effective result to both teams.
    for (const f of fixtures) {
      const result = effectiveResult(f, predictionsById.get(f.id));
      if (!result) continue;
      const home = tallies.get(f.homeTeam.id as number);
      const away = tallies.get(f.awayTeam.id as number);
      if (!home || !away) continue;

      home.played++;
      away.played++;
      home.goalsFor += result.home;
      home.goalsAgainst += result.away;
      away.goalsFor += result.away;
      away.goalsAgainst += result.home;

      if (result.home > result.away) {
        home.won++;
        home.points += 3;
        away.lost++;
      } else if (result.away > result.home) {
        away.won++;
        away.points += 3;
        home.lost++;
      } else {
        home.draw++;
        away.draw++;
        home.points += 1;
        away.points += 1;
      }
    }

    const rows = [...tallies.values()]
      .sort(compareTallies)
      .map((t, i): StandingRow => ({
        position: i + 1,
        team: {
          id: t.team.id,
          name: t.team.name,
          shortName: null,
          tla: t.team.tla,
          crest: t.team.crest,
        },
        playedGames: t.played,
        won: t.won,
        draw: t.draw,
        lost: t.lost,
        points: t.points,
        goalsFor: t.goalsFor,
        goalsAgainst: t.goalsAgainst,
        goalDifference: t.goalsFor - t.goalsAgainst,
        form: null,
      }));

    // Group-stage fixtures map to stage 'GROUP'; league fixtures have no
    // group. Mirror the real-standings `stage` vocabulary loosely.
    return {
      stage: group !== null ? 'GROUP_STAGE' : 'REGULAR_SEASON',
      group,
      rows,
    };
  }

  /** Registers a team in the tally map at zero stats if not already present.
   *  Skips teams with a null id (shouldn't occur post-filter, but defensive). */
  private seed(tallies: Map<number, Tally>, team: Team): void {
    if (team.id === null) return;
    if (tallies.has(team.id)) return;
    tallies.set(team.id, {
      team,
      played: 0,
      won: 0,
      draw: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0,
    });
  }
}

/**
 * The score that should drive the predicted table for one fixture:
 * the user's prediction if present, else the actual full-time score for a
 * finished match, else null (future/in-play + unpredicted → no contribution).
 *
 * Gates on a terminal status (FINISHED/AWARDED), NOT merely on the presence
 * of `score.fullTime`: football-data reports the *running* score in
 * `fullTime` during IN_PLAY/PAUSED, so a score-presence check would fold
 * live, half-played matches into the table. The cancelled-but-played case
 * (a played match the provider mislabels CANCELLED while still counting it)
 * is handled upstream — the poller's `normalizeStatus` rewrites it to
 * FINISHED — so the status check here already captures it.
 */
function effectiveResult(
  fixture: Fixture,
  prediction: MatchPrediction | undefined,
): { home: number; away: number } | null {
  if (prediction) {
    return { home: prediction.homeScore, away: prediction.awayScore };
  }
  if (
    (fixture.status === 'FINISHED' || fixture.status === 'AWARDED') &&
    fixture.score?.fullTime
  ) {
    return { home: fixture.score.fullTime.home, away: fixture.score.fullTime.away };
  }
  return null;
}

/** Standard table ordering: points, then goal difference, then goals for,
 *  then team name as a stable, deterministic final tiebreak. */
function compareTallies(a: Tally, b: Tally): number {
  if (b.points !== a.points) return b.points - a.points;
  const aGd = a.goalsFor - a.goalsAgainst;
  const bGd = b.goalsFor - b.goalsAgainst;
  if (bGd !== aGd) return bGd - aGd;
  if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
  const aName = a.team.name ?? a.team.tla ?? '';
  const bName = b.team.name ?? b.team.tla ?? '';
  return aName.localeCompare(bName);
}
