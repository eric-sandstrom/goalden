import { NgOptimizedImage } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { QRCodeComponent } from 'angularx-qrcode';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SkelComponent } from '../../shared/components/skel.component';
import { AuthService } from '../../core/services/auth.service';
import { CompetitionsService } from '../../core/services/competitions.service';
import { LeaguesService } from '../../core/services/leagues.service';
import { parseTotals } from '../../core/services/user.service';
import { League, LeagueMember } from '../../core/models/league.model';
import { PredictNextCardComponent } from '../predict/predict-next-card.component';
import { StandingsViewComponent } from '../standings/standings-view.component';

interface LeagueRow {
  readonly uid: string;
  readonly rank: number;
  readonly displayName: string;
  readonly photoURL: string | null;
  readonly totalPoints: number;
  readonly exactHits: number;
  readonly outcomeHits: number;
  readonly role: 'owner' | 'member';
}

@Component({
  selector: 'app-league-detail',
  imports: [
    NgOptimizedImage,
    QRCodeComponent,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatDividerModule,
    MatIconModule,
    MatMenuModule,
    MatProgressSpinnerModule,
    MatTableModule,
    MatTabsModule,
    MatTooltipModule,
    SkelComponent,
    PredictNextCardComponent,
    StandingsViewComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './league-detail.component.html',
  styleUrl: './league-detail.component.scss',
})
export class LeagueDetailComponent {
  readonly leagueId = input.required<string>();

  private readonly leagues = inject(LeaguesService);
  private readonly competitionsService = inject(CompetitionsService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _members = signal<readonly LeagueMember[]>([]);
  private readonly _memberUsers = signal<ReadonlyMap<string, Record<string, unknown>>>(new Map());
  /** Per-(comp, season) totals shards keyed by uid. Scoped to the
   *  league's competition so a Premier League leaderboard shows only
   *  EPL points, even if those members also have WC predictions. */
  private readonly _memberTotals = signal<ReadonlyMap<string, Record<string, unknown>>>(
    new Map(),
  );
  /** False until the current league's rows are fully hydrated (user docs +
   *  per-comp totals). Gates the leaderboard behind a skeleton so the table
   *  renders once — correctly named and sorted — instead of flashing
   *  "Unknown" + zero points and then re-sorting as the data lands. */
  protected readonly leaderboardLoaded = signal(false);

  // Read league data directly from the LeaguesService cache instead of opening
  // a second listener for the same doc — saves one Firestore listener per
  // navigation into this view.
  protected readonly league = computed<League | null>(() => {
    const id = this.leagueId();
    if (!id) return null;
    return this.leagues.myLeagues().get(id) ?? null;
  });

  protected readonly myUid = computed(() => this.auth.uid());
  protected readonly amOwner = computed(() => {
    const l = this.league();
    const uid = this.auth.uid();
    return !!l && !!uid && l.ownerId === uid;
  });

  /** Catalogue entry for the league's competition. Drives the comp
   *  emblem + name in the header chip; null while the competitions
   *  collection is still hydrating. */
  protected readonly competition = computed(() => {
    const l = this.league();
    if (!l) return null;
    return this.competitionsService.byId(l.competitionId);
  });

  // ---------------------------------------------------------------------------
  // Header presentation derived from league type
  // ---------------------------------------------------------------------------

  protected readonly headerIcon = computed(() => {
    const l = this.league();
    if (!l) return 'groups';
    if (l.type === 'global') return 'public';
    if (l.type === 'public') return 'visibility';
    return this.amOwner() ? 'workspace_premium' : 'groups';
  });

  protected readonly headerSubtitle = computed(() => {
    const l = this.league();
    if (!l) return '';
    const memberLine = `${l.memberCount} members`;
    if (l.type === 'global') {
      return l.globalConfig?.allowLeave
        ? `${memberLine} · auto-enrolled · you can leave`
        : `${memberLine} · auto-enrolled`;
    }
    if (l.type === 'public') {
      return this.amOwner()
        ? `${memberLine} · public · you're the owner`
        : `${memberLine} · public`;
    }
    // private
    return this.amOwner() ? `${memberLine} · you're the owner` : memberLine;
  });

  /** Private + public leagues both have an invite code that's worth sharing.
   *  Global leagues have no code. */
  protected readonly canShareInvite = computed(() => {
    const l = this.league();
    return !!l && l.type !== 'global' && !!l.inviteCode;
  });

  /** Only private and public leagues have owners with mod powers. */
  protected readonly canModerate = computed(() => {
    const l = this.league();
    return !!l && l.type !== 'global';
  });

  /** Leave button visibility:
   *   - private/public: any non-owner can leave; owner can't.
   *   - global + allowLeave: anyone can leave.
   *   - global + !allowLeave: nobody can leave. */
  protected readonly canLeave = computed(() => {
    const l = this.league();
    if (!l) return false;
    if (l.type === 'global') {
      return l.globalConfig?.allowLeave === true;
    }
    return !this.amOwner();
  });

  protected readonly columns = ['rank', 'player', 'exact', 'outcome', 'points', 'actions'];
  protected readonly skelRows = [0, 1, 2, 3, 4];

  /** Lower-panel switch: the prediction leaderboard vs the competition
   *  standings (predicted vs real). */
  protected readonly lowerView = signal<'leaderboard' | 'standings'>('leaderboard');

  protected readonly inviteUrl = computed(() => {
    const code = this.league()?.inviteCode;
    if (!code) return '';
    return `${window.location.origin}/j/${code}`;
  });

  protected readonly rows = computed<readonly LeagueRow[]>(() => {
    const members = this._members();
    const users = this._memberUsers();
    const totals = this._memberTotals();
    const list = members.map((m) => {
      const u = users.get(m.uid) ?? {};
      // Per-(comp, season) shard if present — otherwise zeros. A
      // missing shard means the member hasn't scored in this comp yet
      // (or has never been scored at all if the season hasn't started).
      const t = parseTotals(totals.get(m.uid));
      return {
        uid: m.uid,
        displayName: (u['displayName'] as string) ?? 'Unknown',
        photoURL: (u['photoURL'] as string | null) ?? null,
        totalPoints: t.total,
        exactHits: t.exactScoreHits,
        outcomeHits: t.correctOutcomeHits,
        role: m.role,
      };
    });
    // Tiebreaker cascade per CLAUDE.md: totalPoints, then exact-score hits,
    // then correct-outcome hits, then displayName. Bracket points aren't
    // exposed in this row shape yet — fine for v1, the first three keys
    // already split nearly every realistic tie.
    list.sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      if (b.exactHits !== a.exactHits) return b.exactHits - a.exactHits;
      if (b.outcomeHits !== a.outcomeHits) return b.outcomeHits - a.outcomeHits;
      return a.displayName.localeCompare(b.displayName);
    });
    return list.map((r, i) => ({ ...r, rank: i + 1 }));
  });

  constructor() {
    effect((onCleanup) => {
      const id = this.leagueId();
      // New league (or none) → hide the table behind the skeleton until this
      // league's members + their data finish loading.
      this.leaderboardLoaded.set(false);
      if (!id) {
        this._members.set([]);
        this._memberUsers.set(new Map());
        this._memberTotals.set(new Map());
        return;
      }

      const unsubMembers = this.leagues.listenToMembers(id, async (members) => {
        this._members.set(members);

        // Incremental user-doc fetch: only look up users we haven't cached yet.
        // Members who were already in the table on a previous snapshot don't
        // get re-read. Removed members stay in the cache (cheap) but the
        // computed `rows()` only renders current members, so no UI staleness.
        const cached = this._memberUsers();
        const missing = members
          .map((m) => m.uid)
          .filter((uid) => !cached.has(uid));
        if (missing.length > 0) {
          try {
            const fresh = await this.leagues.getMemberUserDocs(missing);
            if (fresh.size > 0) {
              const next = new Map(this._memberUsers());
              for (const [uid, data] of fresh) next.set(uid, data);
              this._memberUsers.set(next);
            }
          } catch (e: unknown) {
            console.error('[LeagueDetail] user-doc fetch failed:', e);
          }
        }

        // Per-comp totals — always refetched for every member on every
        // snapshot, because totals tick up live as scoreMatch runs and
        // we want the leaderboard to follow. Caching by uid here would
        // staleness the very thing the leaderboard exists to surface.
        const league = this.league();
        if (!league || members.length === 0) {
          if (members.length === 0) this._memberTotals.set(new Map());
          this.leaderboardLoaded.set(true);
          return;
        }
        try {
          const fresh = await this.leagues.getMemberTotals(
            members.map((m) => m.uid),
            league.competitionId,
            league.season,
          );
          this._memberTotals.set(fresh);
        } catch (e: unknown) {
          console.error('[LeagueDetail] per-comp totals fetch failed:', e);
        } finally {
          // Reveal the table now the rows are fully populated — user docs were
          // awaited above and totals just landed — for one clean, sorted render.
          this.leaderboardLoaded.set(true);
        }
      });

      onCleanup(() => unsubMembers());
    });
  }

  /** Jumps to the global teams browser. Lives in this component's menu
   *  rather than the profile page because the league detail is the
   *  natural surface for "tell me about the competing teams". */
  protected browseTeams(): void {
    void this.router.navigate(['/teams']);
  }

  protected async copyLink(): Promise<void> {
    const url = this.inviteUrl();
    if (!url) return;
    await navigator.clipboard.writeText(url);
    this.snackBar.open('Invite link copied', undefined, { duration: 1500 });
  }

  protected async copyCode(): Promise<void> {
    const code = this.league()?.inviteCode;
    if (!code) return;
    await navigator.clipboard.writeText(code);
    this.snackBar.open('Code copied', undefined, { duration: 1500 });
  }

  protected async regenerateCode(): Promise<void> {
    if (!confirm('Generate a new invite code? The old one will stop working.')) return;
    try {
      const { inviteCode } = await this.leagues.regenerateInviteCode(this.leagueId());
      this.snackBar.open(`New code: ${inviteCode}`, undefined, { duration: 2000 });
    } catch (e: unknown) {
      this.snackBar.open(e instanceof Error ? e.message : 'Failed', 'Dismiss', { duration: 4000 });
    }
  }

  protected async leave(): Promise<void> {
    if (!confirm('Leave this league?')) return;
    try {
      await this.leagues.leaveLeague(this.leagueId());
      await this.router.navigate(['/leagues']);
    } catch (e: unknown) {
      this.snackBar.open(e instanceof Error ? e.message : 'Failed', 'Dismiss', { duration: 4000 });
    }
  }

  protected async confirmDelete(): Promise<void> {
    if (!confirm('Delete this league for everyone? This cannot be undone.')) return;
    try {
      await this.leagues.deleteLeague(this.leagueId());
      this.snackBar.open('League deleted', undefined, { duration: 1500 });
      await this.router.navigate(['/leagues']);
    } catch (e: unknown) {
      this.snackBar.open(e instanceof Error ? e.message : 'Failed', 'Dismiss', { duration: 4000 });
    }
  }

  // Only show the per-row menu when:
  //   - I am the league owner
  //   - The row is NOT my own row (don't kick/transfer to yourself)
  protected canManageMember(row: LeagueRow): boolean {
    return this.amOwner() && row.uid !== this.myUid();
  }

  /**
   * Navigate to the chosen player's profile. Bound to the row's (click) +
   * keyboard handlers. Every row is clickable — including your own; the
   * UserProfileComponent self-redirect will bounce /users/<myUid> to
   * /profile so the user still lands on a sensible page.
   *
   * The actions column has its own (click)="$event.stopPropagation()" so
   * the per-member menu trigger doesn't double-fire this navigation.
   */
  protected openUser(row: LeagueRow): void {
    void this.router.navigate(['/users', row.uid]);
  }

  protected async confirmTransfer(row: LeagueRow): Promise<void> {
    if (
      !confirm(
        `Transfer ownership to ${row.displayName}? You'll become a regular member.`,
      )
    ) {
      return;
    }
    try {
      await this.leagues.transferOwnership(this.leagueId(), row.uid);
      this.snackBar.open(`Ownership transferred to ${row.displayName}`, undefined, {
        duration: 2000,
      });
    } catch (e: unknown) {
      this.snackBar.open(e instanceof Error ? e.message : 'Failed', 'Dismiss', {
        duration: 4000,
      });
    }
  }

  protected async confirmKick(row: LeagueRow): Promise<void> {
    if (!confirm(`Kick ${row.displayName} from the league?`)) return;
    try {
      await this.leagues.kickMember(this.leagueId(), row.uid);
      this.snackBar.open(`${row.displayName} kicked`, undefined, { duration: 1500 });
    } catch (e: unknown) {
      this.snackBar.open(e instanceof Error ? e.message : 'Failed', 'Dismiss', {
        duration: 4000,
      });
    }
  }
}
