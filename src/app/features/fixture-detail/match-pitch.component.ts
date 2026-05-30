import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Fixture } from '../../core/models/fixture.model';
import { MatchDetail, MatchLineup, MatchPlayer, MatchReferee } from '../../core/models/match-detail.model';
import { TeamsService } from '../../core/services/teams.service';

type Side = 'home' | 'away' | 'neutral';

/** Goals / assists / cards a player recorded, for the on-pitch + bench badges. */
interface PlayerEvents {
  goals: number;
  assists: number;
  yellow: boolean;
  red: boolean;
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
  /** Minute this starter was subbed off, if they were — drives the on-pitch
   *  "subbed off" badge. Null if they played the whole match. */
  readonly subOffMinute: number | null;
  /** Goals/assists/cards this player recorded, or null if none. */
  readonly events: PlayerEvents | null;
}

/** A bench player, with substitution info overlaid when they came on. */
interface BenchEntry {
  readonly player: MatchPlayer;
  /** Minute they came on, or null if they stayed an unused sub. */
  readonly onMinute: number | null;
  /** Who they replaced, when they came on. */
  readonly outName: string | null;
}

/**
 * The Line-ups tab of the match detail: both starting XIs laid out on a pitch
 * by their formation (home top, away mirrored on the bottom), the benches with
 * substitution info, and the match officials. Team marker colours derive from
 * each club's `clubColors`.
 */
@Component({
  selector: 'app-match-pitch',
  imports: [NgTemplateOutlet, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './match-pitch.component.html',
  styleUrl: './match-pitch.component.scss',
})
export class MatchPitchComponent {
  private readonly teamsService = inject(TeamsService);

  readonly fixture = input.required<Fixture>();
  readonly detail = input<MatchDetail | null>(null);

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

  /** Starting XIs placed on the pitch — home on the bottom half, away mirrored
   *  on the top half, both laid out by their formation. Also returns a height
   *  sized to the row count so rows never crowd. */
  protected readonly pitch = computed<{ markers: readonly PitchMarker[]; height: number }>(() => {
    const home = this.lineupFor('home');
    const away = this.lineupFor('away');
    const d = this.detail();
    // playerOut id → minute, so a subbed-off starter gets its badge.
    const offMap = new Map<number, number | null>();
    if (d) {
      for (const s of d.substitutions) {
        if (s.playerOut?.id != null) offMap.set(s.playerOut.id, s.minute);
      }
    }
    const events = this.eventsByPlayer();
    const homeRows = home ? buildRows(home) : [];
    const awayRows = away ? buildRows(away) : [];
    const markers = [
      ...markersForTeam(homeRows, 'home', offMap, events),
      ...markersForTeam(awayRows, 'away', offMap, events),
    ];
    // ~60px per row keeps the dot + two-line name clear of its neighbours.
    const height = Math.max(360, (homeRows.length + awayRows.length) * 60);
    return { markers, height };
  });

  protected readonly referees = computed<readonly MatchReferee[]>(() => this.detail()?.referees ?? []);

  protected readonly hasReferees = computed(() => this.referees().length > 0);

  /**
   * A team's bench, with substitution info overlaid: players who came on are
   * tagged with the minute + who they replaced and sorted to the top (by
   * minute), then the unused subs follow in their listed order.
   */
  protected benchFor(side: 'home' | 'away'): readonly BenchEntry[] {
    const lu = this.lineupFor(side);
    if (!lu) return [];
    const d = this.detail();
    const inMap = new Map<number, { minute: number | null; outName: string | null }>();
    if (d) {
      for (const s of d.substitutions) {
        if (this.sideOf(s.teamId) === side && s.playerIn?.id != null) {
          inMap.set(s.playerIn.id, { minute: s.minute, outName: s.playerOut?.name ?? null });
        }
      }
    }
    const entries = lu.bench.map<BenchEntry>((p) => {
      const info = p.id != null ? inMap.get(p.id) : undefined;
      return { player: p, onMinute: info?.minute ?? null, outName: info?.outName ?? null };
    });
    // Came-on first (by minute), then unused subs in their original order.
    return entries
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        const ao = a.e.onMinute !== null;
        const bo = b.e.onMinute !== null;
        if (ao && bo) return (a.e.onMinute ?? 0) - (b.e.onMinute ?? 0);
        if (ao !== bo) return ao ? -1 : 1;
        return a.i - b.i;
      })
      .map((x) => x.e);
  }

  /** Side ('home'/'away' column) for a given event team id. */
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

  /** Manager name for a side's pitch bar, or null when unknown. */
  protected coachName(side: 'home' | 'away'): string | null {
    const c = this.lineupFor(side)?.coach;
    return c && c.name ? c.name : null;
  }

  /** Goals / assists / cards per player id, from the match events. */
  private readonly eventsByPlayer = computed<ReadonlyMap<number, PlayerEvents>>(() => {
    const d = this.detail();
    const m = new Map<number, PlayerEvents>();
    if (!d) return m;
    const slot = (id: number): PlayerEvents => {
      let e = m.get(id);
      if (!e) {
        e = { goals: 0, assists: 0, yellow: false, red: false };
        m.set(id, e);
      }
      return e;
    };
    for (const g of d.goals) {
      if (g.type !== 'OWN' && g.scorer?.id != null) slot(g.scorer.id).goals++;
      if (g.assist?.id != null) slot(g.assist.id).assists++;
    }
    for (const b of d.bookings) {
      if (b.player?.id != null) {
        const e = slot(b.player.id);
        if (b.card === 'RED') e.red = true;
        else e.yellow = true;
      }
    }
    return m;
  });

  /** Goals/assists/cards for one player (for the bench badges), or null. */
  protected playerEvents(id: number | null | undefined): PlayerEvents | null {
    if (id == null) return null;
    return this.eventsByPlayer().get(id) ?? null;
  }

  /** Surname for the compact (small-screen) bench chip. */
  protected surname(name: string | null): string {
    return lastName(name);
  }

  /** Short position code (CB, DM, LW…) for the compact bench chip. */
  protected posAbbr(pos: string | null): string {
    return positionAbbr(pos);
  }

  /** Formation string (e.g. "4-3-3") for a side, or null. */
  protected formationOf(side: 'home' | 'away'): string | null {
    return this.lineupFor(side)?.formation ?? null;
  }

  /** Humanise a football-data referee type, e.g. ASSISTANT_REFEREE_N2 →
   *  "Assistant referee 2", VIDEO_ASSISTANT_REFEREE_N1 → "VAR 1". */
  protected refRole(type: string | null): string {
    if (!type) return 'Official';
    const n = type.match(/_N(\d+)$/);
    const suffix = n ? ` ${n[1]}` : '';
    const base = type.replace(/_N\d+$/, '').replace(/_/g, ' ').trim().toLowerCase();
    if (base === 'video assistant referee') return `VAR${suffix}`;
    return base.charAt(0).toUpperCase() + base.slice(1) + suffix;
  }
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

/** Short code for a football-data position, e.g. "Centre-Back" → "CB". */
function positionAbbr(pos: string | null): string {
  const p = (pos ?? '').toLowerCase();
  if (!p) return '';
  if (p.includes('goal')) return 'GK';
  if (p.includes('left') && p.includes('back')) return 'LB';
  if (p.includes('right') && p.includes('back')) return 'RB';
  if (p.includes('back')) return 'CB';
  if (p === 'defence' || p.includes('defender')) return 'DEF';
  if (p.includes('defensive mid')) return 'DM';
  if (p.includes('attacking mid')) return 'AM';
  if (p.includes('left') && p.includes('mid')) return 'LM';
  if (p.includes('right') && p.includes('mid')) return 'RM';
  if (p.includes('mid')) return 'CM';
  if (p.includes('left') && p.includes('wing')) return 'LW';
  if (p.includes('right') && p.includes('wing')) return 'RW';
  if (p.includes('wing')) return 'WG';
  if (p.includes('forward') || p.includes('strik') || p === 'offence') return 'FW';
  return '';
}

/**
 * Tactical depth of a position, 0 (goalkeeper) → 5 (striker). Drives which
 * formation row a player lands in. football-data gives specific positions
 * ("Centre-Back", "Left Winger", "Defensive Midfield"), so we rank by those
 * rather than the lineup array order — which is NOT formation-ordered.
 */
function depthScore(pos: string | null): number {
  const p = (pos ?? '').toLowerCase();
  if (p.includes('goal')) return 0;
  if (p.includes('back') || p === 'defence' || p.includes('defender')) return 1;
  if (p.includes('defensive mid')) return 2;
  if (p.includes('attacking mid')) return 4;
  if (p.includes('mid')) return 3;
  if (p.includes('wing')) return 4.5;
  if (p.includes('forward') || p.includes('strik') || p === 'offence') return 5;
  return 3;
}

/** Horizontal lean of a position: 0 left, 1 centre, 2 right — for ordering
 *  players across a row. */
function horizRank(pos: string | null): number {
  const p = (pos ?? '').toLowerCase();
  if (p.includes('left')) return 0;
  if (p.includes('right')) return 2;
  return 1;
}

/**
 * Split a starting XI into rows, defensive → attacking. Players are assigned
 * to rows by tactical depth (NOT array order — football-data's lineup array
 * isn't formation-ordered): sort by depth, then fill the formation's line
 * sizes (4-3-3 → 4, 3, 3). Each row is then ordered left → right. Falls back
 * to defence/midfield/attack buckets when the formation doesn't add up.
 */
function buildRows(lu: MatchLineup): MatchPlayer[][] {
  const players = lu.lineup;
  if (players.length === 0) return [];
  const gk = players.find((p) => depthScore(p.position) === 0) ?? players[0];
  const outfield = players
    .filter((p) => p !== gk)
    .map((p, i) => ({ p, d: depthScore(p.position), i }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.p);

  const counts = (lu.formation ?? '')
    .split('-')
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isInteger(n) && n > 0);

  let lines: MatchPlayer[][];
  if (counts.length > 0 && counts.reduce((a, b) => a + b, 0) === outfield.length) {
    lines = [];
    let i = 0;
    for (const c of counts) {
      lines.push(outfield.slice(i, i + c));
      i += c;
    }
  } else {
    const def = outfield.filter((p) => depthScore(p.position) <= 1);
    const mid = outfield.filter((p) => {
      const d = depthScore(p.position);
      return d > 1 && d < 4;
    });
    const fwd = outfield.filter((p) => depthScore(p.position) >= 4);
    lines = [def, mid, fwd].filter((l) => l.length > 0);
  }

  // Order each line left → right.
  lines = lines.map((line) =>
    line
      .map((p, i) => ({ p, h: horizRank(p.position), i }))
      .sort((a, b) => a.h - b.h || a.i - b.i)
      .map((x) => x.p),
  );
  return [[gk], ...lines];
}

/**
 * Place a team's rows on the pitch as percentage coordinates. Home occupies
 * the top half (GK at y≈5, attackers near the halfway line); away mirrors
 * into the bottom half (GK deepest at y≈95). Players in a row spread evenly
 * across the width. `offMap` tags starters who were later subbed off.
 */
function markersForTeam(
  rows: MatchPlayer[][],
  side: 'home' | 'away',
  offMap: ReadonlyMap<number, number | null>,
  events: ReadonlyMap<number, PlayerEvents>,
): PitchMarker[] {
  const markers: PitchMarker[] = [];
  const rowCount = rows.length;
  rows.forEach((row, ri) => {
    const t = rowCount > 1 ? ri / (rowCount - 1) : 0; // 0 = GK row … 1 = most attacking
    const y = side === 'home' ? 5 + t * 39 : 95 - t * 39;
    const k = row.length;
    row.forEach((p, j) => {
      const subbed = p.id != null && offMap.has(p.id);
      markers.push({
        key: `${side}-${ri}-${j}`,
        x: ((j + 1) / (k + 1)) * 100,
        y,
        number: p.shirtNumber != null ? String(p.shirtNumber) : '',
        name: lastName(p.name),
        side,
        subOffMinute: subbed ? (offMap.get(p.id as number) ?? null) : null,
        events: p.id != null ? (events.get(p.id) ?? null) : null,
      });
    });
  });
  return markers;
}
