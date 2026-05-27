import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { Fixture } from '../../core/models/fixture.model';
import { FixturesService } from '../../core/services/fixtures.service';
import {
  MatchPrediction,
  PredictionsService,
} from '../../core/services/predictions.service';
import { FixtureRowComponent } from './fixture-row.component';

/**
 * A bite-sized "predict your next match" surface, suitable for embedding in
 * places where match prediction isn't the primary scope (e.g. the league
 * detail page). Shows exactly one fixture at a time — the next one the user
 * hasn't predicted yet — and offers a Next button to skip to the one after.
 *
 * Competition scope: currently the whole fixtures collection, which is just
 * the World Cup. When leagues gain a `competitionId` field in the future,
 * we'll filter the fixtures source here by it.
 */
@Component({
  selector: 'app-predict-next-card',
  imports: [MatButtonModule, MatCardModule, MatIconModule, FixtureRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined" class="predict-next-card">
      <mat-card-header>
        <mat-icon matCardAvatar>sports_soccer</mat-icon>
        <mat-card-title>Predict next match</mat-card-title>
        <mat-card-subtitle>{{ subtitle() }}</mat-card-subtitle>
      </mat-card-header>

      @if (currentFixture(); as f) {
        <div class="fixture-slot">
          <app-fixture-row [fixture]="f" [prediction]="predictionFor(f.id)" />
        </div>
        @if (unpredicted().length > 1) {
          <mat-card-actions align="end">
            <button mat-button (click)="next()">
              Next
              <mat-icon iconPositionEnd>chevron_right</mat-icon>
            </button>
          </mat-card-actions>
        }
      } @else {
        <mat-card-content class="empty">
          <mat-icon class="empty-icon" aria-hidden="true">check_circle</mat-icon>
          <p class="empty-text">All caught up — no upcoming matches left to predict.</p>
          @if (nextLockedFixture(); as nf) {
            <p class="empty-sub">
              Next match: <strong>{{ nf.homeTeam.name }} vs {{ nf.awayTeam.name }}</strong>
              · kicks off {{ kickoffLabel(nf) }}
            </p>
          }
        </mat-card-content>
      }
    </mat-card>
  `,
  styles: `
    .predict-next-card {
      padding: 0;
      overflow: hidden;
    }
    .predict-next-card mat-card-header {
      padding: 1rem 1rem 0;
    }
    /* Fixture row has its own padding and border-bottom; box it cleanly
       so the card edges look intentional. */
    .fixture-slot {
      padding: 0.5rem 0 0;
    }
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
      padding: 1.5rem 1rem;
      text-align: center;
      color: var(--mat-sys-on-surface-variant);
    }
    .empty-icon {
      color: var(--mat-sys-primary);
      font-size: 32px;
      width: 32px;
      height: 32px;
    }
    .empty-text {
      margin: 0;
      font-weight: 500;
      color: var(--mat-sys-on-surface);
    }
    .empty-sub {
      margin: 0;
      font-size: 0.85rem;
    }
  `,
})
export class PredictNextCardComponent {
  private readonly fixtures = inject(FixturesService);
  private readonly predictions = inject(PredictionsService);

  /** 0-based index into `unpredicted()`. Clamped via an effect when the
   *  list shrinks (e.g. after the user predicts the currently shown one). */
  private readonly index = signal(0);

  /** Upcoming TIMED fixtures the caller hasn't predicted yet, in kickoff
   *  order. The "to do" list. */
  protected readonly unpredicted = computed<readonly Fixture[]>(() => {
    const now = Date.now();
    const preds = this.predictions.matchPredictions();
    return this.fixtures
      .fixtures()
      .filter(
        (f) =>
          f.status === 'TIMED' &&
          f.utcKickoff.getTime() > now &&
          !preds.has(f.id),
      )
      .sort((a, b) => a.utcKickoff.getTime() - b.utcKickoff.getTime());
  });

  protected readonly currentFixture = computed<Fixture | null>(() => {
    const list = this.unpredicted();
    if (list.length === 0) return null;
    return list[this.index() % list.length] ?? list[0];
  });

  /** Earliest upcoming locked / non-TIMED fixture so the empty state can
   *  hint at "next match starts at …" rather than feeling like a dead end. */
  protected readonly nextLockedFixture = computed<Fixture | null>(() => {
    const now = Date.now();
    return (
      this.fixtures
        .fixtures()
        .find((f) => f.utcKickoff.getTime() > now) ?? null
    );
  });

  protected readonly subtitle = computed(() => {
    const total = this.unpredicted().length;
    if (total === 0) return 'Nothing pending';
    if (total === 1) return '1 match left to predict';
    return `${total} matches left to predict`;
  });

  constructor() {
    // Whenever the unpredicted list shrinks past the current index, snap
    // back to 0. Without this, a user who clicked Next then submitted a
    // prediction could end up with the card showing nothing while the
    // list still has entries.
    effect(() => {
      const list = this.unpredicted();
      if (list.length > 0 && this.index() >= list.length) {
        this.index.set(0);
      }
    });
  }

  protected predictionFor(matchId: string): MatchPrediction | null {
    return this.predictions.matchPredictions().get(matchId) ?? null;
  }

  protected next(): void {
    const list = this.unpredicted();
    if (list.length === 0) return;
    this.index.update((i) => (i + 1) % list.length);
  }

  protected kickoffLabel(fixture: Fixture): string {
    return fixture.utcKickoff.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
