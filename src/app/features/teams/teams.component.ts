import { NgOptimizedImage } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { TeamsService } from '../../core/services/teams.service';
import { SkelComponent } from '../../shared/components/skel.component';

@Component({
  selector: 'app-teams',
  imports: [
    NgOptimizedImage,
    ReactiveFormsModule,
    RouterLink,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    SkelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="hero">
        <h1>Teams</h1>
        <mat-form-field appearance="outline" subscriptSizing="dynamic" class="search">
          <mat-icon matIconPrefix>search</mat-icon>
          <mat-label>Filter</mat-label>
          <input matInput [formControl]="searchControl" autocomplete="off" spellcheck="false" />
        </mat-form-field>
      </header>

      <mat-card appearance="outlined" class="card-grow teams-card">
        <div class="card-scroll">
          @if (!loaded()) {
            <div class="grid">
              @for (i of skelRows; track i) {
                <div class="skel-tile">
                  <app-skel width="56px" height="56px" rounded />
                  <app-skel width="70%" height="1rem" block />
                  <app-skel width="40%" height="0.8rem" block />
                </div>
              }
            </div>
          } @else if (filteredTeams().length === 0) {
            <div class="empty">
              <mat-icon aria-hidden="true">groups_off</mat-icon>
              <p>
                @if (searchControl.value) {
                  No teams match "{{ searchControl.value }}".
                } @else {
                  No teams yet. They populate on the next pollTeams run.
                }
              </p>
            </div>
          } @else {
            <div class="grid">
              @for (team of filteredTeams(); track team.id) {
                <a class="tile" [routerLink]="['/teams', team.id]">
                  @if (team.crest) {
                    <img
                      [ngSrc]="team.crest"
                      width="56"
                      height="56"
                      [alt]="team.name + ' crest'"
                      class="crest"
                    />
                  } @else {
                    <div class="crest crest-fallback" aria-hidden="true">
                      <mat-icon>shield</mat-icon>
                    </div>
                  }
                  <span class="name">{{ team.name }}</span>
                  @if (team.tla) {
                    <span class="tla">{{ team.tla }}</span>
                  }
                </a>
              }
            </div>
          }
        </div>
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
    .hero {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      flex: 0 0 auto;
    }
    h1 {
      margin: 0;
      font: var(--mat-sys-headline-medium);
    }
    .search { width: 100%; }
    .teams-card {
      padding: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 0.5rem;
      padding: 0.75rem;
    }
    .tile {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.4rem;
      padding: 0.875rem 0.5rem;
      text-decoration: none;
      color: inherit;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 14px;
      background: var(--mat-sys-surface);
      transition: border-color 120ms ease, background-color 120ms ease, transform 120ms ease;
      min-height: 132px;
      box-sizing: border-box;
    }
    .tile:hover {
      background: var(--mat-sys-surface-container-low);
      border-color: var(--mat-sys-outline);
    }
    .tile:active { transform: scale(0.98); }
    .crest {
      width: 56px;
      height: 56px;
      object-fit: contain;
    }
    .crest-fallback {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface-variant);
    }
    .crest-fallback mat-icon { font-size: 32px; width: 32px; height: 32px; }
    .name {
      font-size: 0.9rem;
      font-weight: 600;
      text-align: center;
      line-height: 1.2;
      overflow-wrap: break-word;
      hyphens: auto;
    }
    .tla {
      font-size: 0.72rem;
      letter-spacing: 0.08em;
      color: var(--mat-sys-on-surface-variant);
    }
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
      padding: 3rem 1rem;
      color: var(--mat-sys-on-surface-variant);
    }
    /* Skeleton tile mirrors the real tile's shape so loading doesn't shift
       layout when teams pop in. */
    .skel-tile {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.4rem;
      padding: 0.875rem 0.5rem;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 14px;
      min-height: 132px;
      box-sizing: border-box;
    }
  `,
})
export class TeamsComponent {
  private readonly teamsService = inject(TeamsService);
  private readonly fb = inject(FormBuilder);

  protected readonly searchControl = this.fb.nonNullable.control('');
  protected readonly loaded = this.teamsService.loaded;
  protected readonly skelRows = [0, 1, 2, 3, 4, 5, 6, 7];

  /** Reactive bridge: lift the reactive form's value stream into a signal so
   *  filteredTeams() recomputes on every keystroke. */
  private readonly searchValue = toSignal(this.searchControl.valueChanges, {
    initialValue: this.searchControl.value,
  });

  protected readonly filteredTeams = computed(() => {
    const all = this.teamsService.teams();
    const q = (this.searchValue() ?? '').trim().toLowerCase();
    if (!q) return all;
    return all.filter((t) => {
      return (
        t.name.toLowerCase().includes(q) ||
        (t.shortName ?? '').toLowerCase().includes(q) ||
        (t.tla ?? '').toLowerCase().includes(q)
      );
    });
  });
}
