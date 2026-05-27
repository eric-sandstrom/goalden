import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AuthService } from '../../core/services/auth.service';
import { LeaguesService } from '../../core/services/leagues.service';
import { UserService } from '../../core/services/user.service';
import { LeaguePublic } from '../../core/models/league.model';

@Component({
  selector: 'app-join-league',
  imports: [MatButtonModule, MatCardModule, MatIconModule, MatProgressSpinnerModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './join-league.component.html',
  styleUrl: './join-league.component.scss',
})
export class JoinLeagueComponent {
  readonly code = input.required<string>();

  private readonly leagues = inject(LeaguesService);
  private readonly auth = inject(AuthService);
  private readonly userService = inject(UserService);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);

  protected readonly loading = signal(true);
  protected readonly joining = signal(false);
  protected readonly publicLeague = signal<LeaguePublic | null>(null);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly isAuthed = this.auth.isAuthenticated;

  constructor() {
    effect(() => {
      const c = this.code();
      // Track isAuthed so this effect re-runs after sign-in (a returning
      // visitor after auth needs the public lookup to fire).
      this.isAuthed();
      if (!c) return;
      void this.loadPublic(c);
    });
  }

  private async loadPublic(code: string): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      // Public read needs auth — sign-in flow handles unauth case via the
      // "Sign in to join" button below.
      if (!this.auth.isAuthenticated()) {
        this.loading.set(false);
        return;
      }
      const l = await this.leagues.getPublicLeague(code);
      if (!l) {
        this.errorMessage.set('That invite code is invalid or has been revoked.');
      } else {
        this.publicLeague.set(l);
      }
    } catch (e: unknown) {
      this.errorMessage.set(e instanceof Error ? e.message : 'Failed to load league');
    } finally {
      this.loading.set(false);
    }
  }

  protected signIn(): void {
    const returnUrl = `/j/${this.code()}`;
    void this.router.navigate(['/login'], { queryParams: { returnUrl } });
  }

  protected async join(): Promise<void> {
    this.joining.set(true);
    try {
      const { leagueId } = await this.leagues.joinByCode(this.code());
      this.snackBar.open('Joined league', undefined, { duration: 1500 });
      // If user has no displayName yet, send them through onboarding first.
      if (!this.userService.hasDisplayName()) {
        await this.router.navigate(['/onboarding/display-name'], {
          queryParams: { returnUrl: `/leagues/${leagueId}` },
        });
      } else {
        await this.router.navigate(['/leagues', leagueId]);
      }
    } catch (e: unknown) {
      this.snackBar.open(e instanceof Error ? e.message : 'Could not join', 'Dismiss', {
        duration: 4000,
      });
    } finally {
      this.joining.set(false);
    }
  }
}
