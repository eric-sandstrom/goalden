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
  templateUrl: './teams.component.html',
  styleUrl: './teams.component.scss',
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
