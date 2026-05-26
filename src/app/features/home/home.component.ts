import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { FixturesService } from '../../core/services/fixtures.service';
import { LeaderboardService } from '../../core/services/leaderboard.service';
import { PredictionsService } from '../../core/services/predictions.service';
import { UserService } from '../../core/services/user.service';
import { PODIUM_LOCK } from '../../core/models/podium.model';
import { SkelComponent } from '../../shared/components/skel.component';
import { FixtureRowComponent } from '../predict/fixture-row.component';

type MatchView = 'live' | 'upcoming' | 'recent';

const UPCOMING_LIMIT = 3;
const RECENT_LIMIT = 3;

@Component({
  selector: 'app-home',
  imports: [
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatIconModule,
    SkelComponent,
    FixtureRowComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <div class="page-scroll">
        <!-- =================================================================
             Hero / welcome
        ================================================================== -->
        @if (!userLoaded()) {
          <mat-card appearance="outlined" class="hero-card">
            <mat-card-header>
              <app-skel width="60%" height="1.8rem" block />
              <div style="height: 8px;"></div>
              <app-skel width="40%" height="1rem" block />
            </mat-card-header>
          </mat-card>
        } @else {
          <mat-card appearance="outlined" class="hero-card">
            <mat-card-header>
              <mat-card-title>Welcome, {{ displayName() }}</mat-card-title>
              <mat-card-subtitle>{{ heroSubtitle() }}</mat-card-subtitle>
            </mat-card-header>
          </mat-card>
        }

        <!-- =================================================================
             Podium pick banner (only when action needed)
        ================================================================== -->
        @if (showPodiumBanner()) {
          <mat-card appearance="outlined" class="banner action-card">
            <mat-card-header>
              <mat-icon matCardAvatar class="trophy">emoji_events</mat-icon>
              <mat-card-title>Pick your podium</mat-card-title>
              <mat-card-subtitle>+50 pts available · Locks June 11</mat-card-subtitle>
            </mat-card-header>
            <mat-card-actions align="end">
              <a mat-flat-button color="primary" routerLink="/podium">Make picks</a>
            </mat-card-actions>
          </mat-card>
        } @else if (podiumLoaded() && podiumPickSubmitted() && !podiumLocked()) {
          <mat-card appearance="outlined" class="action-card">
            <mat-card-header>
              <mat-icon matCardAvatar class="trophy">emoji_events</mat-icon>
              <mat-card-title>Your podium picks are in</mat-card-title>
              <mat-card-subtitle>Locks June 11 — you can still change them</mat-card-subtitle>
            </mat-card-header>
            <mat-card-actions align="end">
              <a mat-button routerLink="/podium">Edit picks</a>
            </mat-card-actions>
          </mat-card>
        }

        <!-- =================================================================
             Matches (merged: Live / Up next / Recent)
        ================================================================== -->
        @if (!fixturesLoaded()) {
          <mat-card appearance="outlined" class="fixtures-card matches-card">
            <div class="matches-tabs">
              <app-skel width="100%" height="40px" block />
              <app-skel width="40%" height="0.9rem" block />
            </div>
            <div class="rows">
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
          </mat-card>
        } @else if (availableViews().length > 0) {
          <mat-card appearance="outlined" class="fixtures-card matches-card">
            <div class="matches-tabs">
              <mat-button-toggle-group
                [value]="currentView()"
                (change)="setView($event.value)"
                hideSingleSelectionIndicator
                aria-label="Match list"
              >
                @for (v of availableViews(); track v) {
                  <mat-button-toggle [value]="v">
                    @if (v === 'live') {
                      <span class="tab-live-dot" aria-hidden="true"></span>
                    }
                    {{ viewLabel(v) }}
                  </mat-button-toggle>
                }
              </mat-button-toggle-group>
              @if (paneSubtitle(); as subtitle) {
                <p class="pane-subtitle">{{ subtitle }}</p>
              }
            </div>

            <div class="rows">
              @switch (currentView()) {
                @case ('live') {
                  @for (f of liveFixtures(); track f.id) {
                    <app-fixture-row [fixture]="f" [prediction]="predictionFor(f.id)" />
                  }
                }
                @case ('upcoming') {
                  @for (f of upcomingFixtures(); track f.id) {
                    <app-fixture-row [fixture]="f" [prediction]="predictionFor(f.id)" />
                  }
                }
                @case ('recent') {
                  @for (f of recentResults(); track f.id) {
                    <app-fixture-row [fixture]="f" [prediction]="predictionFor(f.id)" />
                  }
                }
              }
            </div>

            <mat-card-actions align="end">
              <a mat-button routerLink="/predict">
                All fixtures
                <mat-icon iconPositionEnd>chevron_right</mat-icon>
              </a>
            </mat-card-actions>
          </mat-card>
        } @else {
          <!-- Tournament hasn't started, no fixtures yet -->
          <mat-card appearance="outlined" class="empty-card">
            <mat-card-header>
              <mat-icon matCardAvatar>event_busy</mat-icon>
              <mat-card-title>No fixtures yet</mat-card-title>
              <mat-card-subtitle>The schedule will populate before kickoff</mat-card-subtitle>
            </mat-card-header>
          </mat-card>
        }

        <!-- =================================================================
             Your tally
        ================================================================== -->
        @if (showTally()) {
          <mat-card appearance="outlined" class="tally-card">
            <mat-card-header>
              <mat-icon matCardAvatar>scoreboard</mat-icon>
              <mat-card-title>Your tally</mat-card-title>
              @if (rankSubtitle(); as sub) {
                <mat-card-subtitle>{{ sub }}</mat-card-subtitle>
              }
            </mat-card-header>
            <mat-card-content>
              <div class="stats-grid">
                <div class="stat">
                  <span class="stat-value">{{ totals().total }}</span>
                  <span class="stat-label">points</span>
                </div>
                <div class="stat">
                  <span class="stat-value">{{ totals().exactScoreHits }}</span>
                  <span class="stat-label">exact</span>
                </div>
                <div class="stat">
                  <span class="stat-value">{{ totals().correctOutcomeHits }}</span>
                  <span class="stat-label">outcome</span>
                </div>
              </div>
            </mat-card-content>
            <mat-card-actions align="end">
              <a mat-button routerLink="/leaderboard">
                Leaderboard
                <mat-icon iconPositionEnd>chevron_right</mat-icon>
              </a>
            </mat-card-actions>
          </mat-card>
        }
      </div>
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

    /* ----- Hero ----- */
    .hero-card {
      min-height: 96px;
    }
    .hero-card mat-card-header {
      padding: 1rem 1rem 1.25rem;
    }
    .hero-card mat-card-title {
      font: var(--mat-sys-headline-small);
      margin-bottom: 0.25rem;
    }

    /* ----- Action cards (podium banner, podium submitted) ----- */
    .action-card {
      min-height: 132px;
      display: flex;
      flex-direction: column;
    }
    .action-card mat-card-header {
      padding-top: 1rem;
      padding-bottom: 0.5rem;
      flex: 1 1 auto;
    }
    .banner { border-color: var(--mat-sys-tertiary); }
    .trophy { color: var(--mat-sys-tertiary); }

    /* ----- Matches card (merged Live / Up next / Recent) ----- */
    .fixtures-card {
      padding: 0;
      overflow: hidden;
    }
    .matches-card {
      min-height: 380px;
      display: flex;
      flex-direction: column;
    }
    .matches-tabs {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 1rem 1rem 0.75rem;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .matches-tabs mat-button-toggle-group {
      align-self: stretch;
      overflow-x: auto;
    }
    .pane-subtitle {
      margin: 0;
      font-size: 0.85rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .tab-live-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--mat-sys-error);
      margin-right: 6px;
      vertical-align: middle;
      animation: home-live-pulse 1.4s ease-in-out infinite;
    }
    @keyframes home-live-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.35); }
    }
    .rows {
      display: block;
      flex: 1 1 auto;
    }

    /* ----- Tally ----- */
    .tally-card {
      min-height: 240px;
      display: flex;
      flex-direction: column;
    }
    .tally-card mat-card-content {
      flex: 1 1 auto;
      display: flex;
      align-items: center;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.625rem;
      width: 100%;
    }
    .stat {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.25rem;
      padding: 1.25rem 0.5rem;
      min-height: 104px;
      border-radius: 14px;
      background: var(--mat-sys-surface-container-low);
      box-sizing: border-box;
    }
    .stat-value {
      font: var(--mat-sys-headline-large);
      font-variant-numeric: tabular-nums;
      color: var(--mat-sys-on-surface);
      line-height: 1;
    }
    .stat-label {
      font-size: 0.72rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--mat-sys-on-surface-variant);
    }

    /* ----- Empty state ----- */
    .empty-card {
      min-height: 140px;
    }

    /* ----- Skeleton mirroring fixture-row layout ----- */
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
    .skel-row:last-child { border-bottom: none; }
    .skel-row:nth-child(even) { background: var(--mat-sys-surface-container-low); }
    .skel-grid {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 0.75rem;
    }
    .skel-grid > app-skel:last-of-type { justify-self: end; }
    .skel-scores { display: flex; gap: 8px; }
  `,
})
export class HomeComponent {
  private readonly userService = inject(UserService);
  private readonly fixtures = inject(FixturesService);
  private readonly predictions = inject(PredictionsService);
  private readonly leaderboard = inject(LeaderboardService);

  private readonly nowTick = signal(Date.now());

  /** User's explicit tab choice. `null` means "use the prioritised default"
   *  — when set, currentView() respects the override. */
  private readonly _userSelectedView = signal<MatchView | null>(null);

  protected readonly userLoaded = this.userService.loaded;
  protected readonly fixturesLoaded = this.fixtures.loaded;
  protected readonly podiumLoaded = this.predictions.podiumLoaded;
  protected readonly totals = this.userService.totals;
  protected readonly skelRows = [0, 1, 2];

  protected readonly displayName = computed(
    () => this.userService.userDoc()?.displayName ?? '',
  );

  // --------------------------------------------------------------------------
  // Fixture buckets
  // --------------------------------------------------------------------------

  protected readonly liveFixtures = computed(() =>
    this.fixtures
      .fixtures()
      .filter((f) => f.status === 'IN_PLAY' || f.status === 'PAUSED'),
  );

  protected readonly upcomingFixtures = computed(() => {
    const now = this.nowTick();
    return this.fixtures
      .fixtures()
      .filter((f) => f.status === 'TIMED' && f.utcKickoff.getTime() > now)
      .slice(0, UPCOMING_LIMIT);
  });

  protected readonly recentResults = computed(() => {
    const all = this.fixtures
      .fixtures()
      .filter((f) => f.status === 'FINISHED' || f.status === 'AWARDED');
    return [...all]
      .sort((a, b) => b.utcKickoff.getTime() - a.utcKickoff.getTime())
      .slice(0, RECENT_LIMIT);
  });

  // --------------------------------------------------------------------------
  // Tab control
  // --------------------------------------------------------------------------

  /** Only tabs that currently have content — empty buckets get hidden so the
   *  user never lands on a blank pane. */
  protected readonly availableViews = computed<readonly MatchView[]>(() => {
    const views: MatchView[] = [];
    if (this.liveFixtures().length > 0) views.push('live');
    if (this.upcomingFixtures().length > 0) views.push('upcoming');
    if (this.recentResults().length > 0) views.push('recent');
    return views;
  });

  /** Priority: live > upcoming > recent. The user wants to see live action
   *  first if there's any happening; otherwise the next match to predict. */
  private readonly defaultView = computed<MatchView>(() => {
    const available = this.availableViews();
    if (available.includes('live')) return 'live';
    if (available.includes('upcoming')) return 'upcoming';
    return available[0] ?? 'upcoming';
  });

  protected readonly currentView = computed<MatchView>(() => {
    const override = this._userSelectedView();
    const available = this.availableViews();
    // If the override is still valid, honour it; otherwise fall back. This
    // matters when e.g. the live tab disappears after FT and we shouldn't
    // strand the user on an empty pane.
    if (override && available.includes(override)) return override;
    return this.defaultView();
  });

  protected setView(view: MatchView): void {
    this._userSelectedView.set(view);
  }

  protected viewLabel(view: MatchView): string {
    switch (view) {
      case 'live': return 'Live';
      case 'upcoming': return 'Up next';
      case 'recent': return 'Recent';
    }
  }

  /** Short contextual subtitle under the toggle group. Changes per view to
   *  give a glanceable count or countdown. */
  protected readonly paneSubtitle = computed<string | null>(() => {
    switch (this.currentView()) {
      case 'live': {
        const n = this.liveFixtures().length;
        return `${n} ${n === 1 ? 'match' : 'matches'} in play`;
      }
      case 'upcoming': {
        const list = this.upcomingFixtures();
        if (list.length === 0) return null;
        return `Next match in ${this.formatCountdown(list[0].utcKickoff.getTime() - this.nowTick())}`;
      }
      case 'recent':
        return 'How your last picks landed';
    }
  });

  private formatCountdown(ms: number): string {
    if (ms <= 0) return 'now';
    const days = Math.floor(ms / 86_400_000);
    const hours = Math.floor((ms % 86_400_000) / 3_600_000);
    const mins = Math.floor((ms % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  // --------------------------------------------------------------------------
  // Hero subtitle
  // --------------------------------------------------------------------------

  protected readonly heroSubtitle = computed(() => {
    const live = this.liveFixtures().length;
    if (live > 0) return `${live} ${live === 1 ? 'match' : 'matches'} live now`;
    const upcoming = this.upcomingFixtures();
    if (upcoming.length === 0) return 'The tournament starts June 11, 2026';
    return 'Good luck out there';
  });

  // --------------------------------------------------------------------------
  // Podium banner
  // --------------------------------------------------------------------------

  protected readonly podiumPickSubmitted = computed(
    () => this.predictions.podiumPick() !== null,
  );
  protected readonly podiumLocked = computed(() => this.nowTick() >= PODIUM_LOCK.getTime());
  protected readonly showPodiumBanner = computed(
    () =>
      this.predictions.podiumLoaded() &&
      !this.podiumPickSubmitted() &&
      !this.podiumLocked(),
  );

  // --------------------------------------------------------------------------
  // Tally / rank
  // --------------------------------------------------------------------------

  protected readonly showTally = computed(() => {
    if (this.totals().total > 0) return true;
    return this.recentResults().length > 0;
  });

  protected readonly rankSubtitle = computed<string | null>(() => {
    const entry = this.leaderboard.myEntry();
    if (!entry) return null;
    return `Global rank #${entry.rank}`;
  });

  protected predictionFor(matchId: string) {
    return this.predictions.matchPredictions().get(matchId) ?? null;
  }

  constructor() {
    const tickInterval = setInterval(() => this.nowTick.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tickInterval));
  }
}
