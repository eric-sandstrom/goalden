import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { Fixture, isKnockout } from '../../core/models/fixture.model';
import { FixturesService } from '../../core/services/fixtures.service';
import { PredictionsService } from '../../core/services/predictions.service';
import { SkelComponent } from '../../shared/components/skel.component';
import { FixtureRowComponent } from './fixture-row.component';

type Filter = 'ALL' | 'UPCOMING' | 'LIVE' | 'FINISHED' | 'GROUP' | 'KNOCKOUTS';

interface DateGroup {
  readonly label: string;
  readonly key: string;
  readonly fixtures: readonly Fixture[];
}

@Component({
  selector: 'app-predict',
  imports: [
    FixtureRowComponent,
    MatButtonToggleModule,
    MatCardModule,
    MatIconModule,
    SkelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="hero">
        <h1>Predict</h1>
        <mat-button-toggle-group
          [value]="filter()"
          (change)="filter.set($event.value)"
          hideSingleSelectionIndicator
          aria-label="Filter fixtures"
        >
          <mat-button-toggle value="UPCOMING">Upcoming</mat-button-toggle>
          <mat-button-toggle value="LIVE">Live</mat-button-toggle>
          <mat-button-toggle value="FINISHED">Finished</mat-button-toggle>
          <mat-button-toggle value="GROUP">Group</mat-button-toggle>
          <mat-button-toggle value="KNOCKOUTS">Knockouts</mat-button-toggle>
          <mat-button-toggle value="ALL">All</mat-button-toggle>
        </mat-button-toggle-group>
      </header>

      <mat-card appearance="outlined" class="card-grow fixtures-card">
        <div class="card-scroll">
          @if (!loaded()) {
            <div class="skel-list">
              @for (i of skelRows; track i) {
                <div class="skel-row">
                  <div class="skel-grid">
                    <app-skel width="56px" height="1.2rem" />
                    <div class="skel-scores">
                      <app-skel width="56px" height="56px" />
                      <app-skel width="56px" height="56px" />
                    </div>
                    <app-skel width="56px" height="1.2rem" />
                  </div>
                  <app-skel width="45%" height="0.9rem" block />
                </div>
              }
            </div>
          } @else if (groups().length === 0) {
            <div class="empty">
              <mat-icon aria-hidden="true">event_busy</mat-icon>
              <p>No fixtures match this filter.</p>
            </div>
          } @else {
            @for (group of groups(); track group.key) {
              <section class="group">
                <h2 class="day">{{ group.label }}</h2>
                @for (fixture of group.fixtures; track fixture.id) {
                  <app-fixture-row
                    [fixture]="fixture"
                    [prediction]="predictionFor(fixture.id)"
                  />
                }
              </section>
            }
          }
        </div>
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
    .hero {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      flex: 0 0 auto;
    }
    h1 {
      margin: 0;
      font: var(--mat-sys-headline-medium);
    }
    mat-button-toggle-group {
      align-self: stretch;
      overflow-x: auto;
    }
    .fixtures-card {
      padding: 0;
      overflow: hidden;
    }
    .group {
      display: contents;
    }
    .day {
      position: sticky;
      top: 0;
      z-index: 2;
      margin: 0;
      padding: 0.6rem 1rem;
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface-variant);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      background-color: var(--mat-sys-surface-container-highest);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 2rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .skel-list { display: block; }
    .skel-row {
      padding: 0.75rem 1rem;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 0.5rem;
      min-height: 124px;
      box-sizing: border-box;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .skel-row:nth-child(even) { background: var(--mat-sys-surface-container-low); }
    .skel-row:last-child { border-bottom: none; }
    .skel-grid {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 0.75rem;
    }
    .skel-grid > app-skel:last-of-type {
      justify-self: end;
    }
    .skel-scores {
      display: flex;
      gap: 8px;
    }
  `,
})
export class PredictComponent {
  private readonly fixturesService = inject(FixturesService);
  private readonly predictionsService = inject(PredictionsService);

  protected readonly filter = signal<Filter>('UPCOMING');
  protected readonly loaded = computed(() => this.fixturesService.loaded());
  protected readonly skelRows = [0, 1, 2, 3, 4, 5];

  protected readonly groups = computed<readonly DateGroup[]>(() => {
    const all = this.fixturesService.fixtures();
    const filter = this.filter();
    const filtered = this.applyFilter(all, filter);
    // Finished matches are most useful in reverse-chronological order — the
    // user wants to scan most recent results first, not the opening match.
    const ordered =
      filter === 'FINISHED'
        ? [...filtered].sort((a, b) => b.utcKickoff.getTime() - a.utcKickoff.getTime())
        : filtered;
    return this.groupByDate(ordered);
  });

  protected predictionFor(matchId: string) {
    return this.predictionsService.matchPredictions().get(matchId) ?? null;
  }

  private applyFilter(fixtures: readonly Fixture[], f: Filter): readonly Fixture[] {
    const now = Date.now();
    switch (f) {
      case 'ALL':
        return fixtures;
      case 'UPCOMING':
        return fixtures.filter((x) => x.utcKickoff.getTime() > now && x.status === 'TIMED');
      case 'LIVE':
        return fixtures.filter((x) => x.status === 'IN_PLAY' || x.status === 'PAUSED');
      case 'FINISHED':
        return fixtures.filter((x) => x.status === 'FINISHED' || x.status === 'AWARDED');
      case 'GROUP':
        return fixtures.filter((x) => !isKnockout(x.stage));
      case 'KNOCKOUTS':
        return fixtures.filter((x) => isKnockout(x.stage));
    }
  }

  private groupByDate(fixtures: readonly Fixture[]): readonly DateGroup[] {
    const map = new Map<string, Fixture[]>();
    for (const f of fixtures) {
      const key = f.utcKickoff.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
      const bucket = map.get(key) ?? [];
      bucket.push(f);
      map.set(key, bucket);
    }
    const groups: DateGroup[] = [];
    for (const [label, fxs] of map) {
      groups.push({ label, key: label, fixtures: fxs });
    }
    return groups;
  }
}
