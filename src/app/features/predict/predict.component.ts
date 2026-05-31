import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  resource,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { Fixture, LegInfo, buildLegMap, isKnockout } from '../../core/models/fixture.model';
import { Competition } from '../../core/models/competition.model';
import { CompetitionsService } from '../../core/services/competitions.service';
import { FixturesService } from '../../core/services/fixtures.service';
import { LeaguesService } from '../../core/services/leagues.service';
import { PredictionsService } from '../../core/services/predictions.service';
import { SkelComponent } from '../../shared/components/skel.component';
import { FixtureRowComponent } from './fixture-row.component';
import {
  readSelectedComp,
  readSelectedTab,
  writeSelectedComp,
  writeSelectedTab,
} from './predict-view-storage';

type Filter = 'ALL' | 'UPCOMING' | 'LIVE' | 'FINISHED' | 'GROUP' | 'KNOCKOUTS';

/** Every filter value, used to validate the `:tab` URL segment. */
const FILTERS: readonly Filter[] = [
  'ALL',
  'UPCOMING',
  'LIVE',
  'FINISHED',
  'GROUP',
  'KNOCKOUTS',
];

interface DateGroup {
  readonly label: string;
  readonly key: string;
  readonly fixtures: readonly Fixture[];
}

/** A (Competition, season) pair the tabs surface. Bundles together so
 *  template + state code don't have to look up the season separately. */
interface CompTab {
  readonly comp: Competition;
  readonly season: string;
  readonly key: string; // `${comp.id}_${season}` — used as the tab value
}

@Component({
  selector: 'app-predict',
  imports: [
    FixtureRowComponent,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatIconModule,
    MatTabsModule,
    SkelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './predict.component.html',
  styleUrl: './predict.component.scss',
})
export class PredictComponent {
  private readonly fixturesService = inject(FixturesService);
  private readonly predictionsService = inject(PredictionsService);
  private readonly competitionsService = inject(CompetitionsService);
  private readonly leagues = inject(LeaguesService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);

  /** `{ comp, tab }` read off the URL query string (`?comp=…&tab=…`).
   *  Re-derives whenever the query params change; the map signal is seeded
   *  synchronously so the first render already reflects a deep-linked /
   *  refreshed URL. */
  private readonly queryMap = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });
  private readonly urlParams = computed<{ comp: string | null; tab: string | null }>(() => {
    const q = this.queryMap();
    return { comp: q.get('comp'), tab: q.get('tab') };
  });

  protected readonly skelRows = [0, 1, 2, 3, 4, 5];

  /** Label-placeholder widths for the comp-bar skeleton — a few short
   *  shimmer bars sat inside outlined toggle cells, shown while leagues
   *  load so the bar reserves its space instead of popping in. */
  protected readonly compTabSkels = ['44px', '32px', '38px'];

  /** Active filter chip. The `?tab` query param wins while you're on the page;
   *  on a *bare* `/matches` entry (no `?tab`) it falls back to the last-viewed
   *  tab from localStorage — same precedence as `selectedComp`. This lets a
   *  bare entry restore the filter from storage alone, so canonicalising the
   *  URL can be a silent `replaceState` (see the constructor effect) rather
   *  than a second router navigation. Defaults to UPCOMING. */
  protected readonly filter = computed<Filter>(
    () => parseFilter(this.urlParams().tab) ?? parseFilter(readSelectedTab()) ?? 'UPCOMING',
  );

  /** Comps the user is in (one entry per unique competitionId+season
   *  across their league memberships). Defaults the tab set unless the
   *  user is in zero leagues — see `visibleComps` for the fallback. */
  private readonly myComps = computed<readonly CompTab[]>(() => {
    const memberships = this.leagues.myLeagueList();
    const seen = new Map<string, CompTab>();
    for (const { league } of memberships) {
      const key = `${league.competitionId}_${league.season}`;
      if (seen.has(key)) continue;
      const comp = this.competitionsService.byId(league.competitionId);
      if (!comp) continue;
      seen.set(key, { comp, season: league.season, key });
    }
    return [...seen.values()].sort((a, b) => a.comp.name.localeCompare(b.comp.name));
  });

  /** Every comp users are allowed to predict in (filtered by future
   *  endDate — same filter the create-league picker uses). Used as the
   *  fallback tab set for users who aren't in any league yet. */
  private readonly allSelectableComps = computed<readonly CompTab[]>(() => {
    return this.competitionsService
      .selectableCompetitions()
      .map((comp) => {
        const season = seasonFromComp(comp);
        if (!season) return null;
        return { comp, season, key: `${comp.id}_${season}` };
      })
      .filter((x): x is CompTab => x !== null);
  });

  /**
   * The tab set the bar actually renders. Two modes:
   *   - user has at least one league → that league's comps
   *   - user has no leagues → fall back to all selectable so the page
   *     still shows something predictable
   */
  protected readonly visibleComps = computed<readonly CompTab[]>(() => {
    // Until memberships AND every per-league doc have settled, return an
    // empty set so the bar starts at zero tabs and fills in once with the
    // user's comps — rather than flashing every selectable comp and then
    // collapsing down to "my comps" as the leagues trickle in.
    if (!this.leagues.fullyLoaded()) return [];
    const mine = this.myComps();
    if (mine.length > 0) return mine;
    return this.allSelectableComps();
  });

  /** The active comp, resolved from the URL `:comp` segment against the
   *  current visible set. Key precedence: URL → last-viewed (localStorage,
   *  for a bare entry before the URL carries a comp) → first visible tab.
   *  Falls back to the first tab when the requested key isn't in scope any
   *  more (joined/left leagues, season rolled over). */
  protected readonly selectedComp = computed<CompTab | null>(() => {
    const visible = this.visibleComps();
    if (visible.length === 0) return null;
    const key = this.urlParams().comp ?? readSelectedComp();
    if (key) {
      const match = visible.find((c) => c.key === key);
      if (match) return match;
    }
    return visible[0];
  });

  /**
   * Competition bar visibility. Show it only when there's more than one
   * competition to switch between — a single-comp bar is just a static
   * label, so we hide it.
   */
  protected readonly showTabBar = computed(() => {
    // Keep the bar hidden until the visible set is settled, so it never
    // flashes empty (or half-populated) while leagues load.
    if (!this.leagues.fullyLoaded()) return false;
    return this.visibleComps().length > 1;
  });

  /** While leagues are still loading we can't know the real tabs yet — but
   *  rather than leave a gap that pops in late, render a placeholder bar
   *  with skeleton chips. Mirrors `showTabBar`'s load gate, so the
   *  placeholder hands straight over to the real bar (or to nothing, when
   *  there's only one comp and the bar stays hidden). */
  protected readonly compBarLoading = computed(() => !this.leagues.fullyLoaded());

  /**
   * Fixtures for the selected comp, loaded via an Angular `resource`.
   * The reactive `params` watches the selected (comp, season) and the
   * loader maps it to that comp's fixtures; `isLoading`/`error` drive
   * the view's loading/error states.
   *
   * `params` returns the stable `${compId}_${season}` key (not a fresh
   * object) so the resource only reloads when the comp actually
   * changes — re-resolving `selectedComp` to an equal comp (e.g. when
   * league data refreshes) produces an identical string and is a no-op.
   * Returning `undefined` (no comp yet) leaves the resource idle.
   */
  private readonly fixturesResource = resource<
    readonly Fixture[],
    string | undefined
  >({
    params: () => this.selectedComp()?.key,
    loader: ({ params }) => {
      const sep = params.indexOf('_');
      const compId = params.slice(0, sep);
      const season = params.slice(sep + 1);
      return this.fixturesService.loadFixtures(compId, season);
    },
    defaultValue: [],
  });

  /** The resource's loaded set with live scores overlaid. The live map
   *  is empty unless a match is in progress, in which case the matching
   *  fixtures are swapped for their live versions. */
  private readonly currentFixtures = computed<readonly Fixture[]>(() => {
    const base = this.fixturesResource.value();
    const live = this.fixturesService.liveFixturesById();
    if (live.size === 0) return base;
    return base.map((f) => live.get(f.id) ?? f);
  });

  /** Drives skeleton vs content. Stays "loading" while the comp set is
   *  still resolving (so we never flash an empty state before the tabs
   *  appear) and while the selected comp's resource is fetching. */
  protected readonly loaded = computed(() => {
    if (!this.leagues.fullyLoaded()) return false;
    if (!this.selectedComp()) return true; // settled with no comp to load
    return !this.fixturesResource.isLoading();
  });

  /** True when the resource load failed AND there was no cache to fall
   *  back on — the view shows a retry affordance. */
  protected readonly loadError = computed(() => this.fixturesResource.status() === 'error');

  protected readonly groups = computed<readonly DateGroup[]>(() => {
    const all = this.currentFixtures();
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

  /**
   * Some filter chips don't apply to every comp. GROUP/KNOCKOUTS are
   * tournament concepts (WC, Euros, CL); a Premier League tab showing
   * them would just produce empty results. Hide them when the selected
   * comp is a LEAGUE type so the chip row stays tight + relevant.
   */
  protected readonly showStageFilters = computed(() => {
    const sel = this.selectedComp();
    return sel ? sel.comp.type === 'CUP' : false;
  });

  constructor() {
    effect(() => {
      const sel = this.selectedComp();
      if (!sel) return;
      const url = this.urlParams();
      // Remember the resolved comp + the active tab so a future bare
      // /matches restores both. Only persist the tab when it's actually in
      // the URL — never the UPCOMING default a bare entry resolves to, or
      // we'd clobber the saved value before we get to use it below.
      writeSelectedComp(sel.key);
      if (url.tab) writeSelectedTab(url.tab);
      // Canonicalise the URL when it doesn't already name the resolved comp:
      //   - bare /matches (no ?comp) — write the restored saved comp/tab (or a
      //     resolved first-visit default) into the query string;
      //   - a stale/unknown ?comp the user can't see any more (left the
      //     league, season rolled over) — selectedComp fell back to the
      //     first tab, so realign the URL to it.
      //
      // Do this with a SILENT `replaceState`, not a router navigation. The
      // signals above already reflect the resolved comp/tab (both selectedComp
      // and filter fall back to localStorage), so nothing in the view depends
      // on the route carrying these params — all that's left is to make the
      // address bar / a future refresh / share URL carry them. A second
      // `router.navigate` here would run another `withViewTransitions` cycle
      // right after the bottom-nav tab switch: the visible double-step the user
      // sees ( /matches  →  /matches?comp=…&tab=… ). replaceState rewrites the
      // URL in place with no navigation, so there's no second transition and no
      // content re-render. (filter() already carries the saved-tab fallback.)
      if (url.comp !== sel.key) {
        const qs = new URLSearchParams({ comp: sel.key, tab: this.filter().toLowerCase() });
        this.location.replaceState('/matches', qs.toString());
      }
    });
  }

  /** Called by the tab bar's (change) event — writes the comp into the URL
   *  (keeping the current filter). The signals follow from the navigation.
   *  replaceUrl: switching comp never leaves the Predict view, so it should
   *  replace the current history entry rather than stack up tab-flip back
   *  steps. */
  protected selectComp(key: string): void {
    void this.navigateTo(key, this.filter(), { replaceUrl: true });
  }

  /** Called by the filter chips — writes the filter into the URL (keeping
   *  the current comp). No-op until a comp has resolved. replaceUrl for the
   *  same reason as selectComp: it's an in-view state change, not a real
   *  navigation. */
  protected selectFilter(f: Filter): void {
    const key = this.selectedComp()?.key;
    if (key) void this.navigateTo(key, f, { replaceUrl: true });
  }

  private navigateTo(
    compKey: string,
    f: Filter,
    extras?: { replaceUrl: boolean },
  ): Promise<boolean> {
    return this.router.navigate(['/matches'], {
      queryParams: { comp: compKey, tab: f.toLowerCase() },
      ...extras,
    });
  }

  /** Re-run the fixtures resource loader after a failed load. */
  protected retry(): void {
    this.fixturesResource.reload();
  }

  protected predictionFor(matchId: string) {
    return this.predictionsService.matchPredictions().get(matchId) ?? null;
  }

  /** Competition crest URL. Falls back to football-data's crest-by-code
   *  endpoint when the synced `emblem` is missing (e.g. CL, whose API
   *  record has a null emblem) — the API hosts standard crests at
   *  `/<CODE>.png`. `hideBrokenCrest` removes the <img> if the derived URL
   *  404s, so a comp with no resolvable crest just shows its label. */
  protected crestFor(comp: Competition): string {
    return comp.emblem ?? `https://crests.football-data.org/${comp.id}.png`;
  }

  /** Hide a crest <img> whose src failed to load (a derived fallback URL
   *  that doesn't exist), leaving just the comp label. */
  protected hideBrokenCrest(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

  /** `matchId → leg position` for the comp's two-legged knockout ties, so each
   *  leg's row can show a "1st leg" / "2nd leg" badge. Empty for single-match
   *  competitions (the World Cup) — those fixtures pair to nothing. */
  private readonly legMap = computed<ReadonlyMap<string, LegInfo>>(() =>
    buildLegMap(this.currentFixtures()),
  );

  protected legFor(matchId: string): LegInfo | null {
    return this.legMap().get(matchId) ?? null;
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

/** Pulls the season starting calendar year out of the API's date format
 *  on a Competition's currentSeason. Mirrors the same helper in
 *  CreateLeagueDialogComponent; kept inline rather than shared because
 *  the two surfaces are independent. */
function seasonFromComp(comp: Competition | null): string | null {
  if (!comp?.currentSeason?.startDate) return null;
  const startDate = comp.currentSeason.startDate;
  if (startDate.length < 4) return null;
  return startDate.slice(0, 4);
}

/** Parse a `tab` query value back to a Filter, case-insensitively. Returns
 *  null for an absent or unrecognised value so callers can default. */
function parseFilter(raw: string | null): Filter | null {
  if (!raw) return null;
  const up = raw.toUpperCase();
  return (FILTERS as readonly string[]).includes(up) ? (up as Filter) : null;
}

