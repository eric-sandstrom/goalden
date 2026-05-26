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
  template: `
    <section class="page">
      <header class="hero">
        <h1>Global leaderboard</h1>
        @if (myEntry(); as me) {
          <mat-chip-set>
            <mat-chip [disableRipple]="true" highlighted>
              <mat-icon matChipAvatar>account_circle</mat-icon>
              You're #{{ me.rank }} with {{ me.totals.total }} pts
            </mat-chip>
          </mat-chip-set>
          <button mat-stroked-button (click)="scrollToMe()">
            <mat-icon>my_location</mat-icon>
            Find me
          </button>
        }
      </header>

      @if (!loaded()) {
        <mat-card appearance="outlined" class="table-wrap card-grow">
          <div class="card-scroll skel-list">
            @for (i of skelRows; track i) {
              <div class="skel-row">
                <app-skel width="18px" height="1rem" />
                <app-skel width="28px" height="28px" rounded />
                <app-skel width="40%" height="1rem" />
                <app-skel width="28px" height="1rem" />
              </div>
            }
          </div>
        </mat-card>
      } @else if (entries().length === 0) {
        <mat-card appearance="outlined" class="empty">
          <mat-icon aria-hidden="true">leaderboard</mat-icon>
          <p>No scores yet. Predictions get points once matches finish.</p>
        </mat-card>
      } @else {
        <mat-card appearance="outlined" class="table-wrap card-grow">
          <div class="card-scroll">
            <table mat-table [dataSource]="entries()">
              <ng-container matColumnDef="rank">
                <th mat-header-cell *matHeaderCellDef>#</th>
                <td mat-cell *matCellDef="let row">{{ row.rank }}</td>
              </ng-container>

              <ng-container matColumnDef="player">
                <th mat-header-cell *matHeaderCellDef>Player</th>
                <td mat-cell *matCellDef="let row">
                  <span class="player">
                    @if (row.photoURL) {
                      <img
                        [ngSrc]="row.photoURL"
                        width="28"
                        height="28"
                        [alt]="row.displayName + ' avatar'"
                        class="avatar"
                      />
                    } @else {
                      <mat-icon class="avatar-fallback" aria-hidden="true">person</mat-icon>
                    }
                    <span class="name">{{ row.displayName }}</span>
                  </span>
                </td>
              </ng-container>

              <ng-container matColumnDef="points">
                <th mat-header-cell *matHeaderCellDef>Pts</th>
                <td
                  mat-cell
                  *matCellDef="let row"
                  [matTooltip]="breakdownTooltip(row)"
                  matTooltipPosition="left"
                >
                  <strong>{{ row.totals.total }}</strong>
                </td>
              </ng-container>

              <tr mat-header-row *matHeaderRowDef="columns; sticky: true"></tr>
              <tr
                mat-row
                *matRowDef="let row; columns: columns"
                [class.me]="row.uid === myUid()"
                [attr.data-uid]="row.uid"
              ></tr>
            </table>
          </div>
        </mat-card>
      }
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
      gap: 0.5rem;
      flex: 0 0 auto;
    }
    .hero h1 {
      margin: 0;
      font: var(--mat-sys-headline-medium);
    }
    .table-wrap {
      padding: 0;
      overflow: hidden;
    }
    table {
      width: 100%;
    }
    .player {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .avatar {
      border-radius: 50%;
      object-fit: cover;
    }
    .avatar-fallback {
      width: 28px;
      height: 28px;
      font-size: 28px;
      color: var(--mat-sys-on-surface-variant);
    }
    .name {
      font-weight: 500;
    }
    tr.me {
      background: var(--mat-sys-secondary-container);
    }
    tr.me td {
      color: var(--mat-sys-on-secondary-container);
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
    .skel-list {
      padding: 0;
    }
    .skel-row {
      display: grid;
      grid-template-columns: auto auto 1fr auto;
      gap: 0.75rem;
      align-items: center;
      padding: 0.85rem 1rem;
      min-height: 52px;
      box-sizing: border-box;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .skel-row:last-child {
      border-bottom: none;
    }
  `,
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
