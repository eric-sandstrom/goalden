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
  template: `
    <div class="row">
      @if (fixture().homeTeam.crest) {
        <div
          class="crest-bg home"
          [style.background-image]="'url(' + fixture().homeTeam.crest + ')'"
          aria-hidden="true"
        ></div>
      }
      @if (fixture().awayTeam.crest) {
        <div
          class="crest-bg away"
          [style.background-image]="'url(' + fixture().awayTeam.crest + ')'"
          aria-hidden="true"
        ></div>
      }
      <div class="match">
        @if (fixture().homeTeam.id !== null) {
          <a
            class="team home team-link"
            [routerLink]="['/teams', 'fd-' + fixture().homeTeam.id]"
          >
            <span class="name">{{ fixture().homeTeam.name ?? fixture().homeTeam.tla ?? 'TBD' }}</span>
          </a>
        } @else {
          <div class="team home">
            <span class="name">{{ fixture().homeTeam.name ?? fixture().homeTeam.tla ?? 'TBD' }}</span>
          </div>
        }

        @if (actualScore(); as actual) {
          <div
            class="result-board"
            [class.live]="liveStatus()?.tone === 'live'"
            [class.final]="liveStatus()?.tone === 'final'"
          >
            <span class="result-num">{{ actual.home }}</span>
            <span class="result-sep">–</span>
            <span class="result-num">{{ actual.away }}</span>
          </div>
        } @else {
          <form [formGroup]="form" class="scores">
            <div class="score-box home" [class.locked]="editDisabled()">
              <div class="step-stack">
                <button
                  type="button"
                  class="step-btn"
                  (click)="step('home', 1)"
                  [disabled]="editDisabled()"
                  aria-label="Increase home score"
                >
                  <mat-icon>add</mat-icon>
                </button>
                <button
                  type="button"
                  class="step-btn"
                  (click)="step('home', -1)"
                  [disabled]="editDisabled()"
                  aria-label="Decrease home score"
                >
                  <mat-icon>remove</mat-icon>
                </button>
              </div>
              <input
                class="score-input"
                type="number"
                inputmode="numeric"
                min="0"
                max="99"
                formControlName="home"
                [readonly]="editDisabled()"
                aria-label="Home score"
              />
            </div>
            <span class="sep">-</span>
            <div class="score-box away" [class.locked]="editDisabled()">
              <input
                class="score-input"
                type="number"
                inputmode="numeric"
                min="0"
                max="99"
                formControlName="away"
                [readonly]="editDisabled()"
                aria-label="Away score"
              />
              <div class="step-stack">
                <button
                  type="button"
                  class="step-btn"
                  (click)="step('away', 1)"
                  [disabled]="editDisabled()"
                  aria-label="Increase away score"
                >
                  <mat-icon>add</mat-icon>
                </button>
                <button
                  type="button"
                  class="step-btn"
                  (click)="step('away', -1)"
                  [disabled]="editDisabled()"
                  aria-label="Decrease away score"
                >
                  <mat-icon>remove</mat-icon>
                </button>
              </div>
            </div>
          </form>
        }

        @if (fixture().awayTeam.id !== null) {
          <a
            class="team away team-link"
            [routerLink]="['/teams', 'fd-' + fixture().awayTeam.id]"
          >
            <span class="name">{{ fixture().awayTeam.name ?? fixture().awayTeam.tla ?? 'TBD' }}</span>
          </a>
        } @else {
          <div class="team away">
            <span class="name">{{ fixture().awayTeam.name ?? fixture().awayTeam.tla ?? 'TBD' }}</span>
          </div>
        }
      </div>

      @if (hasActualScore()) {
        <div class="result-strip">
          @if (prediction(); as p) {
            <span class="pick">
              Your pick: <strong>{{ p.homeScore }}–{{ p.awayScore }}</strong>
            </span>
            @if (predictionResult(); as r) {
              <span class="result-chip" [attr.data-category]="r.category">
                <mat-icon class="result-chip-icon" aria-hidden="true">{{ r.icon }}</mat-icon>
                {{ r.label }}
                @if (liveStatus()?.tone === 'final') {
                  · +{{ r.points }} pt{{ r.points === 1 ? '' : 's' }}
                }
              </span>
            }
          } @else {
            <span class="no-pick">
              <mat-icon class="result-chip-icon" aria-hidden="true">do_not_disturb</mat-icon>
              No prediction
            </span>
          }
        </div>
      }

      <div class="meta">
        @if (tbd()) {
          <span class="status tbd">
            <mat-icon class="status-icon" aria-hidden="true">hourglass_empty</mat-icon>
            Teams TBD · {{ kickoffLabel() }}
          </span>
        } @else if (liveStatus(); as live) {
          <span class="status" [class.live]="live.tone === 'live'" [class.final]="live.tone === 'final'">
            @if (live.tone === 'live') {
              <span class="live-dot" aria-hidden="true"></span>
            } @else {
              <mat-icon class="status-icon" aria-hidden="true">{{ live.icon }}</mat-icon>
            }
            {{ live.label }} · {{ kickoffLabel() }}
          </span>
        } @else if (lockChip(); as chip) {
          @if (chip.tone === 'warn') {
            <span class="status warn">
              <mat-icon class="status-icon" aria-hidden="true">{{ chip.icon }}</mat-icon>
              {{ chip.label }}
            </span>
          } @else {
            <span class="status locked">
              <mat-icon class="status-icon" aria-hidden="true">{{ chip.icon }}</mat-icon>
              {{ kickoffLabel() }}
            </span>
          }
        } @else {
          <span class="status">
            <mat-icon class="status-icon" aria-hidden="true">schedule</mat-icon>
            {{ kickoffLabel() }}
          </span>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    :host:last-of-type { border-bottom: none; }
    :host:nth-of-type(even) { background: var(--mat-sys-surface-container-low); }
    .row {
      padding: 0.75rem 1rem;
      position: relative;
      overflow: hidden;
    }
    /* Big team crest backgrounds. Sit behind content, fade toward the
       center of the row, get clipped by .row overflow:hidden. */
    .crest-bg {
      position: absolute;
      top: 50%;
      width: 140px;
      height: 140px;
      background-size: cover;
      background-repeat: no-repeat;
      background-position: center;
      opacity: 0.32;
      pointer-events: none;
      z-index: 0;
      transform: translateY(-50%);
    }
    /* mask-image only reads the alpha channel — the colour itself is
       irrelevant. We use --mat-sys-on-surface instead of a hardcoded
       black so the file is free of literal colours, but functionally
       any fully opaque value would behave identically. */
    .crest-bg.home {
      left: -28px;
      mask-image: linear-gradient(to right, var(--mat-sys-on-surface) 0%, var(--mat-sys-on-surface) 30%, transparent 100%);
      -webkit-mask-image: linear-gradient(to right, var(--mat-sys-on-surface) 0%, var(--mat-sys-on-surface) 30%, transparent 100%);
    }
    .crest-bg.away {
      right: -28px;
      mask-image: linear-gradient(to left, var(--mat-sys-on-surface) 0%, var(--mat-sys-on-surface) 30%, transparent 100%);
      -webkit-mask-image: linear-gradient(to left, var(--mat-sys-on-surface) 0%, var(--mat-sys-on-surface) 30%, transparent 100%);
    }
    .match,
    .result-strip,
    .meta {
      position: relative;
      z-index: 1;
    }
    .match {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 0.75rem;
    }
    .team {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-weight: 600;
      min-width: 0;
    }
    .team.home { justify-content: flex-start; }
    .team.away { justify-content: flex-end; }
    /* Anchor variant — applied when the team has an id and we can deep-link
       to its profile. Subtle hover state hints at interactivity without
       fighting the row's visual rhythm. */
    a.team-link {
      color: inherit;
      text-decoration: none;
      border-radius: 6px;
      padding: 2px 4px;
      margin: -2px -4px;
      transition: background-color 120ms ease;
    }
    a.team-link:hover {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
    }
    a.team-link:active {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 12%, transparent);
    }
    a.team-link:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: 1px;
    }
    .name {
      font-size: 0.95rem;
      letter-spacing: 0.02em;
      overflow-wrap: break-word;
      hyphens: auto;
    }
    /* On narrow screens the score widget no longer fits between two full team
       names. Stack the layout: names on the top row split left/right, scores
       centered on a second row below. */
    @media (max-width: 420px) {
      .match {
        grid-template-areas:
          'home away'
          'scores scores';
        grid-template-columns: 1fr 1fr;
        gap: 0.5rem 0.75rem;
      }
      .team.home { grid-area: home; }
      .team.away { grid-area: away; }
      .scores,
      .result-board { grid-area: scores; justify-self: center; padding-top: 0.25rem; }
      .name { font-size: 0.9rem; }
    }
    .scores {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .score-box {
      display: inline-flex;
      align-items: stretch;
      height: 48px;
      border: 1px solid var(--mat-sys-outline);
      border-radius: 8px;
      overflow: hidden;
      background: var(--mat-sys-surface);
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .score-box:focus-within {
      border-color: var(--mat-sys-primary);
      box-shadow: 0 0 0 1px var(--mat-sys-primary);
    }
    .score-box.locked {
      opacity: 0.7;
      background: var(--mat-sys-surface-container);
    }
    .step-stack {
      display: flex;
      flex-direction: column;
      width: 24px;
    }
    .score-box.home .step-stack {
      border-right: 1px solid var(--mat-sys-outline-variant);
    }
    .score-box.away .step-stack {
      border-left: 1px solid var(--mat-sys-outline-variant);
    }
    .step-btn {
      flex: 1 1 0;
      min-height: 0;
      width: 100%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      margin: 0;
      background: transparent;
      border: 0;
      color: var(--mat-sys-on-surface-variant);
      cursor: pointer;
      font: inherit;
    }
    .step-btn:first-child {
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .step-btn:hover:not(:disabled) {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
      color: var(--mat-sys-on-surface);
    }
    .step-btn:active:not(:disabled) {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 12%, transparent);
    }
    .step-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .step-btn mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
      line-height: 16px;
    }
    .score-input {
      width: 56px;
      border: 0;
      outline: 0;
      background: transparent;
      text-align: center;
      font-variant-numeric: tabular-nums;
      font-weight: 600;
      font-size: 1rem;
      color: inherit;
      padding: 0;
      font-family: inherit;
    }
    .score-input:focus {
      outline: none;
    }
    .score-input::-webkit-inner-spin-button,
    .score-input::-webkit-outer-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    .score-input[type='number'] {
      -moz-appearance: textfield;
      appearance: textfield;
    }
    .sep {
      font-weight: 700;
      color: var(--mat-sys-on-surface-variant);
    }
    .meta {
      display: flex;
      align-items: center;
      justify-content: center;
      margin-top: 0.5rem;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--mat-sys-on-surface-variant);
      font-size: 0.85rem;
    }
    .status.warn {
      color: var(--mat-sys-tertiary);
      font-weight: 600;
    }
    .status.tbd {
      /* Muted neutral — convey "not actionable yet" without yelling. */
      color: var(--mat-sys-on-surface-variant);
      font-style: italic;
    }
    .status.live {
      color: var(--mat-sys-error);
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .status.final {
      font-weight: 600;
    }
    .status-icon {
      width: 16px;
      height: 16px;
      font-size: 16px;
    }
    .live-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--mat-sys-error);
      animation: live-pulse 1.4s ease-in-out infinite;
    }
    @keyframes live-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.35); }
    }
    /* Scoreboard view (shown when the match has an actual score). No outline
       box — the numbers themselves carry the visual weight, contrasting with
       the boxed editable prediction widget. */
    .result-board {
      display: inline-flex;
      align-items: center;
      gap: 0.55rem;
      padding: 0 0.25rem;
    }
    .result-num {
      font-size: 1.8rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1;
      min-width: 1.2ch;
      text-align: center;
      color: var(--mat-sys-on-surface);
    }
    .result-board.live .result-num { color: var(--mat-sys-primary); }
    .result-sep {
      font-weight: 700;
      color: var(--mat-sys-on-surface-variant);
    }
    /* Prediction recap row below the match, only shown when there's a real
       score to compare against. */
    .result-strip {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.4rem;
      font-size: 0.8rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .pick strong {
      color: var(--mat-sys-on-surface);
      font-variant-numeric: tabular-nums;
    }
    .no-pick {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-style: italic;
    }
    .result-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      font-weight: 600;
      font-size: 0.75rem;
      line-height: 1.4;
    }
    .result-chip[data-category='exact'] {
      background: color-mix(in srgb, var(--mat-sys-primary) 18%, transparent);
      color: var(--mat-sys-primary);
    }
    .result-chip[data-category='outcome'] {
      background: color-mix(in srgb, var(--mat-sys-tertiary) 20%, transparent);
      color: var(--mat-sys-tertiary);
    }
    .result-chip[data-category='miss'] {
      background: color-mix(in srgb, var(--mat-sys-error) 16%, transparent);
      color: var(--mat-sys-error);
    }
    .result-chip-icon {
      width: 14px;
      height: 14px;
      font-size: 14px;
      line-height: 14px;
    }
  `,
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
