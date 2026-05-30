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
import { MatListModule } from '@angular/material/list';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Fixture } from '../../core/models/fixture.model';
import { MatchDetail, MatchLineup, MatchPlayer } from '../../core/models/match-detail.model';
import { CompetitionsService } from '../../core/services/competitions.service';
import { FixturesService } from '../../core/services/fixtures.service';
import { MatchDetailService } from '../../core/services/match-detail.service';
import { TeamsService } from '../../core/services/teams.service';
import { SkelComponent } from '../../shared/components/skel.component';

type Side = 'home' | 'away' | 'neutral';

interface TimelineItem {
  readonly key: string;
  readonly sortKey: number;
  readonly minuteLabel: string;
  readonly side: Side;
  readonly kind: 'goal' | 'yellow' | 'red';
  readonly player: string;
  readonly note: string | null;
}

interface InfoRow {
  readonly icon: string;
  readonly label: string;
  readonly value: string;
}

type TabId = 'info' | 'lineups' | 'officials';

interface DetailTab {
  readonly id: TabId;
  readonly icon: string;
  /** Tooltip + accessible name for the icon-only rail button. */
  readonly label: string;
}

/** A starter placed on the pitch — coordinates are percentages of the pitch
 *  box (x: 0 left … 100 right, y: 0 top … 100 bottom). */
interface PitchMarker {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly number: string;
  readonly name: string;
  readonly side: 'home' | 'away';
}

interface SubItem {
  readonly key: string;
  readonly side: Side;
  readonly minute: number | null;
  readonly inName: string;
  readonly outName: string;
}

@Component({
  selector: 'app-fixture-detail',
  imports: [
    NgOptimizedImage,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatListModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    SkelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './fixture-detail.component.html',
  styleUrl: './fixture-detail.component.scss',
})
export class FixtureDetailComponent {
  private readonly fixtures = inject(FixturesService);
  private readonly matchDetail = inject(MatchDetailService);
  private readonly competitions = inject(CompetitionsService);
  private readonly teamsService = inject(TeamsService);
  private readonly snackBar = inject(MatSnackBar);

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

  /**
   * Per-team marker colours from each club's two `clubColors`. Both teams use
   * both colours, inverted so they stay distinct: the home marker is filled
   * with colour 1 and ringed with colour 2; the away marker is filled with
   * colour 2 and ringed with colour 1. `fg` is the black/white that reads on
   * the fill. Falls back to a blue + its contrast when a club has no colours.
   */
  protected readonly teamColors = computed<{
    home: { fill: string; ring: string; fg: string };
    away: { fill: string; ring: string; fg: string };
  }>(() => {
    const f = this.fixture();
    const pair = (teamId: number | null | undefined): { c1: string; c2: string } => {
      const colors = clubColorList(teamId != null ? this.teamsService.byExternalId(teamId)?.clubColors : null);
      const c1 = (colors[0] && colorToHex(colors[0])) || '#1565c0';
      // Second colour, or a contrasting tone so the ring is always visible.
      const c2 = (colors[1] && colorToHex(colors[1])) || textOn(c1);
      return { c1, c2 };
    };
    const home = pair(f?.homeTeam.id);
    const away = pair(f?.awayTeam.id);
    return {
      home: { fill: home.c1, ring: home.c2, fg: textOn(home.c1) },
      away: { fill: away.c2, ring: away.c1, fg: textOn(away.c2) },
    };
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

  /** Goals + cards merged into one chronological timeline (shown in the Info
   *  tab). */
  protected readonly timeline = computed<readonly TimelineItem[]>(() => {
    const d = this.detail();
    const f = this.fixture();
    if (!d || !f) return [];
    const items: TimelineItem[] = [];

    d.goals.forEach((g, i) => {
      const note =
        g.type === 'OWN'
          ? 'Own goal'
          : [g.type === 'PENALTY' ? 'Penalty' : null, g.assist?.name ? `assist ${g.assist.name}` : null]
              .filter(Boolean)
              .join(' · ') || null;
      items.push({
        key: `g${i}`,
        sortKey: sortKey(g.minute, g.injuryTime),
        minuteLabel: minuteLabel(g.minute, g.injuryTime),
        side: this.sideOf(g.teamId),
        kind: 'goal',
        player: g.scorer?.name ?? 'Goal',
        note,
      });
    });

    d.bookings.forEach((b, i) => {
      items.push({
        key: `b${i}`,
        sortKey: sortKey(b.minute, null),
        minuteLabel: minuteLabel(b.minute, null),
        side: this.sideOf(b.teamId),
        kind: b.card === 'RED' ? 'red' : 'yellow',
        player: b.player?.name ?? (b.card === 'RED' ? 'Red card' : 'Booking'),
        note: null,
      });
    });

    return items.sort((a, b) => a.sortKey - b.sortKey);
  });

  protected readonly hasTimeline = computed(() => this.timeline().length > 0);

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

  protected readonly hasReferees = computed(() => (this.detail()?.referees.length ?? 0) > 0);

  /** Match meta for the Info tab. Competition, stage, kick-off, venue and
   *  half-time all live in the header now, so only the leftover extras
   *  (group, attendance) remain here. */
  protected readonly infoRows = computed<readonly InfoRow[]>(() => {
    const f = this.fixture();
    if (!f) return [];
    const d = this.detail();
    const rows: InfoRow[] = [];
    if (f.group) rows.push({ icon: 'grid_view', label: 'Group', value: f.group });
    if (typeof d?.attendance === 'number') {
      rows.push({ icon: 'groups', label: 'Attendance', value: d.attendance.toLocaleString() });
    }
    return rows;
  });

  /** Marker fill / ring / text colour for a side, for inline binding. */
  protected fill(side: 'home' | 'away'): string {
    return side === 'home' ? this.teamColors().home.fill : this.teamColors().away.fill;
  }
  protected ring(side: 'home' | 'away'): string {
    return side === 'home' ? this.teamColors().home.ring : this.teamColors().away.ring;
  }
  protected fg(side: 'home' | 'away'): string {
    return side === 'home' ? this.teamColors().home.fg : this.teamColors().away.fg;
  }

  /** Hide the competition logo if its URL 404s, leaving just the name. */
  protected hideBrokenEmblem(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

  // --- pitch + substitutions (Line-ups tab) ----------------------------------

  /** Starting XIs placed on the pitch — home on the bottom half, away mirrored
   *  on the top half, both laid out by their formation. */
  protected readonly pitchMarkers = computed<readonly PitchMarker[]>(() => {
    const home = this.lineupFor('home');
    const away = this.lineupFor('away');
    if (!home && !away) return [];
    return [
      ...(home ? markersForTeam(buildRows(home), 'home') : []),
      ...(away ? markersForTeam(buildRows(away), 'away') : []),
    ];
  });

  protected readonly subs = computed<readonly SubItem[]>(() => {
    const d = this.detail();
    if (!d) return [];
    return d.substitutions.map((s, i) => ({
      key: `s${i}`,
      side: this.sideOf(s.teamId),
      minute: s.minute,
      inName: s.playerIn?.name ?? '—',
      outName: s.playerOut?.name ?? '—',
    }));
  });

  /** Substitutions for one team, so the Line-ups tab can group them under a
   *  team heading (the flat list didn't say who subbed for whom). */
  protected subsFor(side: 'home' | 'away'): readonly SubItem[] {
    return this.subs().filter((s) => s.side === side);
  }

  // --- vertical icon-rail tabs -----------------------------------------------

  /** The tabs the rail shows, top to bottom. Info (events + meta) is always
   *  present; Line-ups / Officials appear only when their data is loaded. */
  protected readonly availableTabs = computed<readonly DetailTab[]>(() => {
    const tabs: DetailTab[] = [{ id: 'info', icon: 'subject', label: 'Events & info' }];
    if (this.hasLineups()) tabs.push({ id: 'lineups', icon: 'groups', label: 'Line-ups & subs' });
    if (this.hasReferees()) tabs.push({ id: 'officials', icon: 'sports', label: 'Officials' });
    return tabs;
  });

  /** User's explicit pick; null until they tap a tab (then `activeId` falls
   *  back to the first available one). */
  private readonly selectedId = signal<TabId | null>(null);

  /** The resolved active tab — the user's pick when it's still available,
   *  otherwise the first tab in the rail (Info / events). */
  protected readonly activeId = computed<TabId>(() => {
    const tabs = this.availableTabs();
    const sel = this.selectedId();
    if (sel && tabs.some((t) => t.id === sel)) return sel;
    return tabs[0]?.id ?? 'info';
  });

  /** Direction the panel slides on the last switch — 'down' when moving to a
   *  lower tab in the rail (content enters from below), 'up' otherwise. */
  protected readonly slideDir = signal<'up' | 'down'>('down');

  protected selectTab(id: TabId): void {
    const tabs = this.availableTabs();
    const from = tabs.findIndex((t) => t.id === this.activeId());
    const to = tabs.findIndex((t) => t.id === id);
    this.slideDir.set(to >= from ? 'down' : 'up');
    this.selectedId.set(id);
  }

  /** Side ('home' badge column) for a given event team id. */
  protected sideOf(teamId: number | null): Side {
    const f = this.fixture();
    if (!f || teamId === null) return 'neutral';
    if (teamId === f.homeTeam.id) return 'home';
    if (teamId === f.awayTeam.id) return 'away';
    return 'neutral';
  }

  protected lineupFor(side: 'home' | 'away'): MatchLineup | null {
    const d = this.detail();
    if (!d) return null;
    return side === 'home' ? d.home : d.away;
  }

  protected teamName(side: 'home' | 'away'): string {
    const f = this.fixture();
    const t = side === 'home' ? f?.homeTeam : f?.awayTeam;
    return t?.name ?? t?.tla ?? (side === 'home' ? 'Home' : 'Away');
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

/** Sortable key from minute + stoppage so 45+2 falls between 45 and 46. */
function sortKey(minute: number | null, injuryTime: number | null): number {
  return (minute ?? 0) * 100 + (injuryTime ?? 0);
}

function minuteLabel(minute: number | null, injuryTime: number | null): string {
  if (minute === null) return '';
  return injuryTime ? `${minute}+${injuryTime}'` : `${minute}'`;
}

/** Common football `clubColors` names → hex. football-data gives free text
 *  like "Sky Blue / White"; we map the words we see, falling back to a
 *  default for anything unrecognised. */
const TEAM_COLORS: Record<string, string> = {
  white: '#fafafa',
  black: '#1b1b1b',
  red: '#d32f2f',
  'dark red': '#8e1616',
  blue: '#1565c0',
  'royal blue': '#1e50c8',
  'navy blue': '#10204a',
  navy: '#10204a',
  'sky blue': '#6ca6dc',
  'light blue': '#7fb1e0',
  sky: '#6ca6dc',
  yellow: '#f4c20d',
  gold: '#d4a017',
  amber: '#ffbf00',
  green: '#2e8b3d',
  'dark green': '#1b5e20',
  orange: '#ef6c00',
  tangerine: '#f28500',
  maroon: '#7a1f2b',
  claret: '#7a1f3d',
  burgundy: '#800020',
  bordeaux: '#5e1a2b',
  purple: '#6a1b9a',
  violet: '#7c3aed',
  grey: '#9e9e9e',
  gray: '#9e9e9e',
  silver: '#c4c8cc',
  brown: '#795548',
  pink: '#e0518f',
};

/** Split a `clubColors` string ("Sky Blue / White / Red") into lower-cased,
 *  trimmed colour words. */
function clubColorList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split('/')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function colorToHex(name: string): string | null {
  return TEAM_COLORS[name] ?? null;
}

/** Black or white text for legibility on a given hex background. */
function textOn(hex: string): string {
  const c = hex.replace('#', '');
  if (c.length < 6) return '#ffffff';
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#14110e' : '#ffffff';
}

/** Last word of a player's name — keeps the on-pitch label compact. */
function lastName(name: string | null): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1];
}

function posBucket(pos: string | null): 'GK' | 'DEF' | 'MID' | 'FWD' {
  const p = (pos ?? '').toLowerCase();
  if (p.includes('goal')) return 'GK';
  if (p.includes('back') || p.includes('defen')) return 'DEF';
  if (
    p.includes('forward') ||
    p.includes('offen') ||
    p.includes('wing') ||
    p.includes('strik') ||
    p.includes('attack')
  ) {
    return 'FWD';
  }
  return 'MID';
}

/**
 * Split a starting XI into rows, defensive → attacking, from the formation
 * string (e.g. "4-3-3" → [GK], [4], [3], [3]). The lineup array is in
 * formation order, so we just chunk the outfield by the formation numbers.
 * Falls back to grouping by broad position when the formation is missing or
 * doesn't add up to the XI.
 */
function buildRows(lu: MatchLineup): MatchPlayer[][] {
  const players = lu.lineup;
  if (players.length === 0) return [];
  const gk = players.find((p) => (p.position ?? '').toLowerCase().includes('goal')) ?? players[0];
  const outfield = players.filter((p) => p !== gk);
  const counts = (lu.formation ?? '')
    .split('-')
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  const sum = counts.reduce((a, b) => a + b, 0);
  if (counts.length > 0 && sum === outfield.length) {
    const rows: MatchPlayer[][] = [[gk]];
    let i = 0;
    for (const c of counts) {
      rows.push(outfield.slice(i, i + c));
      i += c;
    }
    return rows;
  }
  // Fallback: group by broad position so we still draw something sensible.
  const buckets: Record<'GK' | 'DEF' | 'MID' | 'FWD', MatchPlayer[]> = {
    GK: [],
    DEF: [],
    MID: [],
    FWD: [],
  };
  for (const p of players) buckets[posBucket(p.position)].push(p);
  return [buckets.GK, buckets.DEF, buckets.MID, buckets.FWD].filter((r) => r.length > 0);
}

/**
 * Place a team's rows on the pitch as percentage coordinates. Home occupies
 * the bottom half (GK deepest at y≈96, attackers near the halfway line);
 * away mirrors into the top half (GK at y≈4). Players in a row spread evenly
 * across the width.
 */
function markersForTeam(rows: MatchPlayer[][], side: 'home' | 'away'): PitchMarker[] {
  const markers: PitchMarker[] = [];
  const rowCount = rows.length;
  rows.forEach((row, ri) => {
    const t = rowCount > 1 ? ri / (rowCount - 1) : 0; // 0 = GK row … 1 = most attacking
    const y = side === 'home' ? 96 - t * 42 : 4 + t * 42;
    const k = row.length;
    row.forEach((p, j) => {
      markers.push({
        key: `${side}-${ri}-${j}`,
        x: ((j + 1) / (k + 1)) * 100,
        y,
        number: p.shirtNumber != null ? String(p.shirtNumber) : '',
        name: lastName(p.name),
        side,
      });
    });
  });
  return markers;
}
