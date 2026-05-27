import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  ARCHETYPE_PRESENTATION,
  Personality,
  PersonalityEligibility,
} from '../../core/models/personality.model';
import { PersonalityService } from '../../core/services/personality.service';
import { SkelComponent } from '../../shared/components/skel.component';

/**
 * The "Predictor personality" card rendered on /profile (owner mode) and
 * /users/:uid (visitor mode). Same visual shape for both — the only
 * difference is whether the Regenerate button is visible and what the
 * empty-state copy says.
 *
 * Inputs:
 *   - `personality`  : the doc to render, or null for the empty state.
 *   - `loaded`       : false while we're still fetching the doc (skeleton).
 *   - `ownerMode`    : show the Generate/Regenerate button + cooldown copy.
 *   - `eligibility`  : the live eligibility view-model from PersonalityService.
 *                      Required when `ownerMode` is true; ignored otherwise.
 *   - `subjectName`  : the visited user's display name. Used in visitor-mode
 *                      empty-state copy ("Alice hasn't discovered…"). Defaults
 *                      to "they" if not provided.
 *
 * The component never reads from `PersonalityService.myPersonality()`
 * directly so it can also be used to render someone else's personality.
 * The parent decides what to feed in.
 */
@Component({
  selector: 'app-predictor-personality-card',
  imports: [
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    SkelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined" class="personality-card">
      @if (!loaded()) {
        <!-- Loading skeleton — same vertical rhythm as the filled state so
             the page doesn't reflow when data arrives. -->
        <mat-card-header>
          <app-skel width="48px" height="48px" rounded />
          <div class="hdr-text">
            <app-skel width="60%" height="1.3rem" block />
            <div style="height: 6px;"></div>
            <app-skel width="40%" height="0.9rem" block />
          </div>
        </mat-card-header>
        <mat-card-content>
          <app-skel width="90%" height="0.9rem" block />
          <div style="height: 6px;"></div>
          <app-skel width="75%" height="0.9rem" block />
        </mat-card-content>
      } @else if (personality(); as p) {
        <!-- Filled state — archetype identity + Gemini's reasoning. -->
        <mat-card-header>
          <div class="emoji" matCardAvatar [style.background]="tintBg()">
            {{ presentation().emoji }}
          </div>
          <mat-card-title>{{ presentation().name }}</mat-card-title>
          <mat-card-subtitle>{{ presentation().tagline }}</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <p class="reasoning">{{ p.reasoning }}</p>
          @if (p.source === 'fallback') {
            <!-- The deterministic fallback isn't a bug — it's a worse-flavour
                 result. Tiny hint so the user knows what happened. -->
            <p class="hint" aria-label="Reasoning generated locally">
              <mat-icon class="hint-icon" aria-hidden="true">memory</mat-icon>
              Generated without AI this time — try again later for an AI-written
              reasoning.
            </p>
          }
        </mat-card-content>
        @if (ownerMode()) {
          <mat-card-actions align="end" class="actions">
            @if (busy()) {
              <mat-progress-spinner mode="indeterminate" [diameter]="20" />
              <span class="busy-label">Generating…</span>
            } @else {
              @if (!eligible()) {
                <span
                  class="hint"
                  [matTooltip]="disabledReason()"
                  aria-live="polite"
                >
                  {{ disabledReason() }}
                </span>
              }
              <button
                mat-button
                (click)="regenerate()"
                [disabled]="!eligible() || busy()"
                aria-label="Regenerate personality"
              >
                <mat-icon>refresh</mat-icon>
                Regenerate
              </button>
            }
          </mat-card-actions>
        }
      } @else {
        <!-- Empty state — never generated yet. -->
        <mat-card-header>
          <mat-icon matCardAvatar class="empty-icon" aria-hidden="true">auto_awesome</mat-icon>
          <mat-card-title>Predictor personality</mat-card-title>
          <mat-card-subtitle>
            @if (ownerMode()) {
              Find out what kind of predictor the AI thinks you are.
            } @else {
              {{ subjectLabel() }} hasn't discovered their predictor personality yet.
            }
          </mat-card-subtitle>
        </mat-card-header>
        @if (ownerMode()) {
          <mat-card-actions align="end" class="actions">
            @if (busy()) {
              <mat-progress-spinner mode="indeterminate" [diameter]="20" />
              <span class="busy-label">Generating…</span>
            } @else {
              @if (!eligible()) {
                <span class="hint" aria-live="polite">{{ disabledReason() }}</span>
              }
              <button
                mat-flat-button
                (click)="regenerate()"
                [disabled]="!eligible() || busy()"
              >
                <mat-icon>auto_awesome</mat-icon>
                Generate now
              </button>
            }
          </mat-card-actions>
        }
      }
    </mat-card>
  `,
  styles: `
    .personality-card {
      padding: 0;
    }
    mat-card-header {
      padding: 1rem 1rem 0;
      align-items: center;
    }
    mat-card-content {
      padding: 0.75rem 1rem 0;
    }
    .hdr-text {
      flex: 1;
      min-width: 0;
    }
    .emoji {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      border-radius: 12px;
      font-size: 28px;
      line-height: 1;
    }
    .empty-icon {
      color: var(--mat-sys-primary);
    }
    .reasoning {
      margin: 0;
      font-size: 0.95rem;
      line-height: 1.45;
      color: var(--mat-sys-on-surface);
    }
    .hint {
      font-size: 0.8rem;
      color: var(--mat-sys-on-surface-variant);
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
    }
    .hint-icon {
      font-size: 14px;
      width: 14px;
      height: 14px;
    }
    .actions {
      padding: 0.5rem 0.75rem 0.75rem;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .busy-label {
      font-size: 0.85rem;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class PredictorPersonalityCardComponent {
  private readonly personalityService = inject(PersonalityService);
  private readonly snackBar = inject(MatSnackBar);

  readonly personality = input<Personality | null>(null);
  readonly loaded = input<boolean>(true);
  readonly ownerMode = input<boolean>(false);
  readonly eligibility = input<PersonalityEligibility | null>(null);
  readonly subjectName = input<string | null>(null);

  /** True while a callable invocation is in flight. Local to the card so
   *  the parent doesn't need to thread plumbing through. */
  protected readonly busy = signal(false);

  /** Presentation block for the current archetype — falls back to the
   *  generic empty-state shape when there's no personality yet. */
  protected readonly presentation = computed(() => {
    const p = this.personality();
    if (!p) {
      return ARCHETYPE_PRESENTATION.AGAINST_ALL_ODDS; // unused; just a stable shape
    }
    return ARCHETYPE_PRESENTATION[p.archetype];
  });

  /** Inline-style tinted background for the emoji avatar — uses the
   *  archetype's accent token at 18% alpha for a subtle but visible
   *  chip-style highlight. */
  protected readonly tintBg = computed(() => {
    const token = this.presentation().tintToken;
    return `color-mix(in srgb, var(${token}) 18%, transparent)`;
  });

  protected readonly eligible = computed(() => this.eligibility()?.eligible ?? false);
  protected readonly disabledReason = computed(() => this.eligibility()?.disabledReason ?? '');
  protected readonly subjectLabel = computed(() => this.subjectName() ?? 'They');

  protected async regenerate(): Promise<void> {
    if (!this.ownerMode()) return;
    this.busy.set(true);
    try {
      const result = await this.personalityService.generate();
      const presentation = ARCHETYPE_PRESENTATION[result.archetype];
      this.snackBar.open(
        `You're ${presentation.emoji} ${presentation.name}`,
        undefined,
        { duration: 2500 },
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to generate personality';
      this.snackBar.open(message, 'Dismiss', { duration: 4500 });
    } finally {
      this.busy.set(false);
    }
  }
}
