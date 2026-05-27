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
  templateUrl: './predict.component.html',
  styleUrl: './predict.component.scss',
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
