import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
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
import { Fixture, LegInfo, isLocked, isTbd } from '../../core/models/fixture.model';
import { MatchTransitionService } from '../../core/services/match-transition.service';
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
    // Live accent — tints the row + adds a left bar while a match is in play.
    '[class.live]': 'isLive()',
  },
})
export class FixtureRowComponent {
  readonly fixture = input.required<Fixture>();
  readonly prediction = input<MatchPrediction | null>(null);
  /** Set when this fixture is one leg of a two-legged knockout tie — drives the
   *  "1st leg" / "2nd leg" badge. Null for single-match knockouts and groups. */
  readonly leg = input<LegInfo | null>(null);
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
  private readonly matchTransition = inject(MatchTransitionService);
  private readonly cdr = inject(ChangeDetectorRef);

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

  /** The bare football-data id (our doc id minus the `fd-` prefix) — the
   *  segment the `/matches/:id` detail route expects. */
  protected readonly detailFdid = computed(() => this.fixture().id.replace(/^fd-/, ''));

  /** True when this row is the one morphing into the detail view, so it should
   *  paint the shared `view-transition-name`s. Only ever one row at a time —
   *  the names must stay unique across the page during a transition. */
  protected readonly sharedTransition = computed(
    () => this.matchTransition.activeFdid() === this.detailFdid(),
  );

  /** Claim the shared transition for this fixture just before the detail
   *  navigation, so this row's score/crest/name carry the paired names into
   *  the outgoing (list) snapshot.
   *
   *  The synchronous `detectChanges()` is load-bearing: routerLink kicks off
   *  navigation and the router captures the OLD (list) snapshot for the view
   *  transition before zoneless CD would otherwise flush this signal change to
   *  the DOM. Without it, the `view-transition-name`s aren't painted in time,
   *  the list snapshot has no shared elements, and only the back navigation
   *  morphs. Flushing here writes them synchronously, inside the click event,
   *  ahead of the snapshot. */
  protected openDetail(): void {
    this.matchTransition.activate(this.detailFdid());
    this.cdr.detectChanges();
  }

  protected readonly kickoffLabel = computed(() =>
    this.fixture().utcKickoff.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  );

  /** "1st leg" / "2nd leg" badge for a two-legged tie, with a tooltip pointing
   *  to when the other leg is played. Null when this isn't part of a tie. */
  protected readonly legBadge = computed<{ label: string; title: string } | null>(() => {
    const lg = this.leg();
    if (!lg) return null;
    const otherDate = lg.otherLegKickoff.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    return lg.leg === 1
      ? { label: '1st leg', title: `Second leg ${otherDate}` }
      : { label: '2nd leg', title: `First leg ${otherDate}` };
  });

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
   * The score we display AND grade against: the 90-minute score only —
   * extra time and penalties are ignored.
   *
   * Order: once a match has gone to extra time, `regularTime` holds the
   * after-90 score, so we show that and ignore the live/ET running score.
   * Otherwise we prefer ESPN's live score while in progress (football-data's
   * free tier lags the running score), then fall back to `fullTime` (which is
   * the 90-minute score for a match decided in regulation). Display-only —
   * never touches lock state.
   */
  protected readonly displayScore = computed(() => {
    const f = this.fixture();
    if (f.score?.regularTime) return f.score.regularTime;
    if (f.liveState === 'in' && f.liveScore) return f.liveScore;
    return f.score?.fullTime ?? null;
  });
  protected readonly hasDisplayScore = computed(() => this.displayScore() !== null);

  /**
   * Coarse live/half-time/full-time classification for the status line, by
   * precedence. Takes over from the lock chip while a match is in play.
   * Half-time is read from the authoritative PAUSED status OR ESPN's detail
   * label (the free tier's status can lag a few minutes behind ESPN), so we
   * never show a ticking minute through the interval. Display-only — never
   * gates editing or locking. The half + minute themselves come from
   * `liveProgress`.
   */
  protected readonly liveStatus = computed<{ tone: 'live' | 'pause' | 'final' } | null>(() => {
    const f = this.fixture();
    if (f.status === 'FINISHED' || f.status === 'AWARDED') return { tone: 'final' };
    const detail = (f.liveDetail ?? '').trim();
    if (f.status === 'PAUSED' || /^ht$|half.?time/i.test(detail)) return { tone: 'pause' };
    if (f.liveState === 'in' || f.status === 'IN_PLAY') return { tone: 'live' };
    return null;
  });

  /** True while the match is actively playing (not pre-match, HT, or FT).
   *  Drives the row's live accent. */
  protected readonly isLive = computed(() => this.liveStatus()?.tone === 'live');

  /**
   * Which half + the match minute for an actively-playing match.
   *
   * Shows the authoritative minute as last synced by the poller — there is NO
   * client-clock extrapolation. (An earlier version anchored football-data's
   * `minute` to `lastSyncedAt` and ticked it forward off the device clock for a
   * "smooth" count, but that drifts and depends on the device clock being
   * correct — it's not the real match time.) Source precedence mirrors the
   * detail view's `statusLabel`, so the row and the open match agree:
   *
   *   1. football-data's authoritative `minute` (+ `injuryTime` stoppage) —
   *      caps at 45/90/120, so the value alone picks the half;
   *   2. ESPN's display clock (`liveClock`, e.g. "67'") when football-data has
   *      no minute — the half is derived from its leading number.
   *
   * Both refresh on each ~2-min poll via the live `onSnapshot`. Null when
   * neither source has a value (the template falls back to a bare "Live") and
   * whenever not mid-play — `liveStatus` routes half-time and full-time.
   */
  protected readonly liveProgress = computed<{ half: string; minute: string } | null>(() => {
    if (this.liveStatus()?.tone !== 'live') return null;
    const f = this.fixture();

    if (typeof f.minute === 'number') {
      return formatLiveMinute(f.minute, f.injuryTime ?? 0);
    }

    const clock = (f.liveClock ?? '').trim();
    if (clock) {
      const n = parseInt(clock, 10);
      const half = !Number.isFinite(n)
        ? 'Live'
        : n <= 45
          ? '1st half'
          : n <= 90
            ? '2nd half'
            : 'Extra time';
      return { half, minute: clock.endsWith("'") ? clock : `${clock}'` };
    }

    return null;
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

/**
 * Formats football-data's authoritative `minute`/`injuryTime` into a half label
 * + display minute, exactly as last synced (no extrapolation).
 *
 * `base` caps at the half's nominal end (45/90/120) with stoppage carried in
 * `injury`, so `base` alone picks the half: e.g. base 90 + injury 4 → "90+4'"
 * in the 2nd half.
 */
function formatLiveMinute(base: number, injury: number): { half: string; minute: string } {
  const half = base <= 45 ? '1st half' : base <= 90 ? '2nd half' : 'Extra time';
  return { half, minute: injury > 0 ? `${base}+${injury}'` : `${base}'` };
}
