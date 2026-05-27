import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { League, LeagueGlobalConfig } from '../../core/models/league.model';
import { LeaguesService } from '../../core/services/leagues.service';

@Component({
  selector: 'app-admin',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="hero">
        <h1>Admin</h1>
        <p class="hint">Manage global leagues — visible to all matching users.</p>
      </header>

      <!-- ===================================================================
           Create global league
      ==================================================================== -->
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-icon matCardAvatar>add_circle</mat-icon>
          <mat-card-title>Create global league</mat-card-title>
          <mat-card-subtitle>All matching users are auto-enrolled immediately</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <form [formGroup]="createForm" class="form" (ngSubmit)="submit()">
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>Name</mat-label>
              <input matInput formControlName="name" maxlength="60" />
            </mat-form-field>

            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>Description (optional)</mat-label>
              <input matInput formControlName="description" maxlength="200" />
            </mat-form-field>

            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>Auto-enroll</mat-label>
              <mat-select formControlName="autoEnroll">
                <mat-option value="all">All users</mat-option>
                <mat-option value="filter">Users matching a filter</mat-option>
              </mat-select>
            </mat-form-field>

            @if (createForm.controls.autoEnroll.value === 'filter') {
              <div class="filter-row">
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                  <mat-label>Field name</mat-label>
                  <input matInput formControlName="filterField" placeholder="e.g. country" />
                </mat-form-field>
                <span class="filter-equals" aria-hidden="true">=</span>
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                  <mat-label>Equals</mat-label>
                  <input matInput formControlName="filterEquals" />
                </mat-form-field>
              </div>
              <p class="hint small">
                Tip: any field on the user doc. Strings, numbers, or booleans
                ("true"/"false"). Comparison is strict equality.
              </p>
            }

            <mat-checkbox formControlName="allowLeave">
              Allow members to leave this league
            </mat-checkbox>

            <button
              mat-flat-button
              color="primary"
              type="submit"
              [disabled]="createForm.invalid || creating()"
            >
              @if (creating()) {
                <mat-progress-spinner mode="indeterminate" diameter="20" />
              } @else {
                Create league
              }
            </button>
          </form>
        </mat-card-content>
      </mat-card>

      <!-- ===================================================================
           Existing global leagues
      ==================================================================== -->
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-icon matCardAvatar>public</mat-icon>
          <mat-card-title>Global leagues</mat-card-title>
          <mat-card-subtitle>{{ leagueListSubtitle() }}</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          @if (leagues().length === 0) {
            <p class="hint">None yet — create one above.</p>
          } @else {
            <div class="leagues">
              @for (league of leagues(); track league.id) {
                <div class="league-row">
                  <div class="league-meta">
                    <span class="league-name">{{ league.name }}</span>
                    <span class="league-sub">
                      {{ league.memberCount }} members ·
                      {{ leagueConditionLabel(league) }} ·
                      {{ league.globalConfig?.allowLeave ? 'leavable' : 'mandatory' }}
                    </span>
                  </div>
                  <div class="league-actions">
                    <button
                      type="button"
                      mat-stroked-button
                      [disabled]="busyLeagueId() === league.id"
                      (click)="sync(league)"
                    >
                      <mat-icon>sync</mat-icon> Sync
                    </button>
                    <button
                      type="button"
                      mat-stroked-button
                      class="danger"
                      [disabled]="busyLeagueId() === league.id"
                      (click)="remove(league)"
                    >
                      <mat-icon>delete</mat-icon> Delete
                    </button>
                  </div>
                </div>
              }
            </div>
          }
        </mat-card-content>
      </mat-card>
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
    .page {
      overflow-y: auto;
    }
    .hero {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      align-items: flex-start;
    }
    h1 {
      margin: 0;
      font: var(--mat-sys-headline-medium);
    }
    .hint {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font-size: 0.9rem;
    }
    .hint.small { font-size: 0.78rem; }

    .form {
      display: flex;
      flex-direction: column;
      gap: 0.875rem;
    }
    mat-form-field { width: 100%; }
    .filter-row {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: start;
      gap: 0.5rem;
    }
    .filter-equals {
      align-self: center;
      font-weight: 600;
      color: var(--mat-sys-on-surface-variant);
    }

    .leagues {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .league-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      padding: 0.625rem 0.75rem;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
      background: var(--mat-sys-surface);
    }
    .league-meta {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      min-width: 0;
      flex: 1;
    }
    .league-name {
      font-weight: 600;
    }
    .league-sub {
      font-size: 0.78rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .league-actions {
      display: flex;
      gap: 0.5rem;
      flex-shrink: 0;
    }
    .danger {
      --mdc-outlined-button-label-text-color: var(--mat-sys-error);
      --mdc-outlined-button-outline-color:
        color-mix(in srgb, var(--mat-sys-error) 60%, transparent);
    }
  `,
})
export class AdminComponent {
  private readonly leaguesService = inject(LeaguesService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly creating = signal(false);
  protected readonly busyLeagueId = signal<string | null>(null);
  protected readonly leagues = signal<readonly League[]>([]);

  protected readonly createForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(60)]],
    description: [''],
    autoEnroll: ['all' as 'all' | 'filter', Validators.required],
    filterField: [''],
    filterEquals: [''],
    allowLeave: [false],
  });

  protected readonly leagueListSubtitle = computed(() => {
    const n = this.leagues().length;
    if (n === 0) return 'No global leagues';
    return `${n} ${n === 1 ? 'league' : 'leagues'} active`;
  });

  constructor() {
    // Server-side admin check is what actually enforces; this listener works
    // because the rules already allow signed-in reads on leagues (we list
    // EVERY league when the user is admin via the UI guard).
    const unsub = this.leaguesService.listenToGlobalLeagues((list) => {
      this.leagues.set(list);
    });
    this.destroyRef.onDestroy(() => unsub());
  }

  protected leagueConditionLabel(league: League): string {
    const cfg = league.globalConfig;
    if (!cfg) return 'invalid config';
    if (cfg.autoEnroll === 'all') return 'all users';
    if (cfg.filter) return `${cfg.filter.field} = ${String(cfg.filter.equals)}`;
    return 'filter';
  }

  protected async submit(): Promise<void> {
    if (this.createForm.invalid) return;
    const v = this.createForm.getRawValue();
    const config: LeagueGlobalConfig =
      v.autoEnroll === 'filter'
        ? {
            autoEnroll: 'filter',
            filter: { field: v.filterField.trim(), equals: coerce(v.filterEquals.trim()) },
            allowLeave: v.allowLeave,
          }
        : { autoEnroll: 'all', allowLeave: v.allowLeave };

    if (config.autoEnroll === 'filter' && (!config.filter?.field)) {
      this.snackBar.open('Filter requires a field name', 'Dismiss', { duration: 4000 });
      return;
    }

    this.creating.set(true);
    try {
      const res = await this.leaguesService.createGlobalLeague({
        name: v.name.trim(),
        description: v.description.trim(),
        globalConfig: config,
      });
      this.snackBar.open(`Created · ${res.enrolled} users enrolled`, undefined, {
        duration: 2500,
      });
      this.createForm.reset({
        name: '',
        description: '',
        autoEnroll: 'all',
        filterField: '',
        filterEquals: '',
        allowLeave: false,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to create league';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('createGlobalLeague failed', e);
    } finally {
      this.creating.set(false);
    }
  }

  protected async sync(league: League): Promise<void> {
    this.busyLeagueId.set(league.id);
    try {
      const res = await this.leaguesService.syncGlobalLeague(league.id);
      this.snackBar.open(
        `Synced · added ${res.added}, total ${res.total}`,
        undefined,
        { duration: 2500 },
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Sync failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('syncGlobalLeague failed', e);
    } finally {
      this.busyLeagueId.set(null);
    }
  }

  protected async remove(league: League): Promise<void> {
    const ok = window.confirm(
      `Delete "${league.name}" and remove all ${league.memberCount} members? This cannot be undone.`,
    );
    if (!ok) return;
    this.busyLeagueId.set(league.id);
    try {
      await this.leaguesService.deleteGlobalLeague(league.id);
      this.snackBar.open('League deleted', undefined, { duration: 2000 });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Delete failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('deleteGlobalLeague failed', e);
    } finally {
      this.busyLeagueId.set(null);
    }
  }
}

/** Convert the user-typed "equals" value into a string/number/boolean. The
 *  callable expects one of those three types, so we sniff for "true"/"false"
 *  and numeric strings before falling back to plain string. */
function coerce(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}
