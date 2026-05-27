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
  template: `
    <section class="page">
      @if (!loaded()) {
        <mat-card appearance="outlined" class="hero-card">
          <mat-card-header>
            <app-skel width="80px" height="80px" rounded />
            <div class="skel-hdr">
              <app-skel width="60%" height="1.5rem" block />
              <div style="height: 6px;"></div>
              <app-skel width="40%" height="1rem" block />
            </div>
          </mat-card-header>
        </mat-card>
      } @else if (team(); as t) {
        <!-- ===== Hero ===== -->
        <mat-card appearance="outlined" class="hero-card">
          <mat-card-header>
            @if (t.crest) {
              <img
                matCardAvatar
                [ngSrc]="t.crest"
                width="56"
                height="56"
                [alt]="t.name + ' crest'"
              />
            } @else {
              <mat-icon matCardAvatar aria-hidden="true">shield</mat-icon>
            }
            <mat-card-title>{{ t.name }}</mat-card-title>
            <mat-card-subtitle>{{ subtitle(t) }}</mat-card-subtitle>
          </mat-card-header>
          @if (t.clubColors || t.venue || t.founded) {
            <mat-card-content class="hero-meta">
              @if (t.founded) {
                <div class="meta-row">
                  <mat-icon class="meta-icon" aria-hidden="true">history</mat-icon>
                  <span class="meta-text">Founded {{ t.founded }}</span>
                </div>
              }
              @if (t.venue) {
                <div class="meta-row">
                  <mat-icon class="meta-icon" aria-hidden="true">stadium</mat-icon>
                  <span class="meta-text">{{ t.venue }}</span>
                </div>
              }
              @if (t.clubColors) {
                <div class="meta-row">
                  <mat-icon class="meta-icon" aria-hidden="true">palette</mat-icon>
                  <span class="meta-text">{{ t.clubColors }}</span>
                </div>
              }
            </mat-card-content>
          }
        </mat-card>

        <!-- ===== Coach =====
             Skip the card entirely when there's no usable name. The
             football-data free tier sometimes returns a coach stub with only
             an id and no name fields, which would render as an empty title
             above a subtitle and look broken. -->
        @if (t.coach && t.coach.name.trim().length > 0) {
          <mat-card appearance="outlined">
            <mat-card-header>
              <mat-icon matCardAvatar>sports</mat-icon>
              <mat-card-title>{{ t.coach.name }}</mat-card-title>
              <mat-card-subtitle>Head coach{{
                t.coach.nationality ? ' · ' + t.coach.nationality : ''
              }}</mat-card-subtitle>
            </mat-card-header>
          </mat-card>
        }

        <!-- ===== Squad ===== -->
        @if (squadSections().length > 0) {
          <mat-card appearance="outlined" class="card-grow squad-card">
            <mat-card-header>
              <mat-icon matCardAvatar>group</mat-icon>
              <mat-card-title>Squad</mat-card-title>
              <mat-card-subtitle>{{ t.squad.length }} players</mat-card-subtitle>
            </mat-card-header>
            <div class="card-scroll">
              @for (section of squadSections(); track section.position) {
                <section class="squad-section">
                  <h2 class="squad-section-title">{{ section.label }}</h2>
                  <mat-list>
                    @for (player of section.players; track player.id) {
                      <mat-list-item>
                        @if (player.shirtNumber !== null) {
                          <span matListItemAvatar class="shirt-number">{{
                            player.shirtNumber
                          }}</span>
                        } @else {
                          <span matListItemAvatar class="shirt-number shirt-blank"
                            aria-hidden="true">—</span>
                        }
                        <span matListItemTitle>{{ player.name }}</span>
                        @if (player.nationality) {
                          <span matListItemLine>{{ player.nationality }}</span>
                        }
                      </mat-list-item>
                    }
                  </mat-list>
                </section>
              }
            </div>
          </mat-card>
        } @else {
          <mat-card appearance="outlined" class="empty">
            <mat-icon aria-hidden="true">person_off</mat-icon>
            <p>No squad data yet — try again after the next sync.</p>
          </mat-card>
        }
      } @else {
        <mat-card appearance="outlined" class="empty">
          <mat-icon aria-hidden="true">help</mat-icon>
          <p>Team not found.</p>
        </mat-card>
      }
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      width: 100%;
    }
    .hero-card {
      min-height: 120px;
      /* .page is a flex column with overflow:hidden. Without this, the hero
         card has the default flex-shrink:1 and the squad-card below it
         (card-grow) wins the space fight — squeezing the hero down to its
         min-height and clipping the venue / colours rows. */
      flex-shrink: 0;
    }
    /* Same shrink guard for the coach card so it never gives up space to
       the squad-card scroller. */
    .page > mat-card:not(.card-grow):not(.empty) {
      flex-shrink: 0;
    }
    /* Force long team names (e.g. "Bosnia and Herzegovina") to wrap rather
       than scroll the page horizontally. */
    .hero-card mat-card-title {
      overflow-wrap: break-word;
      word-break: break-word;
    }
    .hero-meta {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding-top: 0.75rem;
      padding-bottom: 0.25rem;
      color: var(--mat-sys-on-surface-variant);
      min-width: 0;
    }
    /* Block-level row so long values wrap to the next line beside the icon.
       inline-flex (the previous version) sized the row to its content and
       wouldn't wrap, which is what made long venue/colors strings overflow. */
    .meta-row {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      font-size: 0.9rem;
      min-width: 0;
    }
    .meta-text {
      flex: 1;
      min-width: 0;
      overflow-wrap: break-word;
      word-break: break-word;
      /* Bump the text down a hair so it baseline-aligns with the icon, which
         is taller than its line-height due to mat-icon's box sizing. */
      padding-top: 1px;
    }
    .meta-icon {
      width: 18px;
      height: 18px;
      font-size: 18px;
      line-height: 18px;
      flex-shrink: 0;
    }
    .squad-card {
      padding: 0;
    }
    .squad-card mat-card-header {
      padding: 1rem 1rem 0;
    }
    .squad-section {
      display: block;
    }
    .squad-section-title {
      position: sticky;
      top: 0;
      z-index: 2;
      margin: 0;
      padding: 0.5rem 1rem;
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface-variant);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      background: var(--mat-sys-surface-container-highest);
      border-top: 1px solid var(--mat-sys-outline-variant);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .squad-section:first-of-type .squad-section-title {
      border-top: none;
    }
    .shirt-number {
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      width: 36px !important;
      height: 36px !important;
      border-radius: 50%;
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .shirt-blank {
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface-variant);
      font-weight: 400;
    }
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
      padding: 2rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .skel-hdr { flex: 1; min-width: 0; }
  `,
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
