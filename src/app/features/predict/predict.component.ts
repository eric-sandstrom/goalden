import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  resource,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { Fixture, isKnockout } from '../../core/models/fixture.model';
import { Competition } from '../../core/models/competition.model';
import { CompetitionsService } from '../../core/services/competitions.service';
import { FixturesService } from '../../core/services/fixtures.service';
import { LeaguesService } from '../../core/services/leagues.service';
import { PredictionsService } from '../../core/services/predictions.service';
import { SkelComponent } from '../../shared/components/skel.component';
import { FixtureRowComponent } from './fixture-row.component';

type Filter = 'ALL' | 'UPCOMING' | 'LIVE' | 'FINISHED' | 'GROUP' | 'KNOCKOUTS';

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

/** localStorage key persisting the last-viewed comp across sessions so
 *  reopening the app lands the user on the tab they were on. Stored as
 *  the `${compId}_${season}` key. */
const STORAGE_KEY_SELECTED_COMP = 'goalden:predict-selected-comp';

@Component({
  selector: 'app-predict',
  imports: [
    FixtureRowComponent,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatIconModule,
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

  protected readonly filter = signal<Filter>('UPCOMING');
  protected readonly skelRows = [0, 1, 2, 3, 4, 5];

  /** "Show all" mode flips the visible-comps source from "comps I have
   *  a league in" to "every selectable comp". Lets users predict in
   *  comps before joining a league for them. */
  protected readonly showAll = signal(false);

  /** Selected tab key — `${compId}_${season}`. Hydrated from localStorage
   *  on init so reopening the app lands on the tab the user left. Cleared
   *  back to null when the persisted comp isn't in the current visible set
   *  (e.g. user left a league, or the comp's season ended). */
  private readonly _selectedKey = signal<string | null>(readSelectedKey());

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
   *  endDate — same filter the create-league picker uses). The
   *  "show all" mode source. */
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
   * The tab set the bar actually renders. Three modes:
   *   - "show all" mode → every selectable comp
   *   - user has at least one league → that league's comps
   *   - user has no leagues → fall back to all selectable so the page
   *     still shows something predictable
   */
  protected readonly visibleComps = computed<readonly CompTab[]>(() => {
    // "Show all" is an explicit user toggle — honour it immediately,
    // regardless of league-load state.
    if (this.showAll()) return this.allSelectableComps();
    // Until memberships AND every per-league doc have settled, return an
    // empty set so the bar starts at zero tabs and fills in once with the
    // user's comps — rather than flashing every selectable comp and then
    // collapsing down to "my comps" as the leagues trickle in.
    if (!this.leagues.fullyLoaded()) return [];
    const mine = this.myComps();
    if (mine.length > 0) return mine;
    return this.allSelectableComps();
  });

  /** The active tab, resolved from the persisted key against the
   *  current visible set. Falls back to the first tab when the
   *  persisted key isn't in scope any more (joined/left leagues,
   *  season rolled over). */
  protected readonly selectedComp = computed<CompTab | null>(() => {
    const visible = this.visibleComps();
    if (visible.length === 0) return null;
    const key = this._selectedKey();
    if (key) {
      const match = visible.find((c) => c.key === key);
      if (match) return match;
    }
    return visible[0];
  });

  /**
   * Competition bar visibility. Show it when there's more than one
   * competition the user can reach:
   *   - they're already viewing multiple (their leagues span comps, or
   *     "show all" is on), OR
   *   - "show all" would reveal selectable comps beyond their current set.
   *
   * That second clause is the important one: the show-all toggle lives
   * *inside* this bar, so gating purely on `visibleComps().length > 1`
   * traps a user who's in a single league (e.g. just the auto-enrolled
   * WC global league) — they'd have no affordance to reach any other
   * competition. Only when the catalogue genuinely has nothing else to
   * switch to do we hide the bar entirely.
   */
  protected readonly showTabBar = computed(() => {
    // Keep the bar hidden until the visible set is settled, so it never
    // flashes empty (or half-populated) while leagues load. "Show all"
    // resolves its set synchronously, so it's exempt from the gate.
    if (!this.showAll() && !this.leagues.fullyLoaded()) return false;
    if (this.visibleComps().length > 1) return true;
    return this.allSelectableComps().length > this.visibleComps().length;
  });

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
    if (!this.showAll() && !this.leagues.fullyLoaded()) return false;
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
    // Persist the selected tab to localStorage whenever it changes, so
    // a refresh / reopen lands on the same comp. Reads via the resolved
    // signal so we capture the actual chosen value even when it falls
    // back from a stale persisted key.
    effect(() => {
      const sel = this.selectedComp();
      if (sel) writeSelectedKey(sel.key);
    });
  }

  /** Called by the tab bar's (change) event. Persistence happens via the
   *  effect above — this just updates the signal. */
  protected selectComp(key: string): void {
    this._selectedKey.set(key);
  }

  protected toggleShowAll(): void {
    this.showAll.update((v) => !v);
  }

  /** Re-run the fixtures resource loader after a failed load. */
  protected retry(): void {
    this.fixturesResource.reload();
  }

  protected predictionFor(matchId: string) {
    return this.predictionsService.matchPredictions().get(matchId) ?? null;
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

function readSelectedKey(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(STORAGE_KEY_SELECTED_COMP);
  } catch {
    return null;
  }
}

function writeSelectedKey(key: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY_SELECTED_COMP, key);
  } catch {
    // localStorage disabled / quota exceeded — fine, signal still drives
    // current-session behaviour, only persistence is lost.
  }
}
