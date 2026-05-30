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
import { MatTabsModule } from '@angular/material/tabs';
import { Fixture } from '../../core/models/fixture.model';
import { MatchDetail, MatchLineup } from '../../core/models/match-detail.model';
import { FixturesService } from '../../core/services/fixtures.service';
import { MatchDetailService } from '../../core/services/match-detail.service';
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

const STAGE_LABELS: Record<string, string> = {
  GROUP: 'Group stage',
  REGULAR_SEASON: 'League',
  LEAGUE_STAGE: 'League phase',
  R32: 'Round of 32',
  R16: 'Round of 16',
  QF: 'Quarter-final',
  SF: 'Semi-final',
  F: 'Final',
  THIRD_PLACE: 'Third-place play-off',
};

@Component({
  selector: 'app-fixture-detail',
  imports: [
    NgOptimizedImage,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatListModule,
    MatProgressSpinnerModule,
    MatTabsModule,
    SkelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './fixture-detail.component.html',
  styleUrl: './fixture-detail.component.scss',
})
export class FixtureDetailComponent {
  private readonly fixtures = inject(FixturesService);
  private readonly matchDetail = inject(MatchDetailService);
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

  /** Whether the match has reached a terminal, result-bearing state — the
   *  only point where fetching detail (and showing the refresh button) makes
   *  sense, since events never change afterwards. */
  protected readonly isTerminal = computed<boolean>(() => {
    const s = this.fixture()?.status;
    return s === 'FINISHED' || s === 'AWARDED';
  });

  /** The 90-minute score we display (extra time / penalties shown separately).
   *  Mirrors the fixture-row precedence: regularTime → live → fullTime. */
  protected readonly displayScore = computed<{ home: number; away: number } | null>(() => {
    const f = this.fixture();
    if (!f) return null;
    if (f.score?.regularTime) return f.score.regularTime;
    if (f.liveState === 'in' && f.liveScore) return f.liveScore;
    return f.score?.fullTime ?? null;
  });

  /** A short status line for the header (FT / live minute / kickoff). */
  protected readonly statusLabel = computed<string>(() => {
    const f = this.fixture();
    if (!f) return '';
    if (f.status === 'FINISHED' || f.status === 'AWARDED') return 'Full time';
    if (f.status === 'IN_PLAY' || f.liveState === 'in') {
      return f.liveClock ?? (typeof f.minute === 'number' ? `${f.minute}'` : 'Live');
    }
    if (f.status === 'PAUSED') return 'Half-time';
    return f.utcKickoff.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  });

  /** "After extra time" / "After penalties (4–3)" sub-line, from the detail
   *  doc's score breakdown. Null for a match decided in regulation. */
  protected readonly resultNote = computed<string | null>(() => {
    const d = this.detail();
    if (!d) return null;
    if (d.score.duration === 'PENALTY_SHOOTOUT') {
      const p = d.score.penalties;
      return p ? `After penalties (${p.home}–${p.away})` : 'After penalties';
    }
    if (d.score.duration === 'EXTRA_TIME') return 'After extra time';
    return null;
  });

  /** Goals + cards merged into one chronological timeline for the top card. */
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
   * True when the match is finished but the detail we hold is missing or
   * incomplete — the cue to offer a refresh. "Incomplete" = fewer recorded
   * goal events than the scoreline implies (e.g. a 2–1 with no scorers yet),
   * which also covers a fixture that's never been fetched at all.
   */
  protected readonly detailMissing = computed<boolean>(() => {
    const d = this.detail();
    if (!d) return true;
    const sc = this.fixture()?.score;
    const ft = sc?.regularTime ?? sc?.fullTime ?? null;
    const expectedGoals = ft ? ft.home + ft.away : 0;
    return d.goals.length < expectedGoals;
  });

  protected readonly showRefresh = computed<boolean>(
    () =>
      this.isTerminal() &&
      !this.refreshing() &&
      !this.detailResource.isLoading() &&
      this.detailMissing(),
  );

  // --- second card: tab data -------------------------------------------------

  protected readonly hasLineups = computed<boolean>(() => {
    const d = this.detail();
    if (!d) return false;
    return d.home.lineup.length > 0 || d.away.lineup.length > 0;
  });

  protected readonly hasSubs = computed(() => (this.detail()?.substitutions.length ?? 0) > 0);
  protected readonly hasReferees = computed(() => (this.detail()?.referees.length ?? 0) > 0);

  protected readonly infoRows = computed<readonly InfoRow[]>(() => {
    const f = this.fixture();
    if (!f) return [];
    const d = this.detail();
    const rows: InfoRow[] = [];
    rows.push({ icon: 'emoji_events', label: 'Competition', value: f.competitionId });
    rows.push({ icon: 'flag', label: 'Stage', value: STAGE_LABELS[f.stage] ?? f.stage });
    if (f.group) rows.push({ icon: 'grid_view', label: 'Group', value: f.group });
    rows.push({
      icon: 'schedule',
      label: 'Kick-off',
      value: f.utcKickoff.toLocaleString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    });
    const ht = d?.score.halfTime;
    if (ht && ht.home !== null && ht.away !== null) {
      rows.push({ icon: 'timelapse', label: 'Half-time', value: `${ht.home}–${ht.away}` });
    }
    if (d?.venue) rows.push({ icon: 'stadium', label: 'Venue', value: d.venue });
    if (typeof d?.attendance === 'number') {
      rows.push({ icon: 'groups', label: 'Attendance', value: d.attendance.toLocaleString() });
    }
    return rows;
  });

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
