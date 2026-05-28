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
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
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
  /**
   * Hardcoded to WC for now — Home's "live / upcoming / recent" tabs are
   * still WC-only because the user's set of comps isn't wired here yet.
   * A follow-up turns this into a derived list of (comp, season) pairs
   * from the user's league memberships, then iterates fixturesFor each.
   */
  private readonly _wcFixtures = this.fixtures.fixturesFor('WC', '2026');
  protected readonly fixturesLoaded = this.fixtures.loadedFor('WC', '2026');
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
    this._wcFixtures().filter((f) => f.status === 'IN_PLAY' || f.status === 'PAUSED'),
  );

  protected readonly upcomingFixtures = computed(() => {
    const now = this.nowTick();
    return this._wcFixtures()
      .filter((f) => f.status === 'TIMED' && f.utcKickoff.getTime() > now)
      .slice(0, UPCOMING_LIMIT);
  });

  protected readonly recentResults = computed(() => {
    const all = this._wcFixtures().filter(
      (f) => f.status === 'FINISHED' || f.status === 'AWARDED',
    );
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
