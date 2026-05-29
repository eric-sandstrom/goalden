import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  resource,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { Fixture } from '../../core/models/fixture.model';
import { CompetitionStandings, StandingRow } from '../../core/models/standings.model';
import { CompetitionsService } from '../../core/services/competitions.service';
import { FixturesService } from '../../core/services/fixtures.service';
import { PredictedStandingsService } from '../../core/services/predicted-standings.service';
import { MatchPrediction, PredictionsService } from '../../core/services/predictions.service';
import { StandingsService } from '../../core/services/standings.service';

/** Which table is shown when both can't sit side by side — a phone (league
 *  comps) or the group-stage grid. The desktop league view shows both. */
type ViewSide = 'predicted' | 'real';

/** A standings row paired with how far it has moved from the real table —
 *  positive = the prediction ranks this team higher than reality. `null`
 *  on the real side and for teams absent from the real table. */
interface RankedRow {
  readonly row: StandingRow;
  readonly delta: number | null;
}

interface ComparedTable {
  readonly group: string | null;
  readonly rows: readonly RankedRow[];
}

/** Shared empty predictions map — drives the zeroed real-standings fallback
 *  (compute with no predictions seeds every team at 0, applying only any
 *  finished results). */
const NO_PREDICTIONS: ReadonlyMap<string, MatchPrediction> = new Map();

/**
 * Side-by-side comparison of a competition's **real** standings (polled by
 * `pollStandings`) and the user's **predicted** standings (computed from
 * their predictions). Desktop shows both tables in parallel; a phone shows
 * one at a time behind a Predicted / Actual toggle.
 *
 * Scoping inputs: `competitionId` is required (bound from the route param or
 * the embedding league). `season` is optional — when omitted (e.g. the
 * `/comp/:competitionId/standings` route only carries the id) it's derived
 * from the competition catalogue's current season.
 */
@Component({
  selector: 'app-standings-view',
  imports: [
    NgTemplateOutlet,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatIconModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './standings-view.component.html',
  styleUrl: './standings-view.component.scss',
})
export class StandingsViewComponent {
  private readonly standingsService = inject(StandingsService);
  private readonly predictedStandings = inject(PredictedStandingsService);
  private readonly fixturesService = inject(FixturesService);
  private readonly predictions = inject(PredictionsService);
  private readonly competitions = inject(CompetitionsService);

  readonly competitionId = input.required<string>();
  /** Optional — derived from the catalogue when not supplied. */
  readonly season = input<string>('');
  /** When embedded inside another routed view (e.g. league detail), drop the
   *  `.page` wrapper (so it doesn't double-pad / re-cap width) and the card
   *  header (the host already names the competition). */
  readonly embedded = input(false);

  protected readonly view = signal<ViewSide>('predicted');

  constructor() {
    // Eagerly register the comp's fixtures request once the season resolves.
    // The predicted side needs them, but the template gates it behind a
    // loading check — without this, the lazy `fixturesFor()` request (which
    // lives in `compFixtures`, only read in the loaded branch) would never
    // fire and the spinner would hang forever. Calling it from an effect is
    // legal (signal writes allowed) and re-registers if the comp changes.
    effect(() => {
      const season = this.effectiveSeason();
      if (season) this.fixturesService.fixturesFor(this.competitionId(), season);
    });
  }

  /** The competition catalogue entry, for the header (name + emblem). */
  protected readonly competition = computed(() =>
    this.competitions.byId(this.competitionId()),
  );

  /** Season to load: the explicit input, else the catalogue's current
   *  season's starting year. Empty until the catalogue resolves. */
  protected readonly effectiveSeason = computed<string>(() => {
    const explicit = this.season();
    if (explicit) return explicit;
    const start = this.competition()?.currentSeason?.startDate;
    return start && start.length >= 4 ? start.slice(0, 4) : '';
  });

  // --- Real standings (resource) --------------------------------------------

  /** Real standings loaded via a resource keyed on the stable
   *  `${compId}_${season}` string — reloads only on a real comp/season
   *  change; idle until the season resolves. */
  private readonly realResource = resource<CompetitionStandings | null, string | undefined>({
    params: () => {
      const compId = this.competitionId();
      const season = this.effectiveSeason();
      return compId && season ? `${compId}_${season}` : undefined;
    },
    loader: ({ params }) => {
      const sep = params.indexOf('_');
      return this.standingsService.loadStandings(params.slice(0, sep), params.slice(sep + 1));
    },
    defaultValue: null,
  });

  protected readonly realError = computed(() => this.realResource.status() === 'error');

  /** Genuine polled standings present (and non-empty)? Distinguishes real
   *  data from the zeroed, fixture-seeded fallback the Actual side shows
   *  before a competition has any results. */
  private readonly hasRealData = computed(() => {
    const v = this.realResource.value();
    return !!v && v.tables.length > 0;
  });

  // --- Predicted standings (computed) ---------------------------------------

  /** The comp's fixtures — `fixturesFor` is safe inside a computed (its
   *  side effects are deferred), and reading `_all` means live scores flow
   *  through automatically. */
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

  private readonly predicted = computed<CompetitionStandings | null>(() => {
    const season = this.effectiveSeason();
    if (!season) return null;
    return this.predictedStandings.compute(
      this.competitionId(),
      season,
      this.compFixtures(),
      this.predictions.matchPredictions(),
    );
  });

  protected readonly predictedEmpty = computed(() => {
    const p = this.predicted();
    return !p || p.tables.length === 0 || p.tables.every((t) => t.rows.length === 0);
  });

  // --- Paired view models ---------------------------------------------------

  /** `${group}:${teamId}` → real position, for the predicted side's delta. */
  private readonly realPositionIndex = computed<ReadonlyMap<string, number>>(() => {
    const map = new Map<string, number>();
    const real = this.realResource.value();
    if (!real) return map;
    for (const table of real.tables) {
      for (const row of table.rows) {
        if (row.team.id !== null) {
          map.set(`${table.group ?? ''}:${row.team.id}`, row.position);
        }
      }
    }
    return map;
  });

  /**
   * What the "Actual" side renders. Genuine polled standings when present;
   * otherwise a table seeded from the competition's fixtures so the structure
   * still shows (every team at 0 pre-tournament) instead of an empty state.
   * The fallback also reconstructs from any finished results — a sensible
   * stand-in when the standings doc hasn't been polled yet.
   *
   * `realPositionIndex` (the predicted side's delta source) stays bound to the
   * genuine data only, so this zeroed fallback never produces misleading
   * movement arrows.
   */
  protected readonly realDisplayTables = computed<readonly ComparedTable[]>(() => {
    if (this.hasRealData()) {
      return toComparedTables(this.realResource.value(), null);
    }
    const season = this.effectiveSeason();
    const fixtures = this.compFixtures();
    if (!season || fixtures.length === 0) return [];
    const derived = this.predictedStandings.compute(
      this.competitionId(),
      season,
      fixtures,
      NO_PREDICTIONS,
    );
    return toComparedTables(derived, null);
  });

  /** Actual-side loading: the standings fetch, or — when there's no genuine
   *  data — the fixtures the zeroed fallback is seeded from. */
  protected readonly realLoading = computed(() => {
    if (this.realResource.isLoading()) return true;
    if (this.hasRealData()) return false;
    return !this.fixturesLoaded();
  });

  protected readonly realEmpty = computed(
    () =>
      !this.realLoading() &&
      !this.realError() &&
      this.realDisplayTables().length === 0,
  );

  protected readonly predictedTables = computed<readonly ComparedTable[]>(() =>
    toComparedTables(this.predicted(), this.realPositionIndex()),
  );

  /** Group-stage comp (e.g. the WC group phase) → render a grid of group
   *  mini-tables for one view at a time rather than two full side-by-side
   *  tables (12 groups won't fit twice across). Detected from the data:
   *  any table carrying a group label. */
  protected readonly isGroupMode = computed(
    () =>
      this.predictedTables().some((t) => t.group !== null) ||
      this.realDisplayTables().some((t) => t.group !== null),
  );

  /** In group mode, the single view (predicted or real) the grid renders. */
  protected readonly activeTables = computed<readonly ComparedTable[]>(() =>
    this.view() === 'predicted' ? this.predictedTables() : this.realDisplayTables(),
  );
  protected readonly activeLoading = computed(() =>
    this.view() === 'predicted' ? !this.fixturesLoaded() : this.realLoading(),
  );
  protected readonly activeError = computed(
    () => this.view() === 'real' && this.realError(),
  );
  protected readonly activeEmpty = computed(() =>
    this.view() === 'predicted' ? this.predictedEmpty() : this.realEmpty(),
  );

  protected retry(): void {
    this.realResource.reload();
  }

  /** Magnitude of a position delta, for display next to the direction arrow. */
  protected abs(n: number): number {
    return Math.abs(n);
  }
}

/**
 * Maps a `CompetitionStandings` into the template's compared-table shape,
 * attaching a position delta vs the real table when an index is supplied
 * (predicted side) or leaving it null (real side).
 */
function toComparedTables(
  standings: CompetitionStandings | null,
  realIndex: ReadonlyMap<string, number> | null,
): ComparedTable[] {
  if (!standings) return [];
  return standings.tables.map((table) => ({
    group: table.group,
    rows: table.rows.map((row) => ({
      row,
      delta: deltaFor(realIndex, table.group, row),
    })),
  }));
}

function deltaFor(
  realIndex: ReadonlyMap<string, number> | null,
  group: string | null,
  row: StandingRow,
): number | null {
  if (!realIndex || row.team.id === null) return null;
  const realPos = realIndex.get(`${group ?? ''}:${row.team.id}`);
  if (realPos == null) return null;
  // Real position minus predicted position: +n means the prediction has the
  // team n places higher (better) than reality.
  return realPos - row.position;
}
