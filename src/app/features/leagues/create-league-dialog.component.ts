import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Competition } from '../../core/models/competition.model';
import { CompetitionsService } from '../../core/services/competitions.service';
import { FixturesService } from '../../core/services/fixtures.service';
import { LeaguesService } from '../../core/services/leagues.service';

/** Hard-coded preferred default while WC is the focal competition. Once the
 *  tournament wraps and most predictors move to domestic leagues we can swap
 *  this to use last-selected or alphabetical. */
const PREFERRED_DEFAULT_COMP_ID = 'WC';

@Component({
  selector: 'app-create-league-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './create-league-dialog.component.html',
  styleUrl: './create-league-dialog.component.scss',
})
export class CreateLeagueDialogComponent {
  private readonly leagues = inject(LeaguesService);
  private readonly competitionsService = inject(CompetitionsService);
  private readonly fixtures = inject(FixturesService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly sheetRef = inject(MatBottomSheetRef<CreateLeagueDialogComponent, string>);
  private readonly fb = inject(FormBuilder);

  protected readonly creating = signal(false);

  /** Pre-grouped by football-data `type` for the optgroup layout. CUP
   *  becomes "Tournaments" (WC, Euros, CL, EL); LEAGUE becomes "Domestic
   *  leagues" (EPL, La Liga, Bundesliga, ...). Each group is sorted by
   *  display name in CompetitionsService.
   *
   *  Uses the season-aware `selectable*` set rather than the polling-
   *  active set — surfaces upcoming comps (WC before kickoff) and
   *  drops just-ended ones (EPL between seasons). The `active` flag is
   *  intentionally not consulted here; it's purely a polling switch. */
  protected readonly groupedComps = this.competitionsService.selectableByType;
  protected readonly selectableComps = this.competitionsService.selectableCompetitions;

  /** True when no comp is available to pick. Disables the Create button
   *  with a clear inline hint rather than letting the user submit and
   *  get a server-side error. Empty state happens when (a) the comp
   *  catalogue hasn't been synced yet, or (b) every synced comp has a
   *  past-end-date season. */
  protected readonly noSelectableComps = computed(
    () => this.selectableComps().length === 0,
  );

  protected readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(40)]],
    type: ['private' as 'private' | 'public', Validators.required],
    competitionId: ['', Validators.required],
  });

  constructor() {
    // Seed the picker default once selectable comps arrive. Use WC if
    // it's among them; otherwise fall back to whatever's first
    // (alphabetical order from the service). Only sets the value if the
    // user hasn't touched it — guards against clobbering an in-progress
    // selection when the live listener re-emits.
    effect(() => {
      const selectable = this.selectableComps();
      if (selectable.length === 0) return;
      const ctrl = this.form.controls.competitionId;
      if (ctrl.touched || ctrl.value) return;
      const preferred =
        selectable.find((c) => c.id === PREFERRED_DEFAULT_COMP_ID) ?? selectable[0];
      ctrl.setValue(preferred.id);
    });

    // Eagerly trigger a fixture load for every selectable comp the
    // moment the picker renders, so the "N to predict" counts populate
    // without the user having to open the dropdown first. Each
    // fixturesFor() call is memoized and cache-backed, so this is at
    // most one rollup-doc read per comp on cold start — same cost as
    // the user picking each one manually.
    effect(() => {
      for (const comp of this.selectableComps()) {
        const season = seasonFromComp(comp);
        if (season) {
          this.fixtures.fixturesFor(comp.id, season);
        }
      }
    });
  }

  /**
   * Number of `TIMED` fixtures left to predict for the given comp.
   * Returns `null` while fixtures are still loading so the template
   * can show a placeholder instead of "0 to predict" briefly. Reads
   * the per-comp signal — recomputes naturally when polling refreshes
   * a comp's fixtures.
   */
  protected remainingForOption(comp: Competition): number | null {
    const season = seasonFromComp(comp);
    if (!season) return null;
    if (!this.fixtures.loadedFor(comp.id, season)()) return null;
    return this.fixtures
      .fixturesFor(comp.id, season)()
      .filter((f) => f.status === 'TIMED').length;
  }

  /**
   * Derived season string for the currently-picked comp. Uses the comp's
   * `currentSeason.startDate` year, falling back to the current calendar
   * year if the field is missing (would only happen on a corrupted catalogue
   * doc — keeping the fallback means we still send a request that the
   * server's validation rejects with a clean error rather than producing
   * an undefined value the snackbar can't read).
   */
  protected readonly selectedSeason = computed<string>(() => {
    const compId = this.form.controls.competitionId.value;
    if (!compId) return String(new Date().getFullYear());
    const comp = this.competitionsService.byId(compId);
    return seasonFromComp(comp) ?? String(new Date().getFullYear());
  });

  protected cancel(): void {
    this.sheetRef.dismiss();
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) return;
    this.creating.set(true);
    try {
      const value = this.form.getRawValue();
      const season = this.selectedSeason();
      const { leagueId } = await this.leagues.createLeague(
        value.name,
        value.type,
        value.competitionId,
        season,
      );
      this.sheetRef.dismiss(leagueId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not create league';
      this.snackBar.open(msg, 'Dismiss', { duration: 4000 });
    } finally {
      this.creating.set(false);
    }
  }
}

/** Extracts the starting calendar year from a competition's currentSeason.
 *  Returns null for comps without a season set (off-season state from
 *  football-data, or a freshly-discovered comp whose first sync didn't
 *  carry season metadata). */
function seasonFromComp(comp: Competition | null): string | null {
  if (!comp?.currentSeason?.startDate) return null;
  const startDate = comp.currentSeason.startDate;
  if (startDate.length < 4) return null;
  return startDate.slice(0, 4);
}
