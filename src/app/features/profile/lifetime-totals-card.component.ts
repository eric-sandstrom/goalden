import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  resource,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { CompetitionsService } from '../../core/services/competitions.service';
import { CompetitionTotals, UserService } from '../../core/services/user.service';

interface BreakdownRow {
  readonly competitionId: string;
  readonly season: string;
  readonly name: string;
  readonly emblem: string | null;
  readonly total: number;
}

/**
 * Lifetime points across every competition + season a user has scored in.
 * Sums the per-(comp, season) totals shards (`users/{uid}/totals/*`) — the
 * same shards the per-league leaderboards read, just aggregated here.
 *
 * Takes a `uid` so it works on both the owner's /profile and the public
 * /users/:uid view. Loads once via a `resource()`; totals only change when a
 * predicted match finishes, so a live listener isn't worth the cost.
 */
@Component({
  selector: 'app-lifetime-totals-card',
  imports: [MatCardModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './lifetime-totals-card.component.html',
  styleUrl: './lifetime-totals-card.component.scss',
})
export class LifetimeTotalsCardComponent {
  private readonly userService = inject(UserService);
  private readonly competitions = inject(CompetitionsService);

  readonly uid = input.required<string>();

  private readonly shardsResource = resource<readonly CompetitionTotals[], string | undefined>({
    params: () => this.uid() || undefined,
    loader: ({ params }) => this.userService.loadTotalsShards(params),
    defaultValue: [],
  });

  protected readonly loading = computed(() => this.shardsResource.isLoading());
  protected readonly error = computed(() => this.shardsResource.status() === 'error');

  /** Points + hit tallies summed across every competition. */
  protected readonly lifetime = computed(() => {
    let total = 0;
    let exact = 0;
    let outcome = 0;
    for (const s of this.shardsResource.value()) {
      total += s.totals.total;
      exact += s.totals.exactScoreHits;
      outcome += s.totals.correctOutcomeHits;
    }
    return { total, exact, outcome };
  });

  /** Per-competition breakdown, richest first. Resolves comp name + emblem
   *  from the catalogue; falls back to the shortcode when not yet hydrated. */
  protected readonly breakdown = computed<readonly BreakdownRow[]>(() =>
    this.shardsResource
      .value()
      .map((s): BreakdownRow => {
        const comp = this.competitions.byId(s.competitionId);
        return {
          competitionId: s.competitionId,
          season: s.season,
          name: comp?.name ?? s.competitionId,
          emblem: comp?.emblem ?? null,
          total: s.totals.total,
        };
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
  );
}
