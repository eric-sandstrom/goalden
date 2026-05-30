import { NgOptimizedImage } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  resource,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { TeamsService } from '../../core/services/teams.service';
import {
  POSITION_LABEL,
  POSITION_ORDER,
  Player,
  PlayerPosition,
  Team,
} from '../../core/models/team.model';
import { SkelComponent } from '../../shared/components/skel.component';

interface SquadSection {
  readonly position: PlayerPosition;
  readonly label: string;
  readonly players: readonly Player[];
}

@Component({
  selector: 'app-team-detail',
  imports: [
    NgOptimizedImage,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatListModule,
    SkelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './team-detail.component.html',
  styleUrl: './team-detail.component.scss',
})
export class TeamDetailComponent {
  private readonly teamsService = inject(TeamsService);

  // Wired via withComponentInputBinding() in app.config — Angular extracts
  // :teamId from the route and pushes it into this signal input automatically.
  readonly teamId = input.required<string>();

  /**
   * Canonical-doc read for this team, keyed on the route id. Resolves any
   * team regardless of whether its competition is in the shared service's
   * active-comp merge (which is also localStorage-cached) — the source of the
   * old "Team not found" on non-WC teams. The in-memory `byId` below is
   * preferred for instant paint when the shared list already has it, so this
   * only does a network read on a cache miss.
   */
  private readonly teamResource = resource<Team | null, string>({
    params: () => this.teamId(),
    loader: ({ params }) => this.teamsService.loadTeam(params),
    defaultValue: null,
  });

  protected readonly team = computed<Team | null>(
    () => this.teamsService.byId(this.teamId()) ?? this.teamResource.value(),
  );

  /** Loaded once we have a team from either source, or the canonical read
   *  has settled (so a genuine miss falls through to "not found" instead of
   *  spinning forever). */
  protected readonly loaded = computed<boolean>(
    () =>
      this.teamsService.byId(this.teamId()) !== null ||
      !this.teamResource.isLoading(),
  );

  protected readonly squadSections = computed<readonly SquadSection[]>(() => {
    const t = this.team();
    if (!t) return [];
    const byPosition = new Map<PlayerPosition, Player[]>();
    for (const p of t.squad) {
      const bucket = byPosition.get(p.position) ?? [];
      bucket.push(p);
      byPosition.set(p.position, bucket);
    }
    const sections: SquadSection[] = [];
    for (const [position, players] of byPosition) {
      sections.push({
        position,
        label: POSITION_LABEL[position],
        players: [...players].sort((a, b) => sortPlayers(a, b)),
      });
    }
    return sections.sort((a, b) => POSITION_ORDER[a.position] - POSITION_ORDER[b.position]);
  });

  protected subtitle(team: Team): string {
    const parts: string[] = [];
    if (team.tla) parts.push(team.tla);
    if (team.squad.length > 0) parts.push(`${team.squad.length} players`);
    return parts.join(' · ');
  }
}

/** Sort players within a position section: by shirt number (nulls last),
 *  falling back to name. */
function sortPlayers(a: Player, b: Player): number {
  const an = a.shirtNumber;
  const bn = b.shirtNumber;
  if (an !== null && bn !== null) return an - bn;
  if (an !== null) return -1;
  if (bn !== null) return 1;
  return a.name.localeCompare(b.name);
}
