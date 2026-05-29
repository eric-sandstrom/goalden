import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { Fixture, isKnockout } from '../../core/models/fixture.model';
import { CompetitionsService } from '../../core/services/competitions.service';
import { FixturesService } from '../../core/services/fixtures.service';
import { BracketViewComponent } from './bracket-view.component';
import { StandingsTableComponent, StandingsView } from './standings-table.component';

/** Lower-section switch: the group/league tables vs the knockout bracket. */
type StandingsSection = 'tables' | 'bracket';

/**
 * Competition standings surface — the orchestrator around the reusable
 * `StandingsTableComponent`. It owns the Predicted / Actual picker and the
 * layout: a single table for league formats, a grid of group mini-tables for
 * tournaments. Each table self-loads; this component only needs the comp's
 * fixtures to know the group list.
 *
 * `competitionId` is required; `season` is derived from the catalogue when
 * omitted. `embedded` drops the page/card chrome so it can sit inside another
 * view (e.g. the league detail page).
 */
@Component({
  selector: 'app-standings-view',
  imports: [
    NgTemplateOutlet,
    MatButtonToggleModule,
    MatCardModule,
    MatIconModule,
    StandingsTableComponent,
    BracketViewComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './standings-view.component.html',
  styleUrl: './standings-view.component.scss',
})
export class StandingsViewComponent {
  private readonly fixturesService = inject(FixturesService);
  private readonly competitions = inject(CompetitionsService);

  readonly competitionId = input.required<string>();
  /** Optional — derived from the catalogue when not supplied. */
  readonly season = input<string>('');
  /** Drop the page/card chrome when embedded inside another view. */
  readonly embedded = input(false);
  /** Team ids to highlight (+ scroll to) — e.g. the next match up for
   *  prediction. Passed straight through to each table. */
  readonly highlightTeamIds = input<readonly number[]>([]);

  protected readonly view = signal<StandingsView>('predicted');
  /** Tables vs knockout bracket. Only relevant when the comp has knockout
   *  fixtures; the Groups/Knockouts toggle is hidden otherwise. */
  protected readonly section = signal<StandingsSection>('tables');

  constructor() {
    // Eagerly register the comp's fixtures so the group list resolves (and the
    // child tables' shared store is warm). Calling fixturesFor in an effect is
    // legal (signal writes allowed) and re-registers if the comp changes.
    effect(() => {
      const season = this.effectiveSeason();
      if (season) this.fixturesService.fixturesFor(this.competitionId(), season);
    });
  }

  protected readonly competition = computed(() => this.competitions.byId(this.competitionId()));

  protected readonly effectiveSeason = computed<string>(() => {
    const explicit = this.season();
    if (explicit) return explicit;
    const start = this.competition()?.currentSeason?.startDate;
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

  /** Distinct group labels among the comp's table-forming fixtures, sorted.
   *  Empty for league formats → a single table; non-empty → a group grid. */
  protected readonly groups = computed<readonly string[]>(() => {
    const set = new Set<string>();
    for (const f of this.compFixtures()) {
      if (!isKnockout(f.stage) && f.group) set.add(f.group);
    }
    return [...set].sort();
  });

  protected readonly isGroupMode = computed(() => this.groups().length > 0);

  /** Whether this competition has any knockout fixtures — gates the
   *  Groups/Knockouts toggle and the bracket section. */
  protected readonly hasKnockout = computed(() =>
    this.compFixtures().some((f) => isKnockout(f.stage)),
  );
}
