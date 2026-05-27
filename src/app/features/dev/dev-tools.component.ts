import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { httpsCallable } from 'firebase/functions';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FUNCTIONS } from '../../core/firebase/firebase.providers';
import { FixturesService } from '../../core/services/fixtures.service';
import { PredictionsService } from '../../core/services/predictions.service';

type FixtureStatus = 'TIMED' | 'IN_PLAY' | 'PAUSED' | 'FINISHED';

@Component({
  selector: 'app-dev-tools',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatDividerModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="container">
      <header class="hero">
        <mat-icon class="warn" aria-hidden="true">science</mat-icon>
        <div>
          <h1>Dev tools</h1>
          <p class="hint">
            Emulator only — every callable here refuses to run in production.
          </p>
        </div>
      </header>

      <!-- ===================================================================
           Fixture state control
      ==================================================================== -->
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-icon matCardAvatar>sports_soccer</mat-icon>
          <mat-card-title>Fixture state</mat-card-title>
          <mat-card-subtitle>Walk any fixture through TIMED → LIVE → HT → FT</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <form [formGroup]="stateForm" class="form">
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>Fixture</mat-label>
              <mat-select formControlName="matchId">
                @for (option of fixtureOptions(); track option.matchId) {
                  <mat-option [value]="option.matchId">{{ option.label }}</mat-option>
                }
              </mat-select>
            </mat-form-field>

            <mat-button-toggle-group
              formControlName="status"
              hideSingleSelectionIndicator
              aria-label="Target status"
            >
              <mat-button-toggle value="TIMED">Scheduled</mat-button-toggle>
              <mat-button-toggle value="IN_PLAY">Live</mat-button-toggle>
              <mat-button-toggle value="PAUSED">HT</mat-button-toggle>
              <mat-button-toggle value="FINISHED">Full time</mat-button-toggle>
            </mat-button-toggle-group>

            @if (stateForm.controls.status.value !== 'TIMED') {
              <div class="scores">
                <mat-form-field appearance="outline" subscriptSizing="dynamic" class="score">
                  <mat-label>Home</mat-label>
                  <input
                    matInput
                    type="number"
                    inputmode="numeric"
                    min="0"
                    formControlName="homeScore"
                  />
                </mat-form-field>
                <span class="sep">-</span>
                <mat-form-field appearance="outline" subscriptSizing="dynamic" class="score">
                  <mat-label>Away</mat-label>
                  <input
                    matInput
                    type="number"
                    inputmode="numeric"
                    min="0"
                    formControlName="awayScore"
                  />
                </mat-form-field>
              </div>
            }
          </form>
        </mat-card-content>
        <mat-card-actions align="end">
          <button
            mat-flat-button
            color="primary"
            [disabled]="stateForm.invalid || running()"
            (click)="applyState()"
          >
            @if (running()) {
              <mat-progress-spinner mode="indeterminate" diameter="20" />
            } @else {
              Apply state
            }
          </button>
        </mat-card-actions>
      </mat-card>

      <!-- ===================================================================
           Move kickoff
      ==================================================================== -->
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-icon matCardAvatar>schedule</mat-icon>
          <mat-card-title>Move kickoff</mat-card-title>
          <mat-card-subtitle>Test lock UX without waiting in real time</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <form [formGroup]="kickoffForm" class="form">
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>Fixture</mat-label>
              <mat-select formControlName="matchId">
                @for (option of fixtureOptions(); track option.matchId) {
                  <mat-option [value]="option.matchId">{{ option.label }}</mat-option>
                }
              </mat-select>
            </mat-form-field>

            <div class="presets">
              <button type="button" mat-stroked-button (click)="moveKickoff(2)">
                <mat-icon>timer</mat-icon> 2 min
              </button>
              <button type="button" mat-stroked-button (click)="moveKickoff(30)">
                <mat-icon>hourglass_top</mat-icon> 30 min (warn)
              </button>
              <button type="button" mat-stroked-button (click)="moveKickoff(90)">
                <mat-icon>schedule</mat-icon> 90 min
              </button>
              <button type="button" mat-stroked-button (click)="moveKickoff(60 * 24)">
                <mat-icon>event</mat-icon> 1 day
              </button>
              <button type="button" mat-stroked-button (click)="moveKickoff(-30)">
                <mat-icon>history</mat-icon> 30 min ago
              </button>
            </div>
          </form>
        </mat-card-content>
      </mat-card>

      <!-- ===================================================================
           One-click scenarios
      ==================================================================== -->
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-icon matCardAvatar>auto_fix_high</mat-icon>
          <mat-card-title>One-click scenarios</mat-card-title>
          <mat-card-subtitle>
            Operates on one of your predicted fixtures — needs at least one prediction
          </mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <form [formGroup]="scenarioForm" class="form">
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>Predicted fixture</mat-label>
              <mat-select formControlName="matchId">
                @for (option of predictedOptions(); track option.matchId) {
                  <mat-option [value]="option.matchId">{{ option.label }}</mat-option>
                }
              </mat-select>
            </mat-form-field>

            <div class="presets">
              <button
                type="button"
                mat-stroked-button
                class="scenario exact"
                [disabled]="!scenarioForm.controls.matchId.value || running()"
                (click)="scenarioFinishExact()"
              >
                <mat-icon>verified</mat-icon> FT — Exact (+3)
              </button>
              <button
                type="button"
                mat-stroked-button
                class="scenario outcome"
                [disabled]="!scenarioForm.controls.matchId.value || running()"
                (click)="scenarioFinishOutcome()"
              >
                <mat-icon>swap_horiz</mat-icon> FT — Outcome (+1)
              </button>
              <button
                type="button"
                mat-stroked-button
                class="scenario miss"
                [disabled]="!scenarioForm.controls.matchId.value || running()"
                (click)="scenarioFinishWrong()"
              >
                <mat-icon>close</mat-icon> FT — Miss (0)
              </button>
              <button
                type="button"
                mat-stroked-button
                [disabled]="!scenarioForm.controls.matchId.value || running()"
                (click)="scenarioStartLive()"
              >
                <mat-icon>play_circle</mat-icon> Kick off live 0–0
              </button>
              <button
                type="button"
                mat-stroked-button
                [disabled]="!scenarioForm.controls.matchId.value || running()"
                (click)="scenarioLockSoon()"
              >
                <mat-icon>hourglass_top</mat-icon> Lock in 30s
              </button>
            </div>
          </form>
        </mat-card-content>
      </mat-card>

      <!-- ===================================================================
           Data pollers
      ==================================================================== -->
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-icon matCardAvatar>cloud_download</mat-icon>
          <mat-card-title>Fetch from football-data</mat-card-title>
          <mat-card-subtitle>Bypass the scheduled crons</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <div class="presets">
            <button
              type="button"
              mat-stroked-button
              [disabled]="running()"
              (click)="pollFixturesNow()"
            >
              <mat-icon>sports_soccer</mat-icon> Poll fixtures
            </button>
            <button
              type="button"
              mat-stroked-button
              [disabled]="running()"
              (click)="pollTeamsNow()"
            >
              <mat-icon>groups</mat-icon> Poll teams
            </button>
          </div>
        </mat-card-content>
      </mat-card>

      <!-- ===================================================================
           Reset state
      ==================================================================== -->
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-icon matCardAvatar class="danger">restart_alt</mat-icon>
          <mat-card-title>Reset my state</mat-card-title>
          <mat-card-subtitle>Wipes only your own predictions/totals, not other users'</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <div class="presets">
            <button
              type="button"
              mat-stroked-button
              [disabled]="running()"
              (click)="resetState({ clearMatchPredictions: true })"
            >
              <mat-icon>delete_sweep</mat-icon> Clear match predictions
            </button>
            <button
              type="button"
              mat-stroked-button
              [disabled]="running()"
              (click)="resetState({ clearPodium: true })"
            >
              <mat-icon>emoji_events</mat-icon> Clear podium pick
            </button>
            <button
              type="button"
              mat-stroked-button
              [disabled]="running()"
              (click)="resetState({ resetTotals: true })"
            >
              <mat-icon>scoreboard</mat-icon> Reset totals
            </button>
            <button
              type="button"
              mat-stroked-button
              [disabled]="running()"
              (click)="clearPersonality()"
            >
              <mat-icon>auto_awesome</mat-icon> Clear personality
            </button>
            <button
              type="button"
              mat-stroked-button
              class="scenario miss"
              [disabled]="running()"
              (click)="resetState({ clearMatchPredictions: true, clearPodium: true, resetTotals: true })"
            >
              <mat-icon>warning</mat-icon> Wipe everything
            </button>
          </div>
        </mat-card-content>
      </mat-card>
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      width: 100%;
    }
    .container {
      padding: 1rem;
      /* Match the .page utility's max-width so every routed view inside
         the shell shares the same content column. */
      max-width: 720px;
      width: 100%;
      margin: 0 auto;
      overflow-y: auto;
      overscroll-behavior: contain;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .hero {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
    }
    .hero h1 {
      margin: 0;
      font: var(--mat-sys-headline-small);
    }
    .hero .hint {
      margin: 0.25rem 0 0;
      color: var(--mat-sys-on-surface-variant);
      font-size: 0.85rem;
    }
    .warn { color: var(--mat-sys-tertiary); }
    .danger { color: var(--mat-sys-error); }
    .form {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    mat-button-toggle-group { align-self: stretch; }
    .scores {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .score { flex: 1; }
    .sep { font-weight: 700; color: var(--mat-sys-on-surface-variant); }
    .presets {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .scenario.exact {
      --mdc-outlined-button-label-text-color: var(--mat-sys-primary);
      --mdc-outlined-button-outline-color:
        color-mix(in srgb, var(--mat-sys-primary) 60%, transparent);
    }
    .scenario.outcome {
      --mdc-outlined-button-label-text-color: var(--mat-sys-tertiary);
      --mdc-outlined-button-outline-color:
        color-mix(in srgb, var(--mat-sys-tertiary) 60%, transparent);
    }
    .scenario.miss {
      --mdc-outlined-button-label-text-color: var(--mat-sys-error);
      --mdc-outlined-button-outline-color:
        color-mix(in srgb, var(--mat-sys-error) 60%, transparent);
    }
  `,
})
export class DevToolsComponent {
  private readonly fixtures = inject(FixturesService);
  private readonly predictions = inject(PredictionsService);
  private readonly functions = inject(FUNCTIONS);
  private readonly snackBar = inject(MatSnackBar);
  private readonly fb = inject(FormBuilder);

  protected readonly running = signal(false);

  /** Every fixture, labelled with its current status — used by the state and
   *  kickoff cards (which need to operate on any fixture, not just ones the
   *  user has predicted). */
  protected readonly fixtureOptions = computed(() => {
    return this.fixtures.fixtures().map((f) => ({
      matchId: f.id,
      label: `${f.homeTeam.tla ?? '?'} vs ${f.awayTeam.tla ?? '?'} · ${f.status} · ${f.utcKickoff.toLocaleString(
        undefined,
        { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
      )}`,
    }));
  });

  /** Only fixtures the user has a prediction for — scenario buttons need a
   *  prediction to compute exact/outcome/wrong scores against. */
  protected readonly predictedOptions = computed(() => {
    const preds = this.predictions.matchPredictions();
    const byId = this.fixtures.fixturesById();
    return [...preds.values()]
      .map((p) => {
        const f = byId.get(p.matchId);
        if (!f) return null;
        return {
          matchId: p.matchId,
          label: `${f.homeTeam.tla} ${p.homeScore}-${p.awayScore} ${f.awayTeam.tla} · ${f.utcKickoff.toLocaleDateString()}`,
        };
      })
      .filter((x): x is { matchId: string; label: string } => x !== null);
  });

  protected readonly stateForm = this.fb.nonNullable.group({
    matchId: ['', Validators.required],
    status: ['FINISHED' as FixtureStatus, Validators.required],
    homeScore: [0, [Validators.required, Validators.min(0)]],
    awayScore: [0, [Validators.required, Validators.min(0)]],
  });

  protected readonly kickoffForm = this.fb.nonNullable.group({
    matchId: ['', Validators.required],
  });

  protected readonly scenarioForm = this.fb.nonNullable.group({
    matchId: ['', Validators.required],
  });

  // --------------------------------------------------------------------------
  // Fixture state
  // --------------------------------------------------------------------------

  protected async applyState(): Promise<void> {
    const { matchId, status, homeScore, awayScore } = this.stateForm.getRawValue();
    await this.runCallable('devSetFixtureState', { matchId, status, homeScore, awayScore }, `Fixture → ${status}`);
  }

  // --------------------------------------------------------------------------
  // Kickoff
  // --------------------------------------------------------------------------

  protected async moveKickoff(offsetMinutes: number): Promise<void> {
    const matchId = this.kickoffForm.controls.matchId.value;
    if (!matchId) {
      this.snackBar.open('Pick a fixture first', 'Dismiss', { duration: 2500 });
      return;
    }
    const label =
      offsetMinutes >= 0
        ? `Kickoff in ${offsetMinutes}m`
        : `Kickoff ${Math.abs(offsetMinutes)}m ago`;
    await this.runCallable('devSetKickoffTime', { matchId, offsetMinutes }, label);
  }

  // --------------------------------------------------------------------------
  // Scenarios
  // --------------------------------------------------------------------------

  protected async scenarioFinishExact(): Promise<void> {
    const pred = this.requirePrediction();
    if (!pred) return;
    await this.runCallable(
      'devSetFixtureState',
      {
        matchId: pred.matchId,
        status: 'FINISHED',
        homeScore: pred.homeScore,
        awayScore: pred.awayScore,
      },
      'FT — Exact (+3)',
    );
  }

  protected async scenarioFinishOutcome(): Promise<void> {
    const pred = this.requirePrediction();
    if (!pred) return;
    let home = pred.homeScore;
    let away = pred.awayScore;
    if (home > away) home += 1;
    else if (away > home) away += 1;
    else {
      home += 1;
      away += 1;
    }
    await this.runCallable(
      'devSetFixtureState',
      { matchId: pred.matchId, status: 'FINISHED', homeScore: home, awayScore: away },
      'FT — Outcome (+1)',
    );
  }

  protected async scenarioFinishWrong(): Promise<void> {
    const pred = this.requirePrediction();
    if (!pred) return;
    // Flip the winner: pick the opposite team's prediction +1.
    const home = pred.awayScore + 1;
    const away = pred.homeScore;
    await this.runCallable(
      'devSetFixtureState',
      { matchId: pred.matchId, status: 'FINISHED', homeScore: home, awayScore: away },
      'FT — Miss (0)',
    );
  }

  protected async scenarioStartLive(): Promise<void> {
    const matchId = this.scenarioForm.controls.matchId.value;
    if (!matchId) return;
    await this.runCallable(
      'devSetFixtureState',
      { matchId, status: 'IN_PLAY', homeScore: 0, awayScore: 0 },
      'Kicked off live 0–0',
    );
  }

  protected async scenarioLockSoon(): Promise<void> {
    const matchId = this.scenarioForm.controls.matchId.value;
    if (!matchId) return;
    // 0.5 minutes = 30 seconds. The 1m rounding in the UI's "Locks in Nm" chip
    // will display "Locks in 1m" but the actual lock fires in ~30s.
    await this.runCallable(
      'devSetKickoffTime',
      { matchId, offsetMinutes: 0.5 },
      'Lock in 30s',
    );
  }

  // --------------------------------------------------------------------------
  // Reset
  // --------------------------------------------------------------------------

  protected async pollFixturesNow(): Promise<void> {
    this.running.set(true);
    try {
      const call = httpsCallable<unknown, { ok: boolean; fetched: number; written: number }>(
        this.functions,
        'devPollFixturesNow',
      );
      const res = await call({});
      const { fetched, written } = res.data;
      this.snackBar.open(
        `Fetched ${fetched} fixtures, wrote ${written}`,
        undefined,
        { duration: 2500 },
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Poll failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('devPollFixturesNow failed', e);
    } finally {
      this.running.set(false);
    }
  }

  protected async pollTeamsNow(): Promise<void> {
    this.running.set(true);
    try {
      const call = httpsCallable<unknown, { ok: boolean; fetched: number; written: number }>(
        this.functions,
        'devPollTeamsNow',
      );
      const res = await call({});
      const { fetched, written } = res.data;
      this.snackBar.open(
        `Fetched ${fetched} teams, wrote ${written}`,
        undefined,
        { duration: 2500 },
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Poll failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('devPollTeamsNow failed', e);
    } finally {
      this.running.set(false);
    }
  }

  protected async resetState(flags: {
    clearMatchPredictions?: boolean;
    clearPodium?: boolean;
    resetTotals?: boolean;
  }): Promise<void> {
    const parts: string[] = [];
    if (flags.clearMatchPredictions) parts.push('predictions');
    if (flags.clearPodium) parts.push('podium');
    if (flags.resetTotals) parts.push('totals');
    await this.runCallable('devResetMyState', flags, `Cleared ${parts.join(', ')}`);
  }

  /**
   * Wipe the caller's predictor-personality doc. Lets you regenerate
   * without waiting out the 12 h cooldown — useful when iterating on
   * the Gemini prompt or the deterministic fallback's reasoning copy.
   */
  protected async clearPersonality(): Promise<void> {
    await this.runCallable('devClearMyPersonality', {}, 'Personality cleared');
  }

  // --------------------------------------------------------------------------
  // Shared callable runner
  // --------------------------------------------------------------------------

  private requirePrediction() {
    const matchId = this.scenarioForm.controls.matchId.value;
    if (!matchId) return null;
    return this.predictions.matchPredictions().get(matchId) ?? null;
  }

  private async runCallable(
    name: string,
    data: Record<string, unknown>,
    successLabel: string,
  ): Promise<void> {
    this.running.set(true);
    try {
      const call = httpsCallable<unknown, { ok: boolean }>(this.functions, name);
      await call(data);
      this.snackBar.open(successLabel, undefined, { duration: 1800 });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error(`${name} failed`, e);
    } finally {
      this.running.set(false);
    }
  }
}
