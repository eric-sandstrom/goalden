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
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { FixturesService } from '../../core/services/fixtures.service';
import { LeaderboardService } from '../../core/services/leaderboard.service';
import { LeaguesService } from '../../core/services/leagues.service';
import { PredictionsService } from '../../core/services/predictions.service';
import { UserService } from '../../core/services/user.service';
import { Fixture } from '../../core/models/fixture.model';
import { PODIUM_LOCK } from '../../core/models/podium.model';
import { SkelComponent } from '../../shared/components/skel.component';
import { FixtureRowComponent } from '../predict/fixture-row.component';

type MatchView = 'live' | 'upcoming' | 'recent';

/** A (competition, season) pair to load fixtures for. */
interface CompKey {
  readonly compId: string;
  readonly season: string;
}

const UPCOMING_LIMIT = 3;
const RECENT_LIMIT = 3;

@Component({
  selector: 'app-home',
  imports: [
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatTabsModule,
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
  private readonly leagues = inject(LeaguesService);

  private readonly nowTick = signal(Date.now());

  /** User's explicit tab choice. `null` means "use the prioritised default"
   *  — when set, currentView() respects the override. */
  private readonly _userSelectedView = signal<MatchView | null>(null);

  protected readonly userLoaded = this.userService.loaded;

  /**
   * The (comp, season) pairs Home loads fixtures for: every distinct
   * competition the user has joined a league in. Home only surfaces
   * matches the user can act on, so it's scoped strictly to their league
   * memberships — fixtures from comps they haven't joined never appear
   * (unlike Predict, which can show all selectable comps via its show-all
   * toggle). Empty while leagues are still settling so the loading state
   * holds rather than flashing an empty set.
   */
  private readonly compKeys = computed<readonly CompKey[]>(() => {
    if (!this.leagues.fullyLoaded()) return [];
    const mine = new Map<string, CompKey>();
    for (const { league } of this.leagues.myLeagueList()) {
      const key = `${league.competitionId}_${league.season}`;
      if (!mine.has(key)) {
        mine.set(key, { compId: league.competitionId, season: league.season });
      }
    }
    return [...mine.values()];
  });

  /**
   * Every loaded fixture across all of the user's comps. Reading each
   * comp's `fixturesFor` signal both registers it for loading and tracks
   * it reactively; the shared store already has the live overlay merged
   * in, so live scores surface here without extra wiring.
   */
  private readonly allFixtures = computed<readonly Fixture[]>(() => {
    const out: Fixture[] = [];
    for (const { compId, season } of this.compKeys()) {
      out.push(...this.fixtures.fixturesFor(compId, season)());
    }
    return out;
  });

  /** True once every requested comp's fixtures have loaded. Holds false
   *  while leagues are still resolving so the skeleton shows instead of a
   *  premature empty state. */
  protected readonly fixturesLoaded = computed<boolean>(() => {
    if (!this.leagues.fullyLoaded()) return false;
    const keys = this.compKeys();
    if (keys.length === 0) return true;
    return keys.every(({ compId, season }) => this.fixtures.loadedFor(compId, season)());
  });

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
    this.allFixtures()
      .filter((f) => f.status === 'IN_PLAY' || f.status === 'PAUSED')
      .sort((a, b) => a.utcKickoff.getTime() - b.utcKickoff.getTime()),
  );

  protected readonly upcomingFixtures = computed(() => {
    const now = this.nowTick();
    // Sorted across comps so the soonest kickoff anywhere comes first —
    // each comp's list is sorted internally, but the concatenation isn't.
    return this.allFixtures()
      .filter((f) => f.status === 'TIMED' && f.utcKickoff.getTime() > now)
      .sort((a, b) => a.utcKickoff.getTime() - b.utcKickoff.getTime())
      .slice(0, UPCOMING_LIMIT);
  });

  protected readonly recentResults = computed(() => {
    return this.allFixtures()
      .filter((f) => f.status === 'FINISHED' || f.status === 'AWARDED')
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
