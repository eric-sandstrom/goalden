import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { Fixture } from '../../core/models/fixture.model';
import { MatchDetail } from '../../core/models/match-detail.model';

type Side = 'home' | 'away' | 'neutral';

interface TimelineItem {
  readonly key: string;
  readonly sortKey: number;
  readonly minuteLabel: string;
  readonly side: Side;
  readonly kind: 'goal' | 'yellow' | 'red' | 'sub';
  readonly player: string;
  readonly note: string | null;
}

interface InfoRow {
  readonly icon: string;
  readonly label: string;
  readonly value: string;
}

/**
 * The Events tab of the match detail: goals, cards and substitutions merged
 * into one chronological, home/away-split timeline, plus the leftover match
 * meta (group, attendance) the header doesn't already show.
 */
@Component({
  selector: 'app-match-timeline',
  imports: [MatIconModule, MatListModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './match-timeline.component.html',
  styleUrl: './match-timeline.component.scss',
})
export class MatchTimelineComponent {
  readonly fixture = input.required<Fixture>();
  readonly detail = input<MatchDetail | null>(null);

  /** Goals + cards + subs merged into one chronological timeline. */
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

    d.substitutions.forEach((s, i) => {
      items.push({
        key: `sub${i}`,
        sortKey: sortKey(s.minute, null),
        minuteLabel: minuteLabel(s.minute, null),
        side: this.sideOf(s.teamId),
        kind: 'sub',
        player: s.playerIn?.name ?? 'Substitution',
        note: s.playerOut?.name ? `for ${s.playerOut.name}` : null,
      });
    });

    return items.sort((a, b) => a.sortKey - b.sortKey);
  });

  protected readonly hasTimeline = computed(() => this.timeline().length > 0);

  /** Match meta for the Info list. Competition, stage, kick-off, venue and
   *  half-time all live in the header, so only the leftover extras (group,
   *  attendance) remain here. */
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

  /** Side ('home'/'away' column) for a given event team id. */
  private sideOf(teamId: number | null): Side {
    const f = this.fixture();
    if (!f || teamId === null) return 'neutral';
    if (teamId === f.homeTeam.id) return 'home';
    if (teamId === f.awayTeam.id) return 'away';
    return 'neutral';
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
