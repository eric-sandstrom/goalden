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
  templateUrl: './predictor-personality-card.component.html',
  styleUrl: './predictor-personality-card.component.scss',
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
