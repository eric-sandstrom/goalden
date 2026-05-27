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
import { MatTooltipModule } from '@angular/material/tooltip';
import { SkelComponent } from '../../shared/components/skel.component';
import { AuthService } from '../../core/services/auth.service';
import { LeaguesService } from '../../core/services/leagues.service';
import { parseTotals } from '../../core/services/user.service';
import { League, LeagueMember } from '../../core/models/league.model';
import { PredictNextCardComponent } from '../predict/predict-next-card.component';

interface LeagueRow {
  readonly uid: string;
  readonly rank: number;
  readonly displayName: string;
  readonly photoURL: string | null;
  readonly totalPoints: number;
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
    MatTooltipModule,
    SkelComponent,
    PredictNextCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      @if (!league()) {
        <mat-card appearance="outlined">
          <mat-card-header>
            <app-skel width="40px" height="40px" rounded />
            <div class="hdr-text">
              <app-skel width="50%" height="1.25rem" block />
              <div style="height: 6px;"></div>
              <app-skel width="35%" height="1rem" block />
            </div>
          </mat-card-header>
        </mat-card>
        <mat-card appearance="outlined" class="card-grow">
          <div class="card-scroll skel-list">
            @for (i of skelRows; track i) {
              <div class="skel-row">
                <app-skel width="18px" height="1rem" />
                <app-skel width="28px" height="28px" rounded />
                <app-skel width="40%" height="1rem" />
                <app-skel width="28px" height="1rem" />
              </div>
            }
          </div>
        </mat-card>
      } @else {
        <mat-card appearance="outlined">
          <mat-card-header>
            <mat-icon matCardAvatar [class.type-global]="league()!.type === 'global'">
              {{ headerIcon() }}
            </mat-icon>
            <mat-card-title>
              <span class="title-row">
                <span class="title-text">{{ league()!.name }}</span>
                @if (league()!.type !== 'private') {
                  <mat-chip
                    class="type-chip"
                    [class.type-chip-global]="league()!.type === 'global'"
                    [class.type-chip-public]="league()!.type === 'public'"
                    [disableRipple]="true"
                  >
                    <mat-icon matChipAvatar>
                      {{ league()!.type === 'global' ? 'public' : 'visibility' }}
                    </mat-icon>
                    {{ league()!.type === 'global' ? 'Global' : 'Public' }}
                  </mat-chip>
                }
              </span>
            </mat-card-title>
            <mat-card-subtitle>{{ headerSubtitle() }}</mat-card-subtitle>
            <span class="grow"></span>
            @if (hasMenuItems()) {
              <button mat-icon-button [matMenuTriggerFor]="menu" aria-label="League actions">
                <mat-icon>more_vert</mat-icon>
              </button>
              <mat-menu #menu="matMenu">
                @if (canShareInvite()) {
                  <button mat-menu-item (click)="copyLink()">
                    <mat-icon>link</mat-icon>
                    Copy invite link
                  </button>
                  <button mat-menu-item (click)="copyCode()">
                    <mat-icon>content_copy</mat-icon>
                    Copy code
                  </button>
                }
                @if (amOwner() && canModerate()) {
                  <button mat-menu-item (click)="regenerateCode()">
                    <mat-icon>autorenew</mat-icon>
                    Regenerate invite code
                  </button>
                  <button mat-menu-item (click)="confirmDelete()">
                    <mat-icon>delete</mat-icon>
                    Delete league
                  </button>
                }
                @if (canLeave()) {
                  <button mat-menu-item (click)="leave()">
                    <mat-icon>logout</mat-icon>
                    Leave league
                  </button>
                }
              </mat-menu>
            }
          </mat-card-header>
        </mat-card>

        <!-- Predict-next card: drop in one outstanding fixture for the
             league's competition. Today every league shares the same
             World Cup fixture pool; once leagues become multi-competition
             this card will read a leagueId-scoped fixture source. -->
        <app-predict-next-card />

        <!-- Invite card: private + public leagues both have invite codes
             so this renders for both. Global leagues have no invite code
             (auto-enrolled only) — guard hides the card for them. -->
        @if (league()!.inviteCode) {
          <mat-card appearance="outlined" class="invite">
            <mat-card-header>
              <mat-icon matCardAvatar>qr_code_2</mat-icon>
              <mat-card-title>{{ inviteCardTitle() }}</mat-card-title>
              <mat-card-subtitle>{{ inviteCardSubtitle() }}</mat-card-subtitle>
            </mat-card-header>
            <mat-card-content class="invite-content">
              <qrcode
                [qrdata]="inviteUrl()"
                [width]="180"
                [errorCorrectionLevel]="'M'"
                [margin]="2"
                [colorDark]="'#000000'"
                [colorLight]="'#ffffff'"
                [allowEmptyString]="false"
              ></qrcode>
              <div class="invite-meta">
                <mat-chip-set>
                  <mat-chip [disableRipple]="true">
                    <mat-icon matChipAvatar>vpn_key</mat-icon>
                    {{ league()!.inviteCode }}
                  </mat-chip>
                </mat-chip-set>
                <button mat-stroked-button (click)="copyLink()">
                  <mat-icon>link</mat-icon>
                  Copy link
                </button>
              </div>
            </mat-card-content>
          </mat-card>
        }

        <mat-card appearance="outlined" class="table-wrap card-grow">
          <div class="card-scroll">
            <table mat-table [dataSource]="rows()">
              <ng-container matColumnDef="rank">
                <th mat-header-cell *matHeaderCellDef>#</th>
                <td mat-cell *matCellDef="let row">{{ row.rank }}</td>
              </ng-container>

              <ng-container matColumnDef="player">
                <th mat-header-cell *matHeaderCellDef>Player</th>
                <td mat-cell *matCellDef="let row">
                  <span class="player">
                    @if (row.photoURL) {
                      <img
                        [ngSrc]="row.photoURL"
                        width="28"
                        height="28"
                        [alt]="row.displayName + ' avatar'"
                        class="avatar"
                      />
                    } @else {
                      <mat-icon class="avatar-fallback" aria-hidden="true">person</mat-icon>
                    }
                    <span class="name">{{ row.displayName }}</span>
                    @if (row.role === 'owner') {
                      <mat-icon
                        class="owner-icon"
                        aria-label="Owner"
                        matTooltip="League owner"
                      >workspace_premium</mat-icon>
                    }
                  </span>
                </td>
              </ng-container>

              <ng-container matColumnDef="points">
                <th mat-header-cell *matHeaderCellDef>Pts</th>
                <td mat-cell *matCellDef="let row"><strong>{{ row.totalPoints }}</strong></td>
              </ng-container>

              <ng-container matColumnDef="actions">
                <th mat-header-cell *matHeaderCellDef></th>
                <td mat-cell *matCellDef="let row" (click)="$event.stopPropagation()">
                  @if (canManageMember(row)) {
                    <button
                      mat-icon-button
                      [matMenuTriggerFor]="rowMenu"
                      aria-label="Manage member"
                    >
                      <mat-icon>more_vert</mat-icon>
                    </button>
                    <mat-menu #rowMenu="matMenu">
                      <button mat-menu-item (click)="confirmTransfer(row)">
                        <mat-icon>workspace_premium</mat-icon>
                        Transfer ownership
                      </button>
                      <button mat-menu-item (click)="confirmKick(row)">
                        <mat-icon>person_remove</mat-icon>
                        Kick member
                      </button>
                    </mat-menu>
                  }
                </td>
              </ng-container>

              <tr mat-header-row *matHeaderRowDef="columns; sticky: true"></tr>
              <tr
                mat-row
                *matRowDef="let row; columns: columns"
                [class.me]="row.uid === myUid()"
                [class.clickable]="row.uid !== myUid()"
                (click)="openUser(row)"
              ></tr>
            </table>
          </div>
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
    .grow { flex: 1; }
    mat-card-header { align-items: center; }

    /* Header title with optional type chip alongside the league name. */
    .title-row {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
      min-width: 0;
    }
    .title-text {
      min-width: 0;
      overflow-wrap: break-word;
    }
    /* Type chip — small, low-key. Uses Material's tertiary for public and
       primary for global so they're visually distinct without shouting. */
    .type-chip {
      transform: scale(0.85);
      transform-origin: left center;
    }
    .type-chip-public {
      background-color: color-mix(in srgb, var(--mat-sys-tertiary) 18%, transparent) !important;
      color: var(--mat-sys-on-tertiary-container) !important;
    }
    .type-chip-global {
      background-color: color-mix(in srgb, var(--mat-sys-primary) 18%, transparent) !important;
      color: var(--mat-sys-on-primary-container) !important;
    }
    /* Tint the header avatar icon for global leagues so the page feels
       distinct top-to-bottom, not just a chip in the corner. */
    .type-global {
      color: var(--mat-sys-primary);
    }
    .hdr-text { flex: 1; min-width: 0; }
    .invite-content {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 1rem;
    }
    .invite-meta {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      flex: 1;
      min-width: 0;
    }
    .table-wrap { padding: 0; overflow: hidden; }
    .skel-list { padding: 0; }
    .skel-row {
      display: grid;
      grid-template-columns: auto auto 1fr auto;
      gap: 0.75rem;
      align-items: center;
      padding: 0.85rem 1rem;
      min-height: 52px;
      box-sizing: border-box;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .skel-row:last-child { border-bottom: none; }
    table { width: 100%; }
    .player {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .avatar {
      border-radius: 50%;
      object-fit: cover;
    }
    .avatar-fallback {
      width: 28px;
      height: 28px;
      font-size: 28px;
      color: var(--mat-sys-on-surface-variant);
    }
    .name { font-weight: 500; }
    .owner-icon {
      width: 16px;
      height: 16px;
      font-size: 16px;
      color: var(--mat-sys-tertiary);
    }
    tr.me {
      background: var(--mat-sys-secondary-container);
    }
    tr.me td { color: var(--mat-sys-on-secondary-container); }
    /* Make other-user rows feel tappable — hover tint + pointer cursor. */
    tr.clickable {
      cursor: pointer;
      transition: background-color 120ms ease;
    }
    tr.clickable:hover {
      background: var(--mat-sys-surface-container-low);
    }
    .state {
      display: flex;
      justify-content: center;
      padding: 2rem;
    }
  `,
})
export class LeagueDetailComponent {
  readonly leagueId = input.required<string>();

  private readonly leagues = inject(LeaguesService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _members = signal<readonly LeagueMember[]>([]);
  private readonly _memberUsers = signal<ReadonlyMap<string, Record<string, unknown>>>(new Map());

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

  /** Hide the menu trigger entirely when there's nothing in the menu —
   *  e.g. a non-leavable global league shown to a non-admin member. */
  protected readonly hasMenuItems = computed(() => {
    return this.canShareInvite() || (this.amOwner() && this.canModerate()) || this.canLeave();
  });

  protected readonly columns = ['rank', 'player', 'points', 'actions'];
  protected readonly skelRows = [0, 1, 2, 3, 4];

  protected readonly inviteUrl = computed(() => {
    const code = this.league()?.inviteCode;
    if (!code) return '';
    return `${window.location.origin}/j/${code}`;
  });

  /** Header copy for the invite card. Public leagues get a different
   *  phrasing since they're already discoverable — the QR/code is for
   *  convenience, not access control. */
  protected readonly inviteCardTitle = computed(() => {
    return this.league()?.type === 'public' ? 'Share this league' : 'Invite friends';
  });

  protected readonly inviteCardSubtitle = computed(() => {
    return this.league()?.type === 'public'
      ? 'Scan, share the link, or anyone can find it in Discover'
      : 'Scan or share the link';
  });

  protected readonly rows = computed<readonly LeagueRow[]>(() => {
    const members = this._members();
    const users = this._memberUsers();
    const list = members.map((m) => {
      const u = users.get(m.uid) ?? {};
      const totals = parseTotals((u as Record<string, unknown>)['totals']);
      return {
        uid: m.uid,
        displayName: (u['displayName'] as string) ?? 'Unknown',
        photoURL: (u['photoURL'] as string | null) ?? null,
        totalPoints: totals.total,
        role: m.role,
      };
    });
    list.sort((a, b) => b.totalPoints - a.totalPoints);
    return list.map((r, i) => ({ ...r, rank: i + 1 }));
  });

  constructor() {
    effect((onCleanup) => {
      const id = this.leagueId();
      if (!id) {
        this._members.set([]);
        this._memberUsers.set(new Map());
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
        if (missing.length === 0) return;

        try {
          const fresh = await this.leagues.getMemberUserDocs(missing);
          if (fresh.size === 0) return;
          const next = new Map(this._memberUsers());
          for (const [uid, data] of fresh) next.set(uid, data);
          this._memberUsers.set(next);
        } catch (e: unknown) {
          console.error('[LeagueDetail] user-doc fetch failed:', e);
        }
      });

      onCleanup(() => unsubMembers());
    });
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

  /** Navigate to another user's profile. Tapping your own row is a no-op
   *  since seeing your own stats from the league context isn't useful —
   *  you'd just use the /profile tab. */
  protected openUser(row: LeagueRow): void {
    if (row.uid === this.myUid()) return;
    void this.router.navigate(['/users', row.uid]);
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
