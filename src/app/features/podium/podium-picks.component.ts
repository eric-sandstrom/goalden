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
  templateUrl: './podium-picks.component.html',
  styleUrl: './podium-picks.component.scss',
})
export class PodiumPicksComponent {
  private readonly fixtures = inject(FixturesService);
  private readonly predictions = inject(PredictionsService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly fb = inject(FormBuilder);

  /**
   * Podium picks are a WC-only concept (winner / runner-up / third of the
   * tournament). Triggers a load of the WC fixtures so the `teams` cross-
   * comp signal populates with WC participants — there's no consumer-side
   * filtering because the only loaded comp here is WC.
   */
  private readonly _wcLoad = this.fixtures.fixturesFor('WC', '2026');
  protected readonly teams = this.fixtures.teams;
  protected readonly fixturesLoaded = this.fixtures.loadedFor('WC', '2026');
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
