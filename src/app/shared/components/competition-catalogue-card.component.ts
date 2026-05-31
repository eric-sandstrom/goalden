import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { httpsCallable } from 'firebase/functions';
import { FUNCTIONS } from '../../core/firebase/firebase.providers';
import { Competition } from '../../core/models/competition.model';
import { CompetitionsService } from '../../core/services/competitions.service';

interface SyncResult {
  ok: boolean;
  discovered: number;
  created: number;
  updated: number;
}

/** Outcome of a one-shot competition ingest, mirrored from the
 *  `setCompetitionActive` / `resyncCompetition` callables. */
interface IngestResult {
  fixtures: { ok: boolean; fetched: number; written: number } | null;
  teams: boolean;
  standings: boolean;
  errors: string[];
}

interface ToggleResult {
  ok: boolean;
  compId: string;
  active: boolean;
  ingest: IngestResult | null;
}

interface ResyncResult {
  ok: boolean;
  compId: string;
  ingest: IngestResult;
}

/**
 * Competition catalogue card: lists every discovered competition with a
 * per-row active toggle (gates fixture polling) and a "Sync from API"
 * button (re-discovers comps from football-data). Shared between the
 * Admin page and Dev tools so the two surfaces can't drift — both call
 * the same `syncCompetitionsFromApi` / `setCompetitionActive` callables,
 * which re-check the admin role server-side.
 */
@Component({
  selector: 'app-competition-catalogue-card',
  imports: [
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    MatTooltipModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './competition-catalogue-card.component.html',
  styleUrl: './competition-catalogue-card.component.scss',
})
export class CompetitionCatalogueCardComponent {
  private readonly competitionsService = inject(CompetitionsService);
  private readonly functions = inject(FUNCTIONS);
  private readonly snackBar = inject(MatSnackBar);

  protected readonly competitions = this.competitionsService.competitions;
  protected readonly activeCount = computed(
    () => this.competitionsService.activeCompetitions().length,
  );

  protected readonly running = signal(false);

  /** Per-comp pending state for the active toggle row buttons. Keeps one
   *  comp's spinner from disabling every other comp's toggle. */
  protected readonly togglePending = signal<ReadonlySet<string>>(new Set());

  /** Per-comp pending state for the "Re-sync fixtures" row button. */
  protected readonly resyncPending = signal<ReadonlySet<string>>(new Set());

  protected isTogglePending(compId: string): boolean {
    return this.togglePending().has(compId);
  }

  protected isResyncPending(compId: string): boolean {
    return this.resyncPending().has(compId);
  }

  /** One-line summary of an ingest result for a snackbar. */
  private ingestSummary(ingest: IngestResult | null): string {
    if (!ingest) return '';
    const parts: string[] = [];
    if (ingest.fixtures) parts.push(`${ingest.fixtures.written} fixtures`);
    if (ingest.teams) parts.push('teams');
    if (ingest.standings) parts.push('standings');
    let msg = parts.length > 0 ? ` · synced ${parts.join(', ')}` : '';
    if (ingest.errors.length > 0) msg += ` · ${ingest.errors.length} issue(s)`;
    return msg;
  }

  protected async syncCompetitions(): Promise<void> {
    this.running.set(true);
    try {
      const call = httpsCallable<unknown, SyncResult>(this.functions, 'syncCompetitionsFromApi');
      const res = await call({});
      const { discovered, created, updated } = res.data;
      this.snackBar.open(
        `Discovered ${discovered} competitions · ${created} new · ${updated} updated`,
        undefined,
        { duration: 3500 },
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Sync failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('syncCompetitionsFromApi failed', e);
    } finally {
      this.running.set(false);
    }
  }

  protected async toggleCompetitionActive(comp: Competition): Promise<void> {
    this.togglePending.update((s) => new Set([...s, comp.id]));
    const next = !comp.active;
    try {
      const call = httpsCallable<unknown, ToggleResult>(this.functions, 'setCompetitionActive');
      // Activating now pulls the whole season + teams + standings, so this can
      // take a few seconds; the toggle stays disabled until it resolves.
      const res = await call({ compId: comp.id, active: next });
      this.snackBar.open(
        next
          ? `${comp.name} activated${this.ingestSummary(res.data.ingest)}`
          : `${comp.name} deactivated`,
        undefined,
        { duration: 3500 },
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Toggle failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('setCompetitionActive failed', e);
    } finally {
      this.togglePending.update((s) => {
        const copy = new Set(s);
        copy.delete(comp.id);
        return copy;
      });
    }
  }

  /** Re-run the full ingest (fixtures + detail + teams + standings) for one
   *  competition without toggling it — pulls far-future schedule changes the
   *  live poll's window doesn't cover. */
  protected async resyncFixtures(comp: Competition): Promise<void> {
    this.resyncPending.update((s) => new Set([...s, comp.id]));
    try {
      const call = httpsCallable<unknown, ResyncResult>(this.functions, 'resyncCompetition');
      const res = await call({ compId: comp.id });
      this.snackBar.open(`${comp.name}${this.ingestSummary(res.data.ingest) || ' · synced'}`, undefined, {
        duration: 3500,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Re-sync failed';
      this.snackBar.open(message, 'Dismiss', { duration: 5000 });
      console.error('resyncCompetition failed', e);
    } finally {
      this.resyncPending.update((s) => {
        const copy = new Set(s);
        copy.delete(comp.id);
        return copy;
      });
    }
  }
}
