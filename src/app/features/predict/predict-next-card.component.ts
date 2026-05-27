import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { Fixture, isTbd } from '../../core/models/fixture.model';
import { FixturesService } from '../../core/services/fixtures.service';
import {
  MatchPrediction,
  PredictionsService,
} from '../../core/services/predictions.service';
import { FixtureRowComponent } from './fixture-row.component';

/**
 * A bite-sized "predict your next match" surface for embedding in places
 * where match prediction isn't the primary scope (e.g. the league detail
 * page). Shows exactly one fixture at a time and offers a Next button to
 * skip to a different unpredicted fixture.
 *
 * Stay-on-current behaviour: the displayed fixture is tracked by **id**,
 * not by position in the unpredicted list. So after the user submits a
 * prediction in the embedded FixtureRow, the just-predicted fixture
 * remains visible (now with its prediction filled in) until the user
 * explicitly taps Next. The Next button then advances to the next
 * unpredicted fixture.
 *
 * Competition scope: today the entire fixtures collection is just the
 * World Cup. When leagues gain a `competitionId` field, the source
 * `upcomingFixtures` will filter by that id.
 */
@Component({
  selector: 'app-predict-next-card',
  imports: [MatButtonModule, MatCardModule, MatIconModule, FixtureRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './predict-next-card.component.html',
  styleUrl: './predict-next-card.component.scss',
})
export class PredictNextCardComponent {
  private readonly fixtures = inject(FixturesService);
  private readonly predictions = inject(PredictionsService);

  /** ID of the fixture currently shown. Stays put across predict
   *  submissions so the user only sees a new fixture when they ask for
   *  one via the Next button. */
  private readonly currentFixtureId = signal<string | null>(null);

  /** Every upcoming TIMED fixture in kickoff order, excluding fixtures
   *  whose teams aren't decided yet (knockout rounds before the
   *  preceding round finishes). TBD matches reappear in the candidate
   *  list automatically once pollFootballData fills in the team ids. */
  protected readonly upcomingFixtures = computed<readonly Fixture[]>(() => {
    const now = Date.now();
    return this.fixtures
      .fixtures()
      .filter(
        (f) =>
          f.status === 'TIMED' &&
          f.utcKickoff.getTime() > now &&
          !isTbd(f),
      )
      .sort((a, b) => a.utcKickoff.getTime() - b.utcKickoff.getTime());
  });

  /** Subset of upcomingFixtures the user hasn't predicted yet. */
  protected readonly unpredicted = computed<readonly Fixture[]>(() => {
    const preds = this.predictions.matchPredictions();
    return this.upcomingFixtures().filter((f) => !preds.has(f.id));
  });

  /** The fixture currently rendered in the card — looked up by id from
   *  the fixtures cache. Returns null only when there's literally nothing
   *  upcoming. */
  protected readonly currentFixture = computed<Fixture | null>(() => {
    const id = this.currentFixtureId();
    if (id) {
      const found = this.fixtures.fixturesById().get(id);
      if (found) return found;
    }
    // Initial state OR the previously-shown fixture vanished — pick the
    // first unpredicted, falling back to the first upcoming if everything
    // has been predicted (so the user still sees something useful).
    return this.unpredicted()[0] ?? this.upcomingFixtures()[0] ?? null;
  });

  /** Earliest upcoming fixture so the empty state can hint at "next match
   *  starts at …" rather than feeling like a dead end. */
  protected readonly nextLockedFixture = computed<Fixture | null>(() => {
    const now = Date.now();
    return (
      this.fixtures
        .fixtures()
        .find((f) => f.utcKickoff.getTime() > now) ?? null
    );
  });

  /** Whether there's another unpredicted fixture *besides* the one currently
   *  shown. Drives whether to display the Next button. */
  protected readonly hasOtherUnpredicted = computed(() => {
    const current = this.currentFixture();
    const unpredicted = this.unpredicted();
    if (unpredicted.length === 0) return false;
    if (unpredicted.length === 1) return unpredicted[0].id !== current?.id;
    return true;
  });

  protected readonly subtitle = computed(() => {
    const total = this.unpredicted().length;
    if (total === 0) return 'Nothing pending';
    if (total === 1) return '1 match left to predict';
    return `${total} matches left to predict`;
  });

  constructor() {
    // Seed the current fixture once data arrives. Don't overwrite an
    // existing selection — that would defeat the "stay until Next is
    // pressed" behaviour.
    effect(() => {
      const list = this.unpredicted();
      const already = untracked(() => this.currentFixtureId());
      if (already) return;
      if (list.length > 0) {
        this.currentFixtureId.set(list[0].id);
      }
    });
  }

  protected predictionFor(matchId: string): MatchPrediction | null {
    return this.predictions.matchPredictions().get(matchId) ?? null;
  }

  /**
   * Advances to the next unpredicted fixture.
   *  - If the current fixture is still in the unpredicted list (user
   *    hasn't predicted yet, just browsing), step to the one after it.
   *  - If the current fixture has been predicted (not in the unpredicted
   *    list anymore), pick the first unpredicted.
   *  - Wraps around at the end of the list.
   */
  protected next(): void {
    const unpredicted = this.unpredicted();
    if (unpredicted.length === 0) {
      this.currentFixtureId.set(null);
      return;
    }
    const currentId = this.currentFixtureId();
    const idxInList = currentId
      ? unpredicted.findIndex((f) => f.id === currentId)
      : -1;
    if (idxInList < 0) {
      // Current fixture is predicted (or null) — start at the top of the
      // unpredicted queue.
      this.currentFixtureId.set(unpredicted[0].id);
      return;
    }
    const nextIdx = (idxInList + 1) % unpredicted.length;
    this.currentFixtureId.set(unpredicted[nextIdx].id);
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
