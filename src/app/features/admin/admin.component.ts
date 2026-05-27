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
  templateUrl: './admin.component.html',
  styleUrl: './admin.component.scss',
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
