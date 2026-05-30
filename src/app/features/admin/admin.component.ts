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
import { MatTooltipModule } from '@angular/material/tooltip';
import { Competition } from '../../core/models/competition.model';
import { League, LeagueGlobalConfig } from '../../core/models/league.model';
import { AdminMetrics, AdminService } from '../../core/services/admin.service';
import { CompetitionsService } from '../../core/services/competitions.service';
import { FixturesService } from '../../core/services/fixtures.service';
import { LeaguesService } from '../../core/services/leagues.service';
import { CompetitionCatalogueCardComponent } from '../../shared/components/competition-catalogue-card.component';

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
    MatTooltipModule,
    CompetitionCatalogueCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin.component.html',
  styleUrl: './admin.component.scss',
})
export class AdminComponent {
  private readonly leaguesService = inject(LeaguesService);
  private readonly competitionsService = inject(CompetitionsService);
  private readonly fixtures = inject(FixturesService);
  private readonly admin = inject(AdminService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly creating = signal(false);
  protected readonly busyLeagueId = signal<string | null>(null);
  protected readonly leagues = signal<readonly League[]>([]);

  // --- Metrics -----------------------------------------------------------
  protected readonly metrics = signal<AdminMetrics | null>(null);
  protected readonly metricsLoading = signal(false);
  protected readonly metricsError = signal(false);

  // --- Score correction --------------------------------------------------
  protected readonly correcting = signal(false);
  /** Competition the score-correction fixture picker is scoped to.
   *  Reading `fixturesFor` keyed on this loads that comp's fixtures. */
  protected readonly correctCompId = signal<string>('');

  // --- Backfill missed scoring ------------------------------------------
  protected readonly backfilling = signal(false);

  // --- Broadcast ---------------------------------------------------------
  protected readonly broadcasting = signal(false);

  /** Competition picker source for the create form — the ACTIVE competitions
   *  (the ones polling fixtures), partitioned into Tournaments / Domestic
   *  Leagues optgroups. We use `activeByType` rather than the user-facing
   *  `selectableByType` (which hides ended seasons) because global leagues
   *  are admin-curated and the server does no season gate — so an admin can
   *  create one for an active comp even between seasons (e.g. the Champions
   *  League). Flip a comp's toggle in the catalogue below to make it
   *  available here. */
  protected readonly groupedComps = this.competitionsService.activeByType;

  /** Flat list of competitions with a derivable season, for the
   *  score-correction comp scope selector. */
  protected readonly compChoices = computed(() =>
    this.competitionsService
      .competitions()
      .map((c) => ({ id: c.id, name: c.name, season: seasonKeyOf(c) }))
      .filter((c): c is { id: string; name: string; season: string } => c.season !== null)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  protected readonly createForm = this.fb.nonNullable.group({
    competitionId: ['', Validators.required],
    description: [''],
    autoEnroll: ['all' as 'all' | 'filter', Validators.required],
    filterField: [''],
    filterEquals: [''],
    allowLeave: [false],
  });

  protected readonly correctForm = this.fb.nonNullable.group({
    matchId: ['', Validators.required],
    homeScore: [0, [Validators.required, Validators.min(0)]],
    awayScore: [0, [Validators.required, Validators.min(0)]],
  });

  protected readonly broadcastForm = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.maxLength(60)]],
    body: ['', [Validators.required, Validators.maxLength(160)]],
    link: [''],
  });

  protected readonly leagueListSubtitle = computed(() => {
    const n = this.leagues().length;
    if (n === 0) return 'No global leagues';
    return `${n} ${n === 1 ? 'league' : 'leagues'} active`;
  });

  /** Season derived from the chosen correction comp; '' until a comp with
   *  season metadata is selected. */
  private readonly correctSeason = computed(
    () => seasonKeyOf(this.competitionsService.byId(this.correctCompId())) ?? '',
  );

  /** FINISHED fixtures for the chosen comp — the only ones a score
   *  correction applies to. */
  protected readonly finishedFixtureOptions = computed(() => {
    const compId = this.correctCompId();
    const season = this.correctSeason();
    if (!compId || !season) return [];
    return this.fixtures
      .fixturesFor(compId, season)()
      .filter((f) => f.status === 'FINISHED')
      .map((f) => ({
        matchId: f.id,
        label: `${f.homeTeam.tla ?? '?'} ${f.score?.fullTime?.home ?? '?'}–${f.score?.fullTime?.away ?? '?'} ${f.awayTeam.tla ?? '?'} · ${f.utcKickoff.toLocaleDateString()}`,
      }));
  });

  constructor() {
    // Server-side admin check is what actually enforces; this listener works
    // because the rules already allow signed-in reads on leagues (we list
    // EVERY league when the user is admin via the UI guard).
    const unsub = this.leaguesService.listenToGlobalLeagues((list) => {
      this.leagues.set(list);
    });
    this.destroyRef.onDestroy(() => unsub());

    void this.loadMetrics();
  }

  protected leagueConditionLabel(league: League): string {
    const cfg = league.globalConfig;
    if (!cfg) return 'invalid config';
    if (cfg.autoEnroll === 'all') return 'all users';
    if (cfg.filter) return `${cfg.filter.field} = ${String(cfg.filter.equals)}`;
    return 'filter';
  }

  // ===========================================================================
  // Metrics
  // ===========================================================================

  protected async loadMetrics(): Promise<void> {
    this.metricsLoading.set(true);
    this.metricsError.set(false);
    try {
      this.metrics.set(await this.admin.getMetrics());
    } catch (e: unknown) {
      this.metricsError.set(true);
      console.error('getAdminMetrics failed', e);
    } finally {
      this.metricsLoading.set(false);
    }
  }

  /** Absolute local time for a metrics timestamp, or '—' when unknown. */
  protected formatTime(ms: number | null): string {
    if (ms === null) return '—';
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // ===========================================================================
  // Create global league
  // ===========================================================================

  protected async submit(): Promise<void> {
    if (this.createForm.invalid) return;
    const v = this.createForm.getRawValue();

    const comp = this.competitionsService.byId(v.competitionId);
    if (!comp) {
      this.snackBar.open('Pick a competition', 'Dismiss', { duration: 4000 });
      return;
    }

    const config: LeagueGlobalConfig =
      v.autoEnroll === 'filter'
        ? {
            autoEnroll: 'filter',
            filter: { field: v.filterField.trim(), equals: coerce(v.filterEquals.trim()) },
            allowLeave: v.allowLeave,
          }
        : { autoEnroll: 'all', allowLeave: v.allowLeave };

    if (config.autoEnroll === 'filter' && !config.filter?.field) {
      this.snackBar.open('Filter requires a field name', 'Dismiss', { duration: 4000 });
      return;
    }

    // League name comes from the competition (+ season span), never typed.
    const season = seasonKeyOf(comp) ?? String(new Date().getFullYear());
    const label = seasonLabelOf(comp);
    const name = (label ? `${comp.name} ${label}` : comp.name).slice(0, 60);

    this.creating.set(true);
    try {
      const res = await this.leaguesService.createGlobalLeague({
        name,
        description: v.description.trim(),
        globalConfig: config,
        competitionId: comp.id,
        season,
      });
      this.snackBar.open(`Created "${name}" · ${res.enrolled} users enrolled`, undefined, {
        duration: 2500,
      });
      this.createForm.reset({
        competitionId: '',
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
      this.snackBar.open(`Synced · added ${res.added}, total ${res.total}`, undefined, {
        duration: 2500,
      });
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

  // ===========================================================================
  // Score correction
  // ===========================================================================

  protected selectCorrectComp(compId: string): void {
    this.correctCompId.set(compId);
    this.correctForm.controls.matchId.setValue('');
  }

  protected async correctScore(): Promise<void> {
    if (this.correctForm.invalid) return;
    const { matchId, homeScore, awayScore } = this.correctForm.getRawValue();
    if (!matchId) {
      this.snackBar.open('Pick a fixture first', 'Dismiss', { duration: 3000 });
      return;
    }
    this.correcting.set(true);
    try {
      const res = await this.admin.correctFixtureScore(matchId, homeScore, awayScore);
      this.snackBar.open(
        `Corrected (${res.winner}) · re-scored ${res.rescored} prediction(s)`,
        undefined,
        { duration: 3000 },
      );
      void this.loadMetrics();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Correction failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('correctFixtureScore failed', e);
    } finally {
      this.correcting.set(false);
    }
  }

  // ===========================================================================
  // Backfill missed scoring
  // ===========================================================================

  /**
   * Re-runs scoring for any terminal fixture whose predictions were never
   * scored. Scoped to the comp picked in the score-correction selector when
   * one is chosen, else scans every competition. Idempotent — safe to click
   * repeatedly; already-scored predictions are left untouched.
   */
  protected async backfillMissed(): Promise<void> {
    const compId = this.correctCompId();
    const scope = compId
      ? this.competitionsService.byId(compId)?.name ?? compId
      : 'all competitions';
    const ok = window.confirm(
      `Score missed fixtures for ${scope}? This scores any finished games whose predictions never got points. It won't change already-scored predictions.`,
    );
    if (!ok) return;

    this.backfilling.set(true);
    try {
      const res = await this.admin.scoreMissedFixtures(compId || undefined);
      this.snackBar.open(
        res.predictionsScored === 0
          ? `No missed predictions — ${res.fixturesProcessed} finished fixture(s) checked`
          : `Scored ${res.predictionsScored} prediction(s) across ${res.details.length} fixture(s)`,
        undefined,
        { duration: 4000 },
      );
      void this.loadMetrics();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Backfill failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('scoreMissedFixtures failed', e);
    } finally {
      this.backfilling.set(false);
    }
  }

  // ===========================================================================
  // Broadcast
  // ===========================================================================

  protected async broadcast(): Promise<void> {
    if (this.broadcastForm.invalid) return;
    const { title, body, link } = this.broadcastForm.getRawValue();
    const ok = window.confirm(
      `Send "${title.trim()}" to every registered device? This notifies all users.`,
    );
    if (!ok) return;

    this.broadcasting.set(true);
    try {
      const res = await this.admin.broadcastNotification(
        title.trim(),
        body.trim(),
        link.trim() || undefined,
      );
      this.snackBar.open(
        res.devices === 0
          ? 'No registered devices to notify'
          : `Sent to ${res.sent}/${res.devices} device(s) across ${res.users} user(s)`,
        undefined,
        { duration: 3500 },
      );
      this.broadcastForm.reset({ title: '', body: '', link: '' });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Broadcast failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('broadcastNotification failed', e);
    } finally {
      this.broadcasting.set(false);
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

/** Season key (start year, e.g. "2025") — the value stored on the league
 *  and used in the {compId}_{season} totals-shard id. Null when the comp
 *  has no usable season metadata. */
function seasonKeyOf(comp: Competition | null): string | null {
  const start = comp?.currentSeason?.startDate;
  return start && start.length >= 4 ? start.slice(0, 4) : null;
}

/** Human season label for the league name. Spans two calendar years when
 *  the season does (e.g. "2025/2026"); collapses to a single year when
 *  start and end fall in the same year (e.g. WC → "2026"). */
function seasonLabelOf(comp: Competition | null): string | null {
  const s = comp?.currentSeason;
  if (!s?.startDate || s.startDate.length < 4) return null;
  const startYear = s.startDate.slice(0, 4);
  const endYear = s.endDate && s.endDate.length >= 4 ? s.endDate.slice(0, 4) : startYear;
  return startYear === endYear ? startYear : `${startYear}/${endYear}`;
}
