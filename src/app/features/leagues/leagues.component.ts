import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { League } from '../../core/models/league.model';
import { AuthService } from '../../core/services/auth.service';
import { LeaguesService } from '../../core/services/leagues.service';
import { SkelComponent } from '../../shared/components/skel.component';
import { CreateLeagueDialogComponent } from './create-league-dialog.component';

interface LeagueStanding {
  rank: number;
  total: number;
  points: number;
}

@Component({
  selector: 'app-leagues',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatDividerModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatListModule,
    MatProgressSpinnerModule,
    SkelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './leagues.component.html',
  styleUrl: './leagues.component.scss',
})
export class LeaguesComponent {
  private readonly leagues = inject(LeaguesService);
  private readonly auth = inject(AuthService);
  private readonly bottomSheet = inject(MatBottomSheet);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loaded = this.leagues.fullyLoaded;
  protected readonly myList = this.leagues.myLeagueList;
  protected readonly joining = signal(false);
  protected readonly joiningId = signal<string | null>(null);
  protected readonly skelRows = [0, 1, 2];

  /** All public leagues live-watched via Firestore. */
  private readonly publicLeagues = signal<readonly League[]>([]);

  /** Public leagues the user isn't already a member of — what we surface
   *  in the Discover card. Computed so it auto-updates when either the
   *  user's own memberships or the public list changes. */
  protected readonly discoverable = computed<readonly League[]>(() => {
    const all = this.publicLeagues();
    if (all.length === 0) return [];
    const myIds = new Set(this.myList().map((m) => m.league.id));
    return all.filter((l) => !myIds.has(l.id));
  });

  protected readonly joinForm = this.fb.nonNullable.group({
    code: ['', [Validators.required, Validators.minLength(8)]],
  });

  /** Caller's rank + points per league, keyed by leagueId. Populated
   *  lazily as standings come in. */
  private readonly _standings = signal<ReadonlyMap<string, LeagueStanding>>(new Map());

  constructor() {
    const unsub = this.leagues.listenToPublicLeagues((list) => {
      this.publicLeagues.set(list);
    });
    this.destroyRef.onDestroy(() => unsub());

    // Whenever the user's set of leagues changes, fan out a one-shot
    // getLeagueStanding per league and merge results into the signal.
    // Each league becomes ~1-2 Firestore reads (members + batched user
    // docs); fine for the typical 1-5 leagues per user.
    effect(() => {
      const uid = this.auth.uid();
      const list = this.myList();
      if (!uid || list.length === 0) {
        this._standings.set(new Map());
        return;
      }
      void this.refetchStandings(list, uid);
    });
  }

  protected standingFor(leagueId: string): LeagueStanding | null {
    return this._standings().get(leagueId) ?? null;
  }

  private async refetchStandings(
    items: readonly { league: League }[],
    uid: string,
  ): Promise<void> {
    // Parallelise — N small reads in parallel rather than sequential.
    const results = await Promise.all(
      items.map(async (item) => {
        try {
          const standing = await this.leagues.getLeagueStanding(
            item.league.id,
            uid,
            item.league.competitionId,
            item.league.season,
          );
          return [item.league.id, standing] as const;
        } catch (err) {
          console.error(`[Leagues] standing for ${item.league.id} failed`, err);
          return null;
        }
      }),
    );
    const next = new Map<string, LeagueStanding>();
    for (const r of results) {
      if (r) next.set(r[0], r[1]);
    }
    this._standings.set(next);
  }

  protected leagueIcon(type: League['type'], role: 'owner' | 'member'): string {
    if (type === 'global') return 'public';
    if (type === 'public') return 'visibility';
    return role === 'owner' ? 'workspace_premium' : 'groups';
  }

  protected leagueRoleLabel(item: { league: League; role: 'owner' | 'member' }): string {
    if (item.league.type === 'global') return 'auto-enrolled';
    if (item.league.type === 'public') return item.role === 'owner' ? 'owner · public' : 'public';
    return item.role;
  }

  /** "12 members · Owner · Public · 142 pts" — combined info line for
   *  each row. Carries member count + role + type + your points score
   *  in one dense but readable strip. Points live here (rather than
   *  stacked under the rank in the meta column) because matListItemMeta
   *  clips multi-line content. */
  protected leagueSubline(
    item: { league: League; role: 'owner' | 'member' },
    standing: { points: number } | null,
  ): string {
    const parts: string[] = [];
    const count = item.league.memberCount;
    parts.push(`${count} member${count === 1 ? '' : 's'}`);
    if (item.role === 'owner') {
      parts.push('Owner');
    }
    if (item.league.type === 'global') {
      parts.push('Global');
    } else if (item.league.type === 'public') {
      parts.push('Public');
    }
    if (standing) {
      parts.push(`${standing.points} pts`);
    }
    return parts.join(' · ');
  }

  /** Card-header subtitle for the "Your leagues" card — short summary
   *  of how many leagues the user is in. */
  protected myLeaguesSubtitle(): string {
    const n = this.myList().length;
    return `${n} league${n === 1 ? '' : 's'}`;
  }

  /** CSS class for the rank text. Top-3 ranks get medal colours so a
   *  glance at the card surfaces "you're winning" / "podium spot" /
   *  "in the running" before the user reads any numbers. */
  protected rankClass(rank: number): string {
    if (rank === 1) return 'rank-gold';
    if (rank === 2) return 'rank-silver';
    if (rank === 3) return 'rank-bronze';
    return '';
  }

  protected async joinPublic(league: League): Promise<void> {
    this.joiningId.set(league.id);
    try {
      await this.leagues.joinPublicLeague(league.id);
      this.snackBar.open(`Joined ${league.name}`, undefined, { duration: 1800 });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not join league';
      this.snackBar.open(msg, 'Dismiss', { duration: 4000 });
    } finally {
      this.joiningId.set(null);
    }
  }

  protected async openCreate(): Promise<void> {
    const ref = this.bottomSheet.open<CreateLeagueDialogComponent, void, string>(
      CreateLeagueDialogComponent,
      { panelClass: 'create-league-sheet' },
    );
    const leagueId = await firstValueFrom(ref.afterDismissed());
    if (leagueId) {
      await this.router.navigate(['/leagues', leagueId]);
    }
  }

  protected async join(): Promise<void> {
    if (this.joinForm.invalid) return;
    this.joining.set(true);
    try {
      const { leagueId } = await this.leagues.joinByCode(this.joinForm.controls.code.value);
      this.snackBar.open('Joined league', undefined, { duration: 1500 });
      this.joinForm.reset({ code: '' });
      await this.router.navigate(['/leagues', leagueId]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not join league';
      this.snackBar.open(msg, 'Dismiss', { duration: 4000 });
    } finally {
      this.joining.set(false);
    }
  }
}
