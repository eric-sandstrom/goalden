import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Head2Head } from '../../core/models/match-detail.model';

/**
 * The Head2head tab of the match detail: the two teams' record across prior
 * meetings (a summary bar) plus the list of those encounters. Reads the
 * `fixtures/{id}/detail/head2head` doc the poller captures once when the
 * line-up first appears — purely presentational.
 */
@Component({
  selector: 'app-match-head2head',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './match-head2head.component.html',
  styleUrl: './match-head2head.component.scss',
})
export class MatchHead2HeadComponent {
  readonly head2head = input<Head2Head | null>(null);

  protected readonly aggregates = computed(() => this.head2head()?.aggregates ?? null);
  protected readonly matches = computed(() => this.head2head()?.matches ?? []);
  protected readonly hasData = computed(
    () => this.aggregates() !== null || this.matches().length > 0,
  );

  /** Friendly date for a previous meeting; empty when the stored value is
   *  missing or unparseable. */
  protected matchDateLabel(utcDate: string | null): string {
    if (!utcDate) return '';
    const d = new Date(utcDate);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
}
