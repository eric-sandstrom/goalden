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

/** A single knockout match. `winner` is the side that advances — derived from
 *  the predicted score on the predicted side (a draw advances no one), and from
 *  the authoritative `score.winner` on the real side (so it reflects extra
 *  time / penalties, which the full-time score alone wouldn't). */
interface BracketMatch {
  readonly id: string;
  readonly home: BracketTeam;
  readonly away: BracketTeam;
  readonly homeScore: number | null;
  readonly awayScore: number | null;
  readonly winner: 'home' | 'away' | null;
}

interface BracketRound {
  readonly stage: string;
  readonly label: string;
  readonly matches: readonly BracketMatch[];
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
      const matches = fixtures
        .filter((f) => f.stage === stage)
        // Kickoff order ≈ bracket order; gives a stable, sensible column layout
        // even before teams are decided.
        .slice()
        .sort((a, b) => a.utcKickoff.getTime() - b.utcKickoff.getTime())
        .map((f) => toMatch(f, preds, view));
      if (matches.length > 0) rounds.push({ stage, label, matches });
    }
    return rounds;
  });

  protected readonly thirdPlace = computed<BracketMatch | null>(() => {
    const f = this.compFixtures().find((x) => x.stage === 'THIRD_PLACE');
    return f ? toMatch(f, this.predictions.matchPredictions(), this.view()) : null;
  });

  protected readonly empty = computed(() => this.rounds().length === 0 && !this.thirdPlace());
}

function toBracketTeam(t: Team): BracketTeam {
  return { id: t.id, tla: t.tla, name: t.name, crest: t.crest };
}

function toMatch(
  f: Fixture,
  preds: ReadonlyMap<string, MatchPrediction>,
  view: StandingsView,
): BracketMatch {
  const base = { id: f.id, home: toBracketTeam(f.homeTeam), away: toBracketTeam(f.awayTeam) };

  if (view === 'real') {
    const ft =
      (f.status === 'FINISHED' || f.status === 'AWARDED') && f.score?.fullTime
        ? f.score.fullTime
        : null;
    // Use the authoritative winner (covers ET/penalties), not just full-time.
    const w = f.score?.winner;
    const winner = w === 'HOME' ? 'home' : w === 'AWAY' ? 'away' : null;
    return { ...base, homeScore: ft?.home ?? null, awayScore: ft?.away ?? null, winner };
  }

  // Predicted: the user's pick, else the real result for a finished match they
  // didn't predict (mirrors PredictedStandingsService's effective-result rule).
  // Gates on status, not raw fullTime presence — football-data puts the live
  // score in fullTime during play; the cancelled-but-played case is already
  // normalised to FINISHED upstream by the poller.
  const p = preds.get(f.id);
  let score: { home: number; away: number } | null = null;
  if (p) {
    score = { home: p.homeScore, away: p.awayScore };
  } else if ((f.status === 'FINISHED' || f.status === 'AWARDED') && f.score?.fullTime) {
    score = { home: f.score.fullTime.home, away: f.score.fullTime.away };
  }
  let winner: 'home' | 'away' | null = null;
  if (score) {
    if (score.home > score.away) winner = 'home';
    else if (score.away > score.home) winner = 'away';
  }
  return { ...base, homeScore: score?.home ?? null, awayScore: score?.away ?? null, winner };
}
