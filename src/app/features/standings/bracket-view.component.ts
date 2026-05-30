import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Fixture, Team } from '../../core/models/fixture.model';
import { CompetitionsService } from '../../core/services/competitions.service';
import { FixturesService } from '../../core/services/fixtures.service';
import { MatchPrediction, PredictionsService } from '../../core/services/predictions.service';
import type { StandingsView } from './standings-table.component';

/** One side of a knockout tie, ready to render. */
interface BracketTeam {
  readonly id: number | null;
  readonly tla: string | null;
  readonly name: string | null;
  readonly crest: string | null;
}

/** A side of a tie plus the number shown against it: the aggregate over both
 *  legs for a two-legged tie, or the single full-time score otherwise. */
interface BracketSide {
  readonly team: BracketTeam;
  readonly score: number | null;
}

/** One leg of a two-legged tie, oriented to the tie's fixed sides (A–B) rather
 *  than that leg's home/away — so the numbers line up with the rows above
 *  regardless of which side hosted that leg. */
interface BracketLeg {
  readonly label: string;
  readonly a: number | null;
  readonly b: number | null;
}

/** A knockout tie — one match in most competitions, but a home-and-away pair in
 *  two-legged formats (e.g. the Champions League knockout rounds). `winner` is
 *  the side that advances: from the aggregate on a two-legged tie (with the
 *  authoritative second-leg `score.winner` breaking a level aggregate, so it
 *  reflects extra time / penalties), and from the single match otherwise. A
 *  draw with nothing to break it advances no one. */
interface BracketTie {
  readonly id: string;
  readonly sideA: BracketSide;
  readonly sideB: BracketSide;
  /** Present and rendered only for two-legged ties. */
  readonly legs: readonly BracketLeg[];
  readonly winner: 'a' | 'b' | null;
}

interface BracketRound {
  readonly stage: string;
  readonly label: string;
  readonly ties: readonly BracketTie[];
}

/** Single-elimination rounds in tree order. Stages not present in a given
 *  competition's fixtures are simply skipped (e.g. a comp with no R32). */
const ROUND_ORDER: readonly { readonly stage: string; readonly label: string }[] = [
  { stage: 'R32', label: 'Round of 32' },
  { stage: 'R16', label: 'Round of 16' },
  { stage: 'QF', label: 'Quarter-finals' },
  { stage: 'SF', label: 'Semi-finals' },
  { stage: 'F', label: 'Final' },
];

/**
 * Knockout bracket for a competition — the tree counterpart to the group/league
 * tables in StandingsViewComponent. Self-loads the comp's fixtures, buckets the
 * knockout stages into round columns, and renders a horizontally-scrollable
 * single-elimination tree.
 *
 * Two-legged ties (the same two teams meeting twice in a stage, home/away
 * swapped — as the Champions League knockout rounds do) are detected by pairing
 * fixtures within a stage by their team pair, then collapsed into one tie box
 * that shows each leg's scoreline plus the aggregate. Single-match knockouts
 * (the World Cup, a final) pair to nothing and render as one match, unchanged.
 *
 * `view` mirrors the standings Predicted/Actual toggle: the predicted side fills
 * each match with the user's predicted score (falling back to the real result
 * for finished matches they didn't predict); the real side shows polled results.
 */
@Component({
  selector: 'app-bracket-view',
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './bracket-view.component.html',
  styleUrl: './bracket-view.component.scss',
})
export class BracketViewComponent {
  private readonly fixturesService = inject(FixturesService);
  private readonly predictions = inject(PredictionsService);
  private readonly competitions = inject(CompetitionsService);

  readonly competitionId = input.required<string>();
  /** Optional — derived from the catalogue's current season when omitted. */
  readonly season = input<string>('');
  /** Predicted (from the user's picks) or real (polled) results. */
  readonly view = input<StandingsView>('predicted');
  /** Team ids to highlight — typically the next match up for prediction. */
  readonly highlightTeamIds = input<readonly number[]>([]);

  // Coalesce to [] — the router's component-input binding can hand an
  // unbound input `undefined`, overriding the declared default.
  protected readonly highlightSet = computed(() => new Set(this.highlightTeamIds() ?? []));

  protected readonly effectiveSeason = computed<string>(() => {
    const explicit = this.season();
    if (explicit) return explicit;
    const start = this.competitions.byId(this.competitionId())?.currentSeason?.startDate;
    return start && start.length >= 4 ? start.slice(0, 4) : '';
  });

  private readonly compFixtures = computed<readonly Fixture[]>(() => {
    const season = this.effectiveSeason();
    if (!season) return [];
    return this.fixturesService.fixturesFor(this.competitionId(), season)();
  });

  protected readonly fixturesLoaded = computed(() => {
    const season = this.effectiveSeason();
    if (!season) return false;
    return this.fixturesService.loadedFor(this.competitionId(), season)();
  });

  protected readonly rounds = computed<readonly BracketRound[]>(() => {
    const fixtures = this.compFixtures();
    const preds = this.predictions.matchPredictions();
    const view = this.view();
    const rounds: BracketRound[] = [];
    for (const { stage, label } of ROUND_ORDER) {
      const ties = buildTies(
        fixtures.filter((f) => f.stage === stage),
        preds,
        view,
      );
      if (ties.length > 0) rounds.push({ stage, label, ties });
    }
    return rounds;
  });

  protected readonly thirdPlace = computed<BracketTie | null>(() => {
    const f = this.compFixtures().find((x) => x.stage === 'THIRD_PLACE');
    return f ? buildTie([f], this.predictions.matchPredictions(), this.view()) : null;
  });

  protected readonly empty = computed(() => this.rounds().length === 0 && !this.thirdPlace());
}

function toBracketTeam(t: Team): BracketTeam {
  return { id: t.id, tla: t.tla, name: t.name, crest: t.crest };
}

/**
 * Buckets a stage's fixtures into ties. Fixtures with the same unordered team
 * pair are two legs of one tie (knockout two-legged ties have exactly two);
 * everything else — single-match knockouts and not-yet-drawn TBD fixtures
 * (whose null team ids can't be paired) — is a one-leg tie. Ties are ordered by
 * their earliest leg's kickoff, which approximates bracket order and stays
 * stable before teams are decided.
 */
function buildTies(
  fixtures: readonly Fixture[],
  preds: ReadonlyMap<string, MatchPrediction>,
  view: StandingsView,
): BracketTie[] {
  const groups = new Map<string, Fixture[]>();
  const standalone: Fixture[][] = [];
  for (const f of fixtures) {
    const a = f.homeTeam.id;
    const b = f.awayTeam.id;
    if (a === null || b === null) {
      standalone.push([f]);
      continue;
    }
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    const existing = groups.get(key);
    if (existing) existing.push(f);
    else groups.set(key, [f]);
  }
  return [...groups.values(), ...standalone]
    .map((legs) => legs.slice().sort(byKickoff))
    .sort((x, y) => byKickoff(x[0], y[0]))
    .map((legs) => buildTie(legs, preds, view));
}

function byKickoff(a: Fixture, b: Fixture): number {
  return a.utcKickoff.getTime() - b.utcKickoff.getTime();
}

/** Per-leg score in the requested view: the polled full-time score (real) or
 *  the user's prediction, falling back to the real result for a finished match
 *  they didn't predict (predicted). Null when there's nothing to show yet. */
function legScore(
  f: Fixture,
  preds: ReadonlyMap<string, MatchPrediction>,
  view: StandingsView,
): { home: number; away: number } | null {
  if (view === 'real') {
    return (f.status === 'FINISHED' || f.status === 'AWARDED') && f.score?.fullTime
      ? f.score.fullTime
      : null;
  }
  const p = preds.get(f.id);
  if (p) return { home: p.homeScore, away: p.awayScore };
  // Gates on status, not raw fullTime presence — football-data puts the live
  // score in fullTime during play; the cancelled-but-played case is already
  // normalised to FINISHED upstream by the poller.
  if ((f.status === 'FINISHED' || f.status === 'AWARDED') && f.score?.fullTime) {
    return { home: f.score.fullTime.home, away: f.score.fullTime.away };
  }
  return null;
}

/**
 * Builds a tie from its legs (one or two, kickoff-ordered). Sides are fixed to
 * the first leg's home (A) and away (B), so a two-legged tie's aggregate and
 * per-leg numbers stay oriented to the same rows even though the second leg
 * swaps host.
 */
function buildTie(
  fixtures: readonly Fixture[],
  preds: ReadonlyMap<string, MatchPrediction>,
  view: StandingsView,
): BracketTie {
  const first = fixtures[0];
  const teamA = toBracketTeam(first.homeTeam);
  const teamB = toBracketTeam(first.awayTeam);
  const twoLeg = fixtures.length > 1;

  // Each leg's score, oriented to sides A/B rather than home/away.
  const legs: BracketLeg[] = fixtures.map((f, i) => {
    const sc = legScore(f, preds, view);
    const aIsHome = f.homeTeam.id === teamA.id;
    return {
      label: twoLeg ? (i === 0 ? '1st' : '2nd') : '',
      a: sc ? (aIsHome ? sc.home : sc.away) : null,
      b: sc ? (aIsHome ? sc.away : sc.home) : null,
    };
  });

  const sum = (vals: readonly (number | null)[]): number | null => {
    const known = vals.filter((v): v is number => v !== null);
    return known.length ? known.reduce((x, y) => x + y, 0) : null;
  };
  const aggA = twoLeg ? sum(legs.map((l) => l.a)) : legs[0].a;
  const aggB = twoLeg ? sum(legs.map((l) => l.b)) : legs[0].b;

  return {
    id: fixtures.map((f) => f.id).join('+'),
    sideA: { team: teamA, score: aggA },
    sideB: { team: teamB, score: aggB },
    legs: twoLeg ? legs : [],
    winner: decideWinner(fixtures, legs, view),
  };
}

/**
 * The advancing side, or null when undecided / drawn-with-no-tiebreak.
 *
 * One-leg tie: the real side trusts the authoritative `score.winner` (covers ET
 * / penalties); the predicted side compares the predicted score (a draw
 * advances no one). Two-legged tie: decided only once both legs have a score —
 * by aggregate, with a level aggregate falling to the second leg's authoritative
 * winner (so an away-goals / extra-time / shootout decider still resolves).
 */
function decideWinner(
  fixtures: readonly Fixture[],
  legs: readonly BracketLeg[],
  view: StandingsView,
): 'a' | 'b' | null {
  if (fixtures.length <= 1) {
    const f = fixtures[0];
    if (view === 'real') {
      const w = f.score?.winner;
      return w === 'HOME' ? 'a' : w === 'AWAY' ? 'b' : null;
    }
    const { a, b } = legs[0];
    if (a === null || b === null) return null;
    return a > b ? 'a' : b > a ? 'b' : null;
  }

  // Two-legged: wait until both legs have a score before declaring a winner.
  if (legs.some((l) => l.a === null || l.b === null)) return null;
  const aggA = legs.reduce((n, l) => n + (l.a ?? 0), 0);
  const aggB = legs.reduce((n, l) => n + (l.b ?? 0), 0);
  if (aggA > aggB) return 'a';
  if (aggB > aggA) return 'b';
  if (view !== 'real') return null;
  // Level aggregate — defer to the authoritative second-leg winner. The second
  // leg is hosted by side B, so HOME there is B and AWAY is A.
  const w = fixtures[fixtures.length - 1].score?.winner;
  return w === 'HOME' ? 'b' : w === 'AWAY' ? 'a' : null;
}
