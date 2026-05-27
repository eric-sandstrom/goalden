import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { Fixture, isLocked, isTbd } from '../../core/models/fixture.model';
import {
  MatchPrediction,
  PredictionsService,
} from '../../core/services/predictions.service';

@Component({
  selector: 'app-fixture-row',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatIconModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './fixture-row.component.html',
  styleUrl: './fixture-row.component.scss',
})
export class FixtureRowComponent {
  readonly fixture = input.required<Fixture>();
  readonly prediction = input<MatchPrediction | null>(null);

  private readonly predictions = inject(PredictionsService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);
  private readonly fb = inject(FormBuilder);

  private readonly nowTick = signal(Date.now());

  protected readonly form = this.fb.nonNullable.group({
    home: this.fb.nonNullable.control<number | null>(null, [
      Validators.min(0),
      Validators.max(99),
    ]),
    away: this.fb.nonNullable.control<number | null>(null, [
      Validators.min(0),
      Validators.max(99),
    ]),
  });

  protected readonly locked = computed(() => isLocked(this.fixture(), new Date(this.nowTick())));

  /** True when either team is undecided (knockout match before bracket
   *  resolves). Drives input disabling + the dedicated status label. */
  protected readonly tbd = computed(() => isTbd(this.fixture()));

  /** Score inputs and step buttons are non-editable when the fixture is
   *  either locked (past kickoff / in play / finished) or TBD (no teams
   *  yet to bet on). The two states show different status copy but share
   *  the same widget styling. */
  protected readonly editDisabled = computed(() => this.locked() || this.tbd());

  protected readonly kickoffLabel = computed(() =>
    this.fixture().utcKickoff.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  );

  protected readonly lockChip = computed<{
    label: string;
    icon: string;
    tone: 'warn' | 'neutral';
  } | null>(() => {
    const f = this.fixture();
    const now = this.nowTick();
    const msToKickoff = f.utcKickoff.getTime() - now;
    if (f.status !== 'TIMED') {
      return { label: 'Locked', icon: 'lock', tone: 'neutral' };
    }
    if (msToKickoff > 0 && msToKickoff <= 60 * 60 * 1000) {
      const mins = Math.max(1, Math.ceil(msToKickoff / 60000));
      return { label: `Locks in ${mins}m`, icon: 'timer', tone: 'warn' };
    }
    return null;
  });

  /** Actual full-time score from the API, when populated. */
  protected readonly actualScore = computed(() => this.fixture().score?.fullTime ?? null);
  protected readonly hasActualScore = computed(() => this.actualScore() !== null);

  /**
   * Live/HT/FT badge derived from fixture status. Takes precedence over the
   * lock chip in the centered status line — if the match is in play we
   * surface that instead of a generic "Locked" pill.
   */
  protected readonly liveStatus = computed<{
    label: string;
    icon: string;
    tone: 'live' | 'pause' | 'final';
  } | null>(() => {
    switch (this.fixture().status) {
      case 'IN_PLAY':
        return { label: 'Live', icon: '', tone: 'live' };
      case 'PAUSED':
        return { label: 'HT', icon: 'pause_circle', tone: 'pause' };
      case 'FINISHED':
      case 'AWARDED':
        return { label: 'FT', icon: 'sports_soccer', tone: 'final' };
      default:
        return null;
    }
  });

  /**
   * How the user's prediction stacks up against the current actual score.
   * Returns null if there's no prediction or no actual score yet. The points
   * shown are provisional until the match finishes (we recompute the same
   * way the server scoring engine does: exact = 3, outcome = 1, miss = 0).
   */
  protected readonly predictionResult = computed<{
    category: 'exact' | 'outcome' | 'miss';
    label: string;
    points: number;
    icon: string;
  } | null>(() => {
    const actual = this.actualScore();
    const pred = this.prediction();
    if (!actual || !pred) return null;
    if (pred.homeScore === actual.home && pred.awayScore === actual.away) {
      return { category: 'exact', label: 'Exact', points: 3, icon: 'check_circle' };
    }
    const actualWinner =
      actual.home > actual.away ? 'HOME' : actual.home < actual.away ? 'AWAY' : 'DRAW';
    const predWinner =
      pred.homeScore > pred.awayScore ? 'HOME' : pred.homeScore < pred.awayScore ? 'AWAY' : 'DRAW';
    if (actualWinner === predWinner) {
      return { category: 'outcome', label: 'Outcome', points: 1, icon: 'check' };
    }
    return { category: 'miss', label: 'Miss', points: 0, icon: 'close' };
  });

  constructor() {
    effect(() => {
      // Track the fixture identity explicitly. Otherwise, when the parent
      // component swaps the [fixture] input to a different fixture whose
      // prediction is also null (or has the same numeric shape), neither
      // `prediction()` nor `locked()` change identity, the effect doesn't
      // re-run, and the form keeps showing the previous fixture's values.
      void this.fixture().id;

      const p = this.prediction();
      const locked = this.locked();
      this.form.patchValue(
        {
          home: p?.homeScore ?? null,
          away: p?.awayScore ?? null,
        },
        { emitEvent: false },
      );
      // Disable the form when the fixture is locked OR has TBD teams.
      // Read tbd() here so the effect re-runs if the fixture flips from
      // TBD → resolved (e.g. bracket fills in).
      if (locked || this.tbd()) {
        this.form.disable({ emitEvent: false });
      } else {
        this.form.enable({ emitEvent: false });
      }
    });

    const sub = this.form.valueChanges
      .pipe(debounceTime(400), distinctUntilChanged((a, b) => a.home === b.home && a.away === b.away))
      .subscribe(() => this.tryAutoSave());
    this.destroyRef.onDestroy(() => sub.unsubscribe());

    const tickInterval = setInterval(() => this.nowTick.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(tickInterval));
  }

  protected step(field: 'home' | 'away', delta: number): void {
    if (this.editDisabled()) return;
    const control = this.form.controls[field];
    const raw = control.value;
    // First +/- press from an empty input just establishes 0 — don't apply
    // the delta yet. Lets the user see the field initialize before stepping.
    if (typeof raw !== 'number') {
      control.setValue(0);
      return;
    }
    const next = Math.max(0, Math.min(99, raw + delta));
    if (next === raw) return;
    control.setValue(next);
  }

  private async tryAutoSave(): Promise<void> {
    if (this.editDisabled()) return;
    const { home, away } = this.form.getRawValue();
    if (home === null || away === null) return;
    if (!Number.isInteger(home) || !Number.isInteger(away)) return;
    if (home < 0 || home > 99 || away < 0 || away > 99) return;

    const existing = this.prediction();
    if (existing && existing.homeScore === home && existing.awayScore === away) return;

    try {
      await this.predictions.savePrediction(this.fixture().id, home, away);
      this.snackBar.open('Saved', undefined, { duration: 1200 });
    } catch (e: unknown) {
      this.snackBar.open('Save failed', 'Dismiss', { duration: 4000 });
      console.error('Prediction save failed', e);
    }
  }
}
