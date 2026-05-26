import { NgOptimizedImage } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FixturesService } from '../../core/services/fixtures.service';
import { PredictionsService } from '../../core/services/predictions.service';
import { KnownTeam, PODIUM_LOCK } from '../../core/models/podium.model';

@Component({
  selector: 'app-podium-picks',
  imports: [
    NgOptimizedImage,
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSelectModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="container">
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-icon matCardAvatar>emoji_events</mat-icon>
          <mat-card-title>Pick your podium</mat-card-title>
          <mat-card-subtitle>
            @if (locked()) {
              Locked — first match has kicked off
            } @else {
              Locks at first kickoff — June 11, 2026
            }
          </mat-card-subtitle>
        </mat-card-header>

        <mat-card-content>
          @if (!fixturesLoaded() || !podiumLoaded()) {
            <div class="state">
              <mat-progress-spinner mode="indeterminate" diameter="32" />
            </div>
          } @else {
            <p class="hint">
              +25 for the winner, +15 for runner-up, +10 for third place. Pick three different
              teams.
            </p>

            <form [formGroup]="form" class="form">
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>Winner (+25)</mat-label>
                <mat-icon matIconPrefix class="medal gold">workspace_premium</mat-icon>
                <mat-select formControlName="winner">
                  @for (team of teams(); track team.id) {
                    <mat-option [value]="team.id" [disabled]="isDisabled(team.id, 'winner')">
                      <span class="opt">
                        @if (team.crest) {
                          <img
                            [ngSrc]="team.crest"
                            width="20"
                            height="20"
                            [alt]="team.name + ' crest'"
                          />
                        }
                        {{ team.name }}
                      </span>
                    </mat-option>
                  }
                </mat-select>
              </mat-form-field>

              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>Runner-up (+15)</mat-label>
                <mat-icon matIconPrefix class="medal silver">workspace_premium</mat-icon>
                <mat-select formControlName="second">
                  @for (team of teams(); track team.id) {
                    <mat-option [value]="team.id" [disabled]="isDisabled(team.id, 'second')">
                      <span class="opt">
                        @if (team.crest) {
                          <img
                            [ngSrc]="team.crest"
                            width="20"
                            height="20"
                            [alt]="team.name + ' crest'"
                          />
                        }
                        {{ team.name }}
                      </span>
                    </mat-option>
                  }
                </mat-select>
              </mat-form-field>

              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>Third (+10)</mat-label>
                <mat-icon matIconPrefix class="medal bronze">workspace_premium</mat-icon>
                <mat-select formControlName="third">
                  @for (team of teams(); track team.id) {
                    <mat-option [value]="team.id" [disabled]="isDisabled(team.id, 'third')">
                      <span class="opt">
                        @if (team.crest) {
                          <img
                            [ngSrc]="team.crest"
                            width="20"
                            height="20"
                            [alt]="team.name + ' crest'"
                          />
                        }
                        {{ team.name }}
                      </span>
                    </mat-option>
                  }
                </mat-select>
              </mat-form-field>
            </form>

            @if (existingPick(); as pick) {
              <mat-chip-set class="status">
                <mat-chip [disableRipple]="true">
                  <mat-icon matChipAvatar>check_circle</mat-icon>
                  Picks submitted
                </mat-chip>
              </mat-chip-set>
            }
          }
        </mat-card-content>

        @if (!locked()) {
          <mat-card-actions align="end">
            <a mat-button routerLink="/">Cancel</a>
            <button
              mat-flat-button
              color="primary"
              [disabled]="form.invalid || saving() || locked()"
              (click)="save()"
            >
              @if (saving()) {
                <mat-progress-spinner mode="indeterminate" diameter="20" />
              } @else if (existingPick()) {
                Update picks
              } @else {
                Save picks
              }
            </button>
          </mat-card-actions>
        }
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
      max-width: 560px;
      width: 100%;
      margin: 0 auto;
      overflow-y: auto;
      overscroll-behavior: contain;
      box-sizing: border-box;
    }
    .hint {
      color: var(--mat-sys-on-surface-variant);
      margin: 0 0 1rem;
    }
    .form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .opt {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .medal {
      width: 20px;
      height: 20px;
      font-size: 20px;
      margin-right: 4px;
    }
    .medal.gold { color: var(--mat-sys-tertiary); }
    .medal.silver { color: var(--mat-sys-outline); }
    /* Bronze is the tertiary (typically warm) muted toward the error palette
       (typically red) to land somewhere brown/coppery. Adapts to the active
       theme so all three medals stay coherent with whichever country palette
       is in play. */
    .medal.bronze {
      color: color-mix(in srgb, var(--mat-sys-tertiary) 55%, var(--mat-sys-error) 45%);
    }
    .status {
      margin-top: 1rem;
    }
    .state {
      display: flex;
      justify-content: center;
      padding: 2rem;
    }
  `,
})
export class PodiumPicksComponent {
  private readonly fixtures = inject(FixturesService);
  private readonly predictions = inject(PredictionsService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly fb = inject(FormBuilder);

  protected readonly teams = this.fixtures.teams;
  protected readonly fixturesLoaded = this.fixtures.loaded;
  protected readonly podiumLoaded = this.predictions.podiumLoaded;
  protected readonly existingPick = this.predictions.podiumPick;

  protected readonly saving = signal(false);
  protected readonly locked = computed(() => Date.now() >= PODIUM_LOCK.getTime());

  protected readonly form = this.fb.nonNullable.group({
    winner: this.fb.nonNullable.control<number | null>(null, Validators.required),
    second: this.fb.nonNullable.control<number | null>(null, Validators.required),
    third: this.fb.nonNullable.control<number | null>(null, Validators.required),
  });

  constructor() {
    effect(() => {
      const pick = this.existingPick();
      if (pick) {
        this.form.patchValue(
          { winner: pick.winnerTeamId, second: pick.secondTeamId, third: pick.thirdTeamId },
          { emitEvent: false },
        );
      }
      if (this.locked()) this.form.disable({ emitEvent: false });
    });
  }

  protected isDisabled(teamId: number, slot: 'winner' | 'second' | 'third'): boolean {
    const v = this.form.getRawValue();
    if (slot !== 'winner' && v.winner === teamId) return true;
    if (slot !== 'second' && v.second === teamId) return true;
    if (slot !== 'third' && v.third === teamId) return true;
    return false;
  }

  protected async save(): Promise<void> {
    const { winner, second, third } = this.form.getRawValue();
    if (winner === null || second === null || third === null) return;
    if (winner === second || winner === third || second === third) {
      this.snackBar.open('Pick three different teams', 'Dismiss', { duration: 3000 });
      return;
    }
    this.saving.set(true);
    try {
      await this.predictions.savePodium(winner, second, third);
      this.snackBar.open('Podium picks saved', undefined, { duration: 1500 });
    } catch (e: unknown) {
      this.snackBar.open('Save failed', 'Dismiss', { duration: 4000 });
      console.error('Podium save failed', e);
    } finally {
      this.saving.set(false);
    }
  }
}
