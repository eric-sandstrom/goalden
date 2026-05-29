import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  resource,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Fixture } from '../../core/models/fixture.model';
import {
  CompetitionStandings,
  StandingRow,
  StandingsTable,
} from '../../core/models/standings.model';
import { CompetitionsService } from '../../core/services/competitions.service';
import { FixturesService } from '../../core/services/fixtures.service';
import { PredictedStandingsService } from '../../core/services/predicted-standings.service';
import { MatchPrediction, PredictionsService } from '../../core/services/predictions.service';
import { StandingsService } from '../../core/services/standings.service';

export type StandingsView = 'predicted' | 'real';

/** A standings row paired with how far it has moved from the real table —
 *  positive = the prediction ranks this team higher than reality. `null` on
 *  the real side and for teams absent from the real table. */
interface RankedRow {
  readonly row: StandingRow;
  readonly delta: number | null;
}

/** Empty predictions map — drives the zeroed real-standings fallback (compute
 *  with no predictions seeds every team at 0, applying only finished results). */
const NO_PREDICTIONS: ReadonlyMap<string, MatchPrediction> = new Map();

/**
 * A single standings table — the reusable building block. Self-loads from a
 * competition id (+ optional season/group), renders ONE table for ONE view,
 * and adds nothing around it: no card, no header, no view picker. Wrap it in
 * a card / add a heading / supply the Predicted-vs-Actual `view` from outside.
 *
 *   <app-standings-table [competitionId]="'PL'" [view]="'real'" />
 *   <app-standings-table [competitionId]="'WC'" [group]="'A'" [view]="view()" />
 *
 * The predicted view shows a movement arrow vs the real table; the real view
 * falls back to a zeroed table seeded from fixtures when no standings have
 * been polled yet.
 */
@Component({
  selector: 'app-standings-table',
  imports: [MatButtonModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './standings-table.component.html',
  styleUrl: './standings-table.component.scss',
})
export class StandingsTableComponent {
  private readonly standingsService = inject(StandingsService);
  private readonly predictedStandings = inject(PredictedStandingsService);
  private readonly fixturesService = inject(FixturesService);
  private readonly predictions = inject(PredictionsService);
  private readonly competitions = inject(CompetitionsService);

  readonly competitionId = input.required<string>();
  /** Optional — derived from the catalogue's current season when omitted. */
  readonly season = input<string>('');
  /** Which group's table to render. Omit (null) for a single-table league. */
  readonly group = input<string | null>(null);
  /** Predicted (from the user's picks) or real (polled) standings. */
  readonly view = input<StandingsView>('predicted');
  /** Team ids to highlight — typically the next match up for prediction.
   *  Matching rows get a highlight, and the table scrolls to them when the
   *  set changes. */
  readonly highlightTeamIds = input<readonly number[]>([]);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  // Coalesce to [] — the router's component-input binding can hand an
  // unbound input `undefined`, overriding the declared default.
  protected readonly highlightSet = computed(() => new Set(this.highlightTeamIds() ?? []));

  constructor() {
    // Scroll the highlighted row into view when the highlight set changes
    // (e.g. the predict-next card advances to a different match). Reading
    // `rows()` too lets it retry once the table has actually rendered. Guard
    // on a key so live data updates (same highlight) don't re-scroll.
    let lastKey = '';
    effect(() => {
      const ids = this.highlightTeamIds() ?? [];
      void this.rows();
      const key = ids.join(',');
      if (!key || key === lastKey) return;
      if (typeof requestAnimationFrame === 'undefined') return;
      requestAnimationFrame(() => {
        const el = this.host.nativeElement.querySelector<HTMLElement>('tr.highlight');
        if (!el) return; // not rendered yet — a later run (rows change) retries
        lastKey = key;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    });
  }

  protected readonly effectiveSeason = computed<string>(() => {
    const explicit = this.season();
    if (explicit) return explicit;
    const start = this.competitions.byId(this.competitionId())?.currentSeason?.startDate;
    return start && start.length >= 4 ? start.slice(0, 4) : '';
  });

  // --- Real standings (resource) --------------------------------------------

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
  private readonly hasRealData = computed(() => {
    const v = this.realResource.value();
    return !!v && v.tables.length > 0;
  });

  // --- Fixtures + predicted standings ---------------------------------------

  /** The comp's fixtures — `fixturesFor` is safe inside a computed (side
   *  effects deferred) and reading `_all` flows live scores through. */
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

  /** Real tables to render: genuine polled standings, else a zeroed table
   *  seeded from fixtures (every team at 0 pre-tournament). */
  private readonly realDisplayTables = computed<readonly StandingsTable[]>(() => {
    const real = this.realResource.value();
    if (real && real.tables.length > 0) return real.tables;
    const season = this.effectiveSeason();
    const fixtures = this.compFixtures();
    if (!season || fixtures.length === 0) return [];
    return this.predictedStandings.compute(this.competitionId(), season, fixtures, NO_PREDICTIONS)
      .tables;
  });

  /** `${group}:${teamId}` → real position, for the predicted side's delta.
   *  Genuine real data only, so the zeroed fallback never produces arrows. */
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

  /** The rows to render — the requested group's table for the chosen view. */
  protected readonly rows = computed<readonly RankedRow[]>(() => {
    const g = this.group() ?? null;
    if (this.view() === 'predicted') {
      const table = this.predicted()?.tables.find((t) => (t.group ?? null) === g);
      if (!table) return [];
      const index = this.realPositionIndex();
      return table.rows.map((row) => ({ row, delta: deltaFor(index, g, row) }));
    }
    const table = this.realDisplayTables().find((t) => (t.group ?? null) === g);
    return table ? table.rows.map((row) => ({ row, delta: null })) : [];
  });

  protected readonly loading = computed(() => {
    if (this.view() === 'real') {
      if (this.realResource.isLoading()) return true;
      if (this.hasRealData()) return false;
      return !this.fixturesLoaded(); // waiting on the zeroed fallback's fixtures
    }
    return !this.fixturesLoaded();
  });

  /** Real-side load error (predicted view never blocks on the real fetch). */
  protected readonly errored = computed(() => this.view() === 'real' && this.realError());

  protected readonly empty = computed(
    () => !this.loading() && !this.errored() && this.rows().length === 0,
  );

  protected retry(): void {
    this.realResource.reload();
  }

  /** Magnitude of a position delta, for display next to the arrow. */
  protected abs(n: number): number {
    return Math.abs(n);
  }
}

function deltaFor(
  realIndex: ReadonlyMap<string, number>,
  group: string | null,
  row: StandingRow,
): number | null {
  if (row.team.id === null) return null;
  const realPos = realIndex.get(`${group ?? ''}:${row.team.id}`);
  if (realPos == null) return null;
  // Real position minus predicted: +n means the prediction has the team n
  // places higher (better) than reality.
  return realPos - row.position;
}
