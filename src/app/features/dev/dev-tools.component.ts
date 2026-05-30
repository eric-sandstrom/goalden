import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { httpsCallable } from 'firebase/functions';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FUNCTIONS } from '../../core/firebase/firebase.providers';
import { Competition } from '../../core/models/competition.model';
import { CompetitionsService } from '../../core/services/competitions.service';
import { FixturesService } from '../../core/services/fixtures.service';
import { PredictionsService } from '../../core/services/predictions.service';
import { UserService } from '../../core/services/user.service';
import { CompetitionCatalogueCardComponent } from '../../shared/components/competition-catalogue-card.component';

type FixtureStatus = 'TIMED' | 'IN_PLAY' | 'PAUSED' | 'FINISHED';

@Component({
  selector: 'app-dev-tools',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatChipsModule,
    MatDividerModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    CompetitionCatalogueCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dev-tools.component.html',
  styleUrl: './dev-tools.component.scss',
})
export class DevToolsComponent {
  private readonly fixtures = inject(FixturesService);
  private readonly predictions = inject(PredictionsService);
  private readonly userService = inject(UserService);
  private readonly competitionsService = inject(CompetitionsService);
  private readonly functions = inject(FUNCTIONS);
  private readonly snackBar = inject(MatSnackBar);
  private readonly fb = inject(FormBuilder);

  protected readonly running = signal(false);

  /** Owners see the role-management card; everyone else doesn't. The
   *  callables behind the buttons re-check the role server-side. */
  protected readonly isOwner = this.userService.isOwner;

  /**
   * Competition the fixture tools (Fixture state / Move kickoff / Scenarios)
   * act on. Defaults to WC; the "Competition scope" selector lets an admin
   * drive any synced comp. `fixturesFor` is safe inside a computed — its
   * side effects are deferred — and reading it loads the comp on demand.
   */
  protected readonly devComp = signal<string>('WC');

  /** Selector choices: every synced comp with a derivable season, by name. */
  protected readonly compChoices = computed(() =>
    this.competitionsService
      .competitions()
      .map((c) => ({ id: c.id, name: c.name, season: seasonOf(c) }))
      .filter((c): c is { id: string; name: string; season: string } => c.season !== null)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  /** Season of the selected comp; falls back to '2026' so the WC default
   *  works before the catalogue hydrates. */
  protected readonly devCompSeason = computed(
    () => seasonOf(this.competitionsService.byId(this.devComp())) ?? '2026',
  );

  private readonly _fixtures = computed(() =>
    this.fixtures.fixturesFor(this.devComp(), this.devCompSeason())(),
  );

  protected readonly fixtureOptions = computed(() => {
    return this._fixtures().map((f) => ({
      matchId: f.id,
      label: `${f.homeTeam.tla ?? '?'} vs ${f.awayTeam.tla ?? '?'} · ${f.status} · ${f.utcKickoff.toLocaleString(
        undefined,
        { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
      )}`,
    }));
  });

  /** Only fixtures the user has a prediction for, in the selected comp —
   *  scenario buttons need a prediction to compute exact/outcome/wrong
   *  scores against. */
  protected readonly predictedOptions = computed(() => {
    const preds = this.predictions.matchPredictions();
    const byId = this.fixtures.fixturesById();
    const comp = this.devComp();
    return [...preds.values()]
      .map((p) => {
        const f = byId.get(p.matchId);
        if (!f || f.competitionId !== comp) return null;
        return {
          matchId: p.matchId,
          label: `${f.homeTeam.tla} ${p.homeScore}-${p.awayScore} ${f.awayTeam.tla} · ${f.utcKickoff.toLocaleDateString()}`,
        };
      })
      .filter((x): x is { matchId: string; label: string } => x !== null);
  });

  protected readonly stateForm = this.fb.nonNullable.group({
    matchId: ['', Validators.required],
    status: ['FINISHED' as FixtureStatus, Validators.required],
    homeScore: [0, [Validators.required, Validators.min(0)]],
    awayScore: [0, [Validators.required, Validators.min(0)]],
  });

  protected readonly kickoffForm = this.fb.nonNullable.group({
    matchId: ['', Validators.required],
  });

  protected readonly scenarioForm = this.fb.nonNullable.group({
    matchId: ['', Validators.required],
  });

  /** Target uid for the grant/revoke admin actions. Validated as a
   *  non-empty string; format checks happen server-side (so we don't
   *  duplicate Firebase Auth's uid rules). */
  protected readonly roleForm = this.fb.nonNullable.group({
    uid: ['', [Validators.required, Validators.minLength(1)]],
  });

  /** How many fake users to seed for leaderboard testing (1–200). */
  protected readonly fakeUsersForm = this.fb.nonNullable.group({
    count: [20, [Validators.required, Validators.min(1), Validators.max(200)]],
  });

  // --------------------------------------------------------------------------
  // Multi-comp migration
  // --------------------------------------------------------------------------

  /**
   * Fires the one-shot data backfill that tags legacy WC fixtures /
   * leagues with `(competitionId='WC', season='2026')` and mirrors
   * users' nested totals into the per-comp shard at
   * `users/{uid}/totals/WC_2026`.
   *
   * Safe to re-run — every write is idempotent. Refuses if the WC
   * competition doc hasn't been synced yet (precondition surfaced as
   * a permission-style error from the callable).
   */
  protected async runMultiCompMigration(): Promise<void> {
    this.running.set(true);
    try {
      const call = httpsCallable<
        unknown,
        {
          ok: boolean;
          fixturesBackfilled: number;
          leaguesBackfilled: number;
          usersMigrated: number;
          usersSkipped: number;
        }
      >(this.functions, 'migrateToMultiComp');
      const res = await call({});
      const { fixturesBackfilled, leaguesBackfilled, usersMigrated, usersSkipped } = res.data;
      this.snackBar.open(
        `Migration ok · fixtures ${fixturesBackfilled} · leagues ${leaguesBackfilled} · users ${usersMigrated} (+${usersSkipped} skipped)`,
        undefined,
        { duration: 5000 },
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Migration failed';
      this.snackBar.open(message, 'Dismiss', { duration: 6000 });
      console.error('migrateToMultiComp failed', e);
    } finally {
      this.running.set(false);
    }
  }

  // --------------------------------------------------------------------------
  // Fixture state
  // --------------------------------------------------------------------------

  /** Switch which competition the fixture tools target. Clears the picked
   *  fixture in each form since those ids belong to the previous comp. */
  protected selectDevComp(compId: string): void {
    this.devComp.set(compId);
    this.stateForm.controls.matchId.setValue('');
    this.kickoffForm.controls.matchId.setValue('');
    this.scenarioForm.controls.matchId.setValue('');
  }

  protected async applyState(): Promise<void> {
    const { matchId, status, homeScore, awayScore } = this.stateForm.getRawValue();
    await this.runCallable('devSetFixtureState', { matchId, status, homeScore, awayScore }, `Fixture → ${status}`);
  }

  // --------------------------------------------------------------------------
  // Kickoff
  // --------------------------------------------------------------------------

  protected async moveKickoff(offsetMinutes: number): Promise<void> {
    const matchId = this.kickoffForm.controls.matchId.value;
    if (!matchId) {
      this.snackBar.open('Pick a fixture first', 'Dismiss', { duration: 2500 });
      return;
    }
    const label =
      offsetMinutes >= 0
        ? `Kickoff in ${offsetMinutes}m`
        : `Kickoff ${Math.abs(offsetMinutes)}m ago`;
    await this.runCallable('devSetKickoffTime', { matchId, offsetMinutes }, label);
  }

  // --------------------------------------------------------------------------
  // Scenarios
  // --------------------------------------------------------------------------

  protected async scenarioFinishExact(): Promise<void> {
    const pred = this.requirePrediction();
    if (!pred) return;
    await this.runCallable(
      'devSetFixtureState',
      {
        matchId: pred.matchId,
        status: 'FINISHED',
        homeScore: pred.homeScore,
        awayScore: pred.awayScore,
      },
      'FT — Exact (+3)',
    );
  }

  protected async scenarioFinishOutcome(): Promise<void> {
    const pred = this.requirePrediction();
    if (!pred) return;
    let home = pred.homeScore;
    let away = pred.awayScore;
    if (home > away) home += 1;
    else if (away > home) away += 1;
    else {
      home += 1;
      away += 1;
    }
    await this.runCallable(
      'devSetFixtureState',
      { matchId: pred.matchId, status: 'FINISHED', homeScore: home, awayScore: away },
      'FT — Outcome (+1)',
    );
  }

  protected async scenarioFinishWrong(): Promise<void> {
    const pred = this.requirePrediction();
    if (!pred) return;
    // Flip the winner: pick the opposite team's prediction +1.
    const home = pred.awayScore + 1;
    const away = pred.homeScore;
    await this.runCallable(
      'devSetFixtureState',
      { matchId: pred.matchId, status: 'FINISHED', homeScore: home, awayScore: away },
      'FT — Miss (0)',
    );
  }

  protected async scenarioStartLive(): Promise<void> {
    const matchId = this.scenarioForm.controls.matchId.value;
    if (!matchId) return;
    await this.runCallable(
      'devSetFixtureState',
      { matchId, status: 'IN_PLAY', homeScore: 0, awayScore: 0 },
      'Kicked off live 0–0',
    );
  }

  protected async scenarioLockSoon(): Promise<void> {
    const matchId = this.scenarioForm.controls.matchId.value;
    if (!matchId) return;
    // 0.5 minutes = 30 seconds. The 1m rounding in the UI's "Locks in Nm" chip
    // will display "Locks in 1m" but the actual lock fires in ~30s.
    await this.runCallable(
      'devSetKickoffTime',
      { matchId, offsetMinutes: 0.5 },
      'Lock in 30s',
    );
  }

  // --------------------------------------------------------------------------
  // Reset
  // --------------------------------------------------------------------------

  protected async pollFixturesNow(): Promise<void> {
    this.running.set(true);
    try {
      // Response shape mirrors the server's PollSummary — total counts
      // plus per-competition breakdown for partial-success surfaces.
      const call = httpsCallable<
        unknown,
        {
          ok: boolean;
          fetched: number;
          written: number;
          competitions: ReadonlyArray<{ compId: string; ok: boolean; written: number }>;
          message?: string;
        }
      >(this.functions, 'devPollFixturesNow');
      const res = await call({});
      const { fetched, written, competitions, message } = res.data;
      if (message && competitions.length === 0) {
        this.snackBar.open(message, 'Dismiss', { duration: 4000 });
      } else {
        const failed = competitions.filter((c) => !c.ok).length;
        const summary = failed > 0
          ? `Polled ${competitions.length} comps · ${failed} failed · wrote ${written}`
          : `Polled ${competitions.length} comp(s) · fetched ${fetched} · wrote ${written}`;
        this.snackBar.open(summary, undefined, { duration: 3000 });
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Poll failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('devPollFixturesNow failed', e);
    } finally {
      this.running.set(false);
    }
  }

  protected async pollStandingsNow(): Promise<void> {
    this.running.set(true);
    try {
      // Mirrors the server's StandingsPollSummary — total table count plus
      // a per-competition breakdown for partial-success surfaces.
      const call = httpsCallable<
        unknown,
        {
          ok: boolean;
          tables: number;
          written: number;
          competitions: ReadonlyArray<{ compId: string; ok: boolean; written: number }>;
          message?: string;
        }
      >(this.functions, 'devPollStandingsNow');
      const res = await call({});
      const { tables, written, competitions, message } = res.data;
      if (message && competitions.length === 0) {
        this.snackBar.open(message, 'Dismiss', { duration: 4000 });
      } else {
        const failed = competitions.filter((c) => !c.ok).length;
        const summary = failed > 0
          ? `Polled ${competitions.length} comps · ${failed} failed · wrote ${written}`
          : `Polled ${competitions.length} comp(s) · ${tables} tables · wrote ${written}`;
        this.snackBar.open(summary, undefined, { duration: 3000 });
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Poll failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('devPollStandingsNow failed', e);
    } finally {
      this.running.set(false);
    }
  }

  protected async pollTeamsNow(): Promise<void> {
    this.running.set(true);
    try {
      const call = httpsCallable<unknown, { ok: boolean; fetched: number; written: number }>(
        this.functions,
        'devPollTeamsNow',
      );
      const res = await call({});
      const { fetched, written } = res.data;
      this.snackBar.open(
        `Fetched ${fetched} teams, wrote ${written}`,
        undefined,
        { duration: 2500 },
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Poll failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('devPollTeamsNow failed', e);
    } finally {
      this.running.set(false);
    }
  }

  protected async resetState(flags: {
    clearMatchPredictions?: boolean;
    clearPodium?: boolean;
    resetTotals?: boolean;
  }): Promise<void> {
    const parts: string[] = [];
    if (flags.clearMatchPredictions) parts.push('predictions');
    if (flags.clearPodium) parts.push('podium');
    if (flags.resetTotals) parts.push('totals');
    await this.runCallable('devResetMyState', flags, `Cleared ${parts.join(', ')}`);
  }

  /**
   * Wipe the caller's predictor-personality doc. Lets you regenerate
   * without waiting out the 12 h cooldown — useful when iterating on
   * the Gemini prompt or the deterministic fallback's reasoning copy.
   */
  protected async clearPersonality(): Promise<void> {
    await this.runCallable('devClearMyPersonality', {}, 'Personality cleared');
  }

  /**
   * Promote a user to admin. Calls the owner-gated grantAdminRole
   * callable; the server re-checks the role so a non-owner clicking
   * this (e.g. an admin who somehow opened devtools) gets a clean
   * permission-denied snackbar.
   */
  protected async grantAdmin(): Promise<void> {
    const { uid } = this.roleForm.getRawValue();
    if (!uid) return;
    await this.runCallable('grantAdminRole', { uid }, `Granted admin to ${uid}`);
  }

  /** Demote a user — server refuses if target is an owner or is the
   *  caller themselves, so no client-side guards needed here. */
  protected async revokeAdmin(): Promise<void> {
    const { uid } = this.roleForm.getRawValue();
    if (!uid) return;
    await this.runCallable('revokeAdminRole', { uid }, `Revoked admin from ${uid}`);
  }

  // --------------------------------------------------------------------------
  // Leaderboard & test users
  // --------------------------------------------------------------------------

  /** Force a rebuild of the cache/leaderboard rollup. Handy in the emulator
   *  (the scheduled flush doesn't fire on a cron there) and to seed the doc
   *  before the tournament. */
  protected async rebuildLeaderboard(): Promise<void> {
    this.running.set(true);
    try {
      const call = httpsCallable<unknown, { rebuilt: boolean; count: number }>(
        this.functions,
        'devRebuildLeaderboardNow',
      );
      const res = await call({});
      this.snackBar.open(
        `Leaderboard rebuilt · ${res.data.count} entries`,
        undefined,
        { duration: 2500 },
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Rebuild failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('devRebuildLeaderboardNow failed', e);
    } finally {
      this.running.set(false);
    }
  }

  /** Seed N fake users (random totals) so the leaderboard has volume to
   *  test against. They also auto-enroll into any "all" global league. */
  protected async seedFakeUsers(): Promise<void> {
    const count = this.fakeUsersForm.controls.count.value;
    this.running.set(true);
    try {
      const call = httpsCallable<unknown, { created: number; leaderboardCount: number }>(
        this.functions,
        'devSeedFakeUsers',
      );
      const res = await call({ count });
      this.snackBar.open(
        `Seeded ${res.data.created} fake users · board ${res.data.leaderboardCount}`,
        undefined,
        { duration: 3000 },
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Seed failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('devSeedFakeUsers failed', e);
    } finally {
      this.running.set(false);
    }
  }

  /** Delete every fake user (and their auto-enrolled global memberships). */
  protected async clearFakeUsers(): Promise<void> {
    this.running.set(true);
    try {
      const call = httpsCallable<unknown, { deleted: number; membershipsRemoved: number }>(
        this.functions,
        'devClearFakeUsers',
      );
      const res = await call({});
      this.snackBar.open(
        `Removed ${res.data.deleted} fake users`,
        undefined,
        { duration: 2500 },
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Clear failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('devClearFakeUsers failed', e);
    } finally {
      this.running.set(false);
    }
  }

  // --------------------------------------------------------------------------
  // Shared callable runner
  // --------------------------------------------------------------------------

  private requirePrediction() {
    const matchId = this.scenarioForm.controls.matchId.value;
    if (!matchId) return null;
    return this.predictions.matchPredictions().get(matchId) ?? null;
  }

  private async runCallable(
    name: string,
    data: Record<string, unknown>,
    successLabel: string,
  ): Promise<void> {
    this.running.set(true);
    try {
      const call = httpsCallable<unknown, { ok: boolean }>(this.functions, name);
      await call(data);
      this.snackBar.open(successLabel, undefined, { duration: 1800 });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error(`${name} failed`, e);
    } finally {
      this.running.set(false);
    }
  }
}

/** Season starting year from a competition's currentSeason, or null when
 *  unknown (between-seasons window / un-synced comp). */
function seasonOf(comp: Competition | null): string | null {
  const start = comp?.currentSeason?.startDate;
  return start && start.length >= 4 ? start.slice(0, 4) : null;
}

