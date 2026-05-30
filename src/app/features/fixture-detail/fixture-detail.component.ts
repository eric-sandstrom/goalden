import { NgOptimizedImage } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  resource,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Fixture } from '../../core/models/fixture.model';
import { MatchDetail } from '../../core/models/match-detail.model';
import { CompetitionsService } from '../../core/services/competitions.service';
import { FixturesService } from '../../core/services/fixtures.service';
import { MatchDetailService } from '../../core/services/match-detail.service';
import { SkelComponent } from '../../shared/components/skel.component';
import { MatchPitchComponent } from './match-pitch.component';
import { MatchTimelineComponent } from './match-timeline.component';

@Component({
  selector: 'app-fixture-detail',
  imports: [
    NgOptimizedImage,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTabsModule,
    SkelComponent,
    MatchPitchComponent,
    MatchTimelineComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './fixture-detail.component.html',
  styleUrl: './fixture-detail.component.scss',
})
export class FixtureDetailComponent {
  private readonly fixtures = inject(FixturesService);
  private readonly matchDetail = inject(MatchDetailService);
  private readonly competitions = inject(CompetitionsService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /** football-data match id from the route (`/matches/:id`), bound via
   *  withComponentInputBinding(). Aliased so the `:id` route param maps onto
   *  this `fdid` property. Our fixture doc id is `fd-{fdid}`. */
  readonly fdid = input.required<string>({ alias: 'id' });

  protected readonly matchId = computed(() => `fd-${this.fdid()}`);

  /** Canonical fixture read, keyed on the route id — resolves the fixture
   *  even when its competition isn't in the shared store (a deep link). */
  private readonly fixtureResource = resource<Fixture | null, string>({
    params: () => this.matchId(),
    loader: ({ params }) => this.fixtures.loadFixtureById(params),
    defaultValue: null,
  });

  /** Prefer the live overlay (so an in-progress match ticks), then the
   *  shared store for instant paint, then the canonical read. */
  protected readonly fixture = computed<Fixture | null>(() => {
    const id = this.matchId();
    return (
      this.fixtures.liveFixturesById().get(id) ??
      this.fixtures.fixturesById().get(id) ??
      this.fixtureResource.value()
    );
  });

  protected readonly loaded = computed<boolean>(
    () => this.fixture() !== null || !this.fixtureResource.isLoading(),
  );

  /** The rich detail doc (goals, cards, lineups …). Null until fetched. */
  private readonly detailResource = resource<MatchDetail | null, string>({
    params: () => this.matchId(),
    loader: ({ params }) => this.matchDetail.loadDetail(params),
    defaultValue: null,
  });
  // Guard with hasValue(): a detail read can legitimately fail (a transient
  // network error, or — before the detail rule ships everywhere — a denied
  // read). value() throws on an errored resource, which would take the whole
  // view down; instead we treat any non-resolved state as "no detail yet" so
  // the scoreboard + Info tab still render and the refresh path stays open.
  protected readonly detail = computed<MatchDetail | null>(() =>
    this.detailResource.hasValue() ? this.detailResource.value() : null,
  );

  protected readonly refreshing = signal(false);

  /** Competition display name for the header chip — resolved from the
   *  catalogue, falling back to the bare shortcode until it loads. */
  protected readonly competitionName = computed<string>(() => {
    const f = this.fixture();
    if (!f) return '';
    return this.competitions.byId(f.competitionId)?.name ?? f.competitionId;
  });

  /** Competition logo for the chip. Falls back to football-data's
   *  crest-by-code endpoint when the synced emblem is missing (e.g. CL). */
  protected readonly competitionEmblem = computed<string | null>(() => {
    const f = this.fixture();
    if (!f) return null;
    return (
      this.competitions.byId(f.competitionId)?.emblem ??
      `https://crests.football-data.org/${f.competitionId}.png`
    );
  });

  /** Half-time score for the header sub-line. Null until detail loads. */
  protected readonly halfTimeLabel = computed<string | null>(() => {
    const ht = this.detail()?.score.halfTime;
    if (!ht || ht.home === null || ht.away === null) return null;
    return `${ht.home}–${ht.away}`;
  });

  /** Whether the match has reached a terminal, result-bearing state — the
   *  only point where fetching detail (and showing the refresh button) makes
   *  sense, since events never change afterwards. */
  protected readonly isTerminal = computed<boolean>(() => {
    const s = this.fixture()?.status;
    return s === 'FINISHED' || s === 'AWARDED';
  });

  /**
   * The headline score: the on-pitch result after 90 + any extra time, with
   * penalties shown separately below. For a shootout we must rebuild it from
   * the detail breakdown — the fixture's `fullTime` folds the shootout in
   * (a 1–1 won on pens reads 5–4), so we use regularTime + extraTime (e.g.
   * 1–1 + 0–0 = 1–1) instead. Non-shootout matches keep the fixture-row
   * precedence: regularTime → live → fullTime.
   */
  protected readonly displayScore = computed<{ home: number; away: number } | null>(() => {
    const f = this.fixture();
    if (!f) return null;
    const d = this.detail();
    if (d && d.score.duration === 'PENALTY_SHOOTOUT') {
      const reg = d.score.regularTime;
      if (reg && reg.home !== null && reg.away !== null) {
        const et = d.score.extraTime;
        return { home: reg.home + (et?.home ?? 0), away: reg.away + (et?.away ?? 0) };
      }
    }
    if (f.score?.regularTime) return f.score.regularTime;
    if (f.liveState === 'in' && f.liveScore) return f.liveScore;
    return f.score?.fullTime ?? null;
  });

  /** The status word shown under the score (Full time / Half-time / live
   *  minute / Upcoming). Kick-off date+time sits on its own line below. */
  protected readonly statusLabel = computed<string>(() => {
    const f = this.fixture();
    if (!f) return '';
    if (f.status === 'FINISHED' || f.status === 'AWARDED') return 'Full time';
    if (f.status === 'IN_PLAY' || f.liveState === 'in') {
      return f.liveClock ?? (typeof f.minute === 'number' ? `${f.minute}'` : 'Live');
    }
    if (f.status === 'PAUSED') return 'Half-time';
    return 'Upcoming';
  });

  /** Kick-off date + time, shown under the status label in the header. */
  protected readonly kickoffLabel = computed<string>(() => {
    const f = this.fixture();
    if (!f) return '';
    return f.utcKickoff.toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  });

  /** "After extra time" / "After penalties (5–4)" sub-line. The penalties
   *  figure is football-data's full-time aggregate (regulation + shootout,
   *  e.g. a 1–1 won 4–3 on pens reads 5–4) — the headline above shows the
   *  1–1. Null for a match decided in regulation. */
  protected readonly resultNote = computed<string | null>(() => {
    const d = this.detail();
    if (!d) return null;
    if (d.score.duration === 'PENALTY_SHOOTOUT') {
      const agg = d.score.fullTime ?? d.score.penalties;
      return agg && agg.home !== null
        ? `After penalties (${agg.home}–${agg.away})`
        : 'After penalties';
    }
    if (d.score.duration === 'EXTRA_TIME') return 'After extra time';
    return null;
  });

  /**
   * True when we've never fetched the detail doc for this match — the cue to
   * offer a refresh. Once fetched, we DON'T re-prompt even if the event list
   * looks sparse: football-data simply doesn't carry goal/card events for
   * some competitions (e.g. parts of the Champions League on the free tier),
   * and a refetch wouldn't add anything — it would just leave the button
   * showing forever on an already-loaded match.
   */
  protected readonly detailMissing = computed<boolean>(() => this.detail() === null);

  protected readonly showRefresh = computed<boolean>(
    () =>
      this.isTerminal() &&
      !this.refreshing() &&
      !this.detailResource.isLoading() &&
      this.detailMissing(),
  );

  protected readonly hasLineups = computed<boolean>(() => {
    const d = this.detail();
    if (!d) return false;
    return d.home.lineup.length > 0 || d.away.lineup.length > 0;
  });

  protected teamName(side: 'home' | 'away'): string {
    const f = this.fixture();
    const t = side === 'home' ? f?.homeTeam : f?.awayTeam;
    return t?.name ?? t?.tla ?? (side === 'home' ? 'Home' : 'Away');
  }

  /** Hide the competition logo if its URL 404s, leaving just the name. */
  protected hideBrokenEmblem(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

  // --- tab selection, persisted in the `?tab=` query param -------------------

  private readonly queryMap = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  /** Active tab index, restored from `?tab=`. Line-ups is index 1 and only
   *  exists once its data is loaded; anything else falls back to Events (0). */
  protected readonly selectedTabIndex = computed<number>(() =>
    this.queryMap().get('tab') === 'lineups' && this.hasLineups() ? 1 : 0,
  );

  protected onTabChange(index: number): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: index === 1 ? 'lineups' : 'events' },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  async refresh(): Promise<void> {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    try {
      const { throttled } = await this.matchDetail.refreshDetail(this.matchId());
      // Re-read the doc the callable just wrote (or confirmed) so the view
      // reflects it. reload() refetches even though the param is unchanged.
      this.detailResource.reload();
      this.snackBar.open(throttled ? 'Already up to date' : 'Match details updated', undefined, {
        duration: 1500,
      });
    } catch (e) {
      this.snackBar.open('Could not load details — try again', 'Dismiss', { duration: 4000 });
      console.error('refreshMatchDetail failed', e);
    } finally {
      this.refreshing.set(false);
    }
  }
}
