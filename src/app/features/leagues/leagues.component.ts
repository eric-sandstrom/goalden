import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { LeaguesService } from '../../core/services/leagues.service';
import { SkelComponent } from '../../shared/components/skel.component';
import { CreateLeagueDialogComponent } from './create-league-dialog.component';

@Component({
  selector: 'app-leagues',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatDialogModule,
    MatDividerModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatListModule,
    MatProgressSpinnerModule,
    SkelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="hero">
        <h1>Leagues</h1>
        <button mat-flat-button color="primary" (click)="openCreate()">
          <mat-icon>add</mat-icon>
          Create league
        </button>
      </header>

      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-icon matCardAvatar>login</mat-icon>
          <mat-card-title>Join with a code</mat-card-title>
          <mat-card-subtitle>Paste an invite link or code</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <form [formGroup]="joinForm" (ngSubmit)="join()" class="join">
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="code-field">
              <mat-label>Invite code</mat-label>
              <input
                matInput
                formControlName="code"
                placeholder="ABCD-1234"
                autocomplete="off"
                autocapitalize="characters"
                spellcheck="false"
              />
            </mat-form-field>
            <button
              mat-flat-button
              color="primary"
              type="submit"
              [disabled]="joinForm.invalid || joining()"
            >
              @if (joining()) {
                <mat-progress-spinner mode="indeterminate" diameter="20" />
              } @else {
                Join
              }
            </button>
          </form>
        </mat-card-content>
      </mat-card>

      @if (!loaded()) {
        <mat-card appearance="outlined" class="card-grow my-leagues-card">
          <mat-card-header>
            <mat-icon matCardAvatar>groups</mat-icon>
            <mat-card-title>Your leagues</mat-card-title>
          </mat-card-header>
          <div class="card-scroll skel-list">
            @for (i of skelRows; track i) {
              <div class="skel-row">
                <app-skel width="24px" height="24px" rounded />
                <div class="skel-text">
                  <app-skel width="50%" height="1rem" block />
                  <div style="height: 4px;"></div>
                  <app-skel width="30%" height="0.8rem" block />
                </div>
              </div>
            }
          </div>
        </mat-card>
      } @else if (myList().length === 0) {
        <mat-card appearance="outlined" class="empty">
          <mat-icon aria-hidden="true">group_off</mat-icon>
          <p>You aren't in any leagues yet. Create one or join via a code.</p>
        </mat-card>
      } @else {
        <mat-card appearance="outlined" class="card-grow my-leagues-card">
          <mat-card-header>
            <mat-icon matCardAvatar>groups</mat-icon>
            <mat-card-title>Your leagues</mat-card-title>
          </mat-card-header>
          <div class="card-scroll">
            <mat-nav-list>
              @for (item of myList(); track item.league.id) {
                <a mat-list-item [routerLink]="['/leagues', item.league.id]">
                  <mat-icon matListItemIcon>
                    {{ item.role === 'owner' ? 'workspace_premium' : 'groups' }}
                  </mat-icon>
                  <span matListItemTitle>{{ item.league.name }}</span>
                  <span matListItemLine>
                    {{ item.league.memberCount }} members · {{ item.role }}
                  </span>
                </a>
              }
            </mat-nav-list>
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
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
      flex: 0 0 auto;
    }
    .hero h1 {
      margin: 0;
      font: var(--mat-sys-headline-medium);
    }
    .join {
      display: flex;
      gap: 0.5rem;
      align-items: flex-start;
    }
    .code-field { flex: 1; }
    .my-leagues-card {
      padding-bottom: 0.25rem;
    }
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 2rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .skel-list {
      padding: 0.25rem 0.75rem 0.5rem;
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .skel-row {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.75rem 1rem;
      min-height: 64px;
      box-sizing: border-box;
    }
    .skel-text {
      flex: 1;
    }
  `,
})
export class LeaguesComponent {
  private readonly leagues = inject(LeaguesService);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly fb = inject(FormBuilder);

  protected readonly loaded = this.leagues.fullyLoaded;
  protected readonly myList = this.leagues.myLeagueList;
  protected readonly joining = signal(false);
  protected readonly skelRows = [0, 1, 2];

  protected readonly joinForm = this.fb.nonNullable.group({
    code: ['', [Validators.required, Validators.minLength(8)]],
  });

  protected async openCreate(): Promise<void> {
    const ref = this.dialog.open<CreateLeagueDialogComponent, void, string>(
      CreateLeagueDialogComponent,
    );
    const leagueId = await ref.afterClosed().toPromise();
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
