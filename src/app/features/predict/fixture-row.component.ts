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
  host: {
    // Compact variant — tighter padding + smaller score widget, for embeds
    // like the predict-next card where vertical space is at a premium.
    '[class.compact]': 'compact()',
  },
})
export class FixtureRowComponent {
  readonly fixture = input.required<Fixture>();
  readonly prediction = input<MatchPrediction | null>(null);
  /** When true (default), the row saves the pick automatically a beat after
   *  the score changes. Set false to defer saving to an explicit `save()`
   *  call — e.g. the predict-next card persists only when you press Next. */
  readonly autoSave = input(true);
  /** Compact layout (tighter padding, smaller score widget + meta) for
   *  space-constrained embeds like the predict-next card. */
  readonly compact = input(false);
  /** Seed an unpredicted, editable fixture's score inputs at 0–0 instead of
   *  blank — a baseline to step from in the predict-next card. The main list
   *  keeps blank inputs so an untouched match still reads as "not predicted". */
  readonly defaultToZero = input(false);

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

  /**
   * Score to display: ESPN's live score while the match is in progress
   * (football-data's free tier lags the running score), otherwise the
   * authoritative full-time score. Display-only — `predictionResult`'s
   * points still finalise off the authoritative score at FT, and this never
   * touches lock state.
   */
  protected readonly displayScore = computed(() => {
    const f = this.fixture();
    if (f.liveState === 'in' && f.liveScore) return f.liveScore;
    return f.score?.fullTime ?? null;
  });
  protected readonly hasDisplayScore = computed(() => this.displayScore() !== null);

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
    const f = this.fixture();
    // ESPN reports the match in progress — surface it (with ESPN's live
    // clock) even if the authoritative status hasn't flipped yet on the
    // free tier. Display-only; never gates editing or locking.
    if (f.liveState === 'in') {
      const clock = f.liveClock?.trim();
      return { label: clock && clock.length > 0 ? clock : 'Live', icon: '', tone: 'live' };
    }
    switch (f.status) {
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
    const actual = this.displayScore();
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
      // Blank by default; 0 when `defaultToZero` is on and the fixture is
      // actually editable (don't show a phantom 0–0 on a locked/TBD match).
      const editable = !locked && !this.tbd();
      const fallback = this.defaultToZero() && editable ? 0 : null;
      this.form.patchValue(
        {
          home: p?.homeScore ?? fallback,
          away: p?.awayScore ?? fallback,
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
      .subscribe(() => {
        if (this.autoSave()) void this.save();
      });
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

  /**
   * Persist the current score when it's a complete, changed, editable pick
   * (no-op otherwise). Public so a parent that defers saving can trigger it —
   * the predict-next card calls this on "Next". The debounced auto-save path
   * calls it too when `autoSave` is on (the default).
   */
  async save(): Promise<void> {
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
