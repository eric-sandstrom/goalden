import { NgOptimizedImage } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  resource,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { Team } from '../../core/models/team.model';
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
  templateUrl: './teams.component.html',
  styleUrl: './teams.component.scss',
})
export class TeamsComponent {
  private readonly teamsService = inject(TeamsService);
  private readonly fb = inject(FormBuilder);

  /** Competition to scope the browse list to, bound from the
   *  `/comp/:competitionId/teams` route via withComponentInputBinding().
   *  Empty (the bare `/teams` route) → fall back to the shared service
   *  signal, which merges every active competition's teams. */
  readonly competitionId = input<string>('');

  protected readonly searchControl = this.fb.nonNullable.control('');
  protected readonly skelRows = [0, 1, 2, 3, 4, 5, 6, 7];

  /** Comp-scoped teams, loaded once per competition from its
   *  `cache/teams-{compId}` rollup. Idle (no load) on the unscoped route. */
  private readonly scopedResource = resource<readonly Team[], string | undefined>({
    params: () => this.competitionId() || undefined,
    loader: ({ params }) => this.teamsService.loadTeamsForComp(params),
    defaultValue: [],
  });

  /** Source list: the comp-scoped rollup when a competition is bound, else
   *  the shared all-active-comps signal. */
  private readonly sourceTeams = computed<readonly Team[]>(() =>
    this.competitionId() ? this.scopedResource.value() : this.teamsService.teams(),
  );

  protected readonly loaded = computed<boolean>(() =>
    this.competitionId() ? !this.scopedResource.isLoading() : this.teamsService.loaded(),
  );

  /** Reactive bridge: lift the reactive form's value stream into a signal so
   *  filteredTeams() recomputes on every keystroke. */
  private readonly searchValue = toSignal(this.searchControl.valueChanges, {
    initialValue: this.searchControl.value,
  });

  protected readonly filteredTeams = computed(() => {
    const all = this.sourceTeams();
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
