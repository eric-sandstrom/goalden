import { NgOptimizedImage } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
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

  protected readonly loaded = this.teamsService.loaded;

  protected readonly team = computed<Team | null>(() =>
    this.teamsService.byId(this.teamId()),
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
