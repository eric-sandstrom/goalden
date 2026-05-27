import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { LeaguesService } from '../../core/services/leagues.service';

@Component({
  selector: 'app-create-league-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './create-league-dialog.component.html',
  styleUrl: './create-league-dialog.component.scss',
})
export class CreateLeagueDialogComponent {
  private readonly leagues = inject(LeaguesService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialogRef = inject(MatDialogRef<CreateLeagueDialogComponent, string>);
  private readonly fb = inject(FormBuilder);

  protected readonly creating = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(40)]],
    type: ['private' as 'private' | 'public', Validators.required],
  });

  protected cancel(): void {
    this.dialogRef.close();
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) return;
    this.creating.set(true);
    try {
      const value = this.form.getRawValue();
      const { leagueId } = await this.leagues.createLeague(value.name, value.type);
      this.dialogRef.close(leagueId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not create league';
      this.snackBar.open(msg, 'Dismiss', { duration: 4000 });
    } finally {
      this.creating.set(false);
    }
  }
}
