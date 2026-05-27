import { NgOptimizedImage } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { LeaderboardEntry, LeaderboardService } from '../../core/services/leaderboard.service';
import { SkelComponent } from '../../shared/components/skel.component';

@Component({
  selector: 'app-leaderboard',
  imports: [
    NgOptimizedImage,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatIconModule,
    MatTableModule,
    MatTooltipModule,
    SkelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './leaderboard.component.html',
  styleUrl: './leaderboard.component.scss',
})
export class LeaderboardComponent {
  private readonly leaderboard = inject(LeaderboardService);
  private readonly host = inject(ElementRef<HTMLElement>);

  protected readonly entries = this.leaderboard.entries;
  protected readonly loaded = this.leaderboard.loaded;
  protected readonly myEntry = this.leaderboard.myEntry;
  protected readonly myUid = computed(() => this.myEntry()?.uid ?? null);

  protected readonly columns = ['rank', 'player', 'points'];
  protected readonly skelRows = [0, 1, 2, 3, 4, 5, 6, 7];

  protected scrollToMe(): void {
    const uid = this.myUid();
    if (!uid) return;
    const row = this.host.nativeElement.querySelector(
      `tr[data-uid="${uid}"]`,
    ) as HTMLElement | null;
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  protected breakdownTooltip(row: LeaderboardEntry): string {
    const parts: string[] = [];
    if (row.totals.match) parts.push(`${row.totals.match} match`);
    if (row.totals.podium) parts.push(`${row.totals.podium} podium`);
    if (row.totals.bracket) parts.push(`${row.totals.bracket} bracket`);
    if (row.totals.exactScoreHits) parts.push(`${row.totals.exactScoreHits} exact`);
    if (row.totals.correctOutcomeHits) parts.push(`${row.totals.correctOutcomeHits} outcome`);
    return parts.join(' · ');
  }
}
