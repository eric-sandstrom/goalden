import { NgOptimizedImage } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
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
import { Head2Head, MatchDetail } from '../../core/models/match-detail.model';
import { CompetitionsService } from '../../core/services/competitions.service';
import { FixturesService } from '../../core/services/fixtures.service';
import { MatchDetailService } from '../../core/services/match-detail.service';
import { MatchTransitionService } from '../../core/services/match-transition.service';
import { SkelComponent } from '../../shared/components/skel.component';
import { MatchHead2HeadComponent } from './match-head2head.component';
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
    MatchHead2HeadComponent,
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
  private readonly matchTransition = inject(MatchTransitionService);

  constructor() {
    // Keep this match marked as the shared-transition participant so leaving
    // the detail back to the list morphs the scoreboard into the right row
    // (covers browser-back and deep-link → back paths the forward click can't).
    effect(() => this.matchTransition.activate(this.fdid()));

    // Stream detail/full live while the match is in play, so goals/cards/subs
    // tick into the timeline + line-ups without a manual refresh. Only while
    // live — a listener costs a read per write, and line-ups/finals don't
    // change outside play, so the one-shot resource covers everything else.
    // Tag the value with the match id so a stale value from a previous match
    // (the component is reused across `/matches/:id` navigations) is ignored.
    effect((onCleanup) => {
      const id = this.matchId();
      const status = this.fixture()?.status;
      if (status !== 'IN_PLAY' && status !== 'PAUSED') return;
      const unsub = this.matchDetail.subscribeDetail(id, (d) =>
        this.liveDetail.set({ id, detail: d }),
      );
      onCleanup(() => unsub());
    });
  }

  /** Latest live `detail/full`, tagged with the match it belongs to. Kept after
   *  full-time so the final events don't revert to the stale one-shot read. */
  private readonly liveDetail = signal<{ id: string; detail: MatchDetail | null } | null>(null);

  /** football-data match id from the route (`/matches/:id`), bound via
   *  withComponentInputBinding(). Aliased so the `:id` route param maps onto
   *  this `fdid` property. Our fixture doc id is `fd-{fdid}`. */
  readonly fdid = input.required<string>({ alias: 'id' });

  protected readonly matchId = computed(() => `fd-${this.fdid()}`);

  /**
   * Full fixture handed over in router state by the originating list row.
   *
   * It lets the scoreboard paint on the component's FIRST render, before the
   * async fixture read resolves. This is load-bearing for the shared-element
   * view transition: on a cold entry (e.g. a fresh load straight onto
   * `/matches`), the fixture isn't in the warm `fixturesById` store yet and the
   * `resource()` is still loading, so without a seed the first render is the
   * skeleton — which carries no `view-transition-name`s. The router snapshots
   * the incoming view right after that first render, so the morph has nothing
   * to pair with and only the page slide plays. Seeding paints the named
   * scoreboard immediately, so the snapshot includes the shared elements.
   *
   * Null on a deep link / refresh (no originating navigation state), where
   * there's no row to morph from anyway — that path falls back to the resource.
   */
  private readonly seededFixture =
    (this.router.getCurrentNavigation()?.extras.state?.['vtFixture'] as Fixture | undefined) ??
    null;

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
      this.seededFixture ??
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
  //
  // Live overlay: while a match is in play the subscription above keeps
  // `liveDetail` fresh; prefer it (for THIS match) over the one-shot resource
  // so the timeline updates in real time. Falls back to the resource for
  // pre-match line-ups and finished matches that aren't being streamed.
  protected readonly detail = computed<MatchDetail | null>(() => {
    const live = this.liveDetail();
    if (live && live.id === this.matchId() && live.detail) return live.detail;
    return this.detailResource.hasValue() ? this.detailResource.value() : null;
  });

  /** Head-to-head doc — one-shot (the poller writes it once, it never changes).
   *  Keyed on the route id like the detail read. */
  private readonly head2headResource = resource<Head2Head | null, string>({
    params: () => this.matchId(),
    loader: ({ params }) => this.matchDetail.loadHead2Head(params),
    defaultValue: null,
  });
  protected readonly head2head = computed<Head2Head | null>(() =>
    this.head2headResource.hasValue() ? this.head2headResource.value() : null,
  );
  protected readonly hasHead2Head = computed<boolean>(() => {
    const h = this.head2head();
    return !!h && (h.aggregates !== null || h.matches.length > 0);
  });

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

  /** Tab keys in render order. Optional tabs (line-ups, head2head) appear only
   *  once their data loads, so positional indices shift — deriving them here
   *  keeps index ↔ key correct. MUST match the template's tab order. */
  protected readonly tabKeys = computed<readonly string[]>(() => {
    const keys = ['events'];
    if (this.hasLineups()) keys.push('lineups');
    if (this.hasHead2Head()) keys.push('h2h');
    return keys;
  });

  /** Active tab index, restored from `?tab=`; falls back to Events (0) when the
   *  requested tab isn't present (e.g. its data hasn't loaded). */
  protected readonly selectedTabIndex = computed<number>(() => {
    const want = this.queryMap().get('tab') ?? 'events';
    const i = this.tabKeys().indexOf(want);
    return i >= 0 ? i : 0;
  });

  protected onTabChange(index: number): void {
    const tab = this.tabKeys()[index] ?? 'events';
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab },
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
