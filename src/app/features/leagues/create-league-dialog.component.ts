import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
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
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>
      <mat-icon class="title-icon">groups</mat-icon>
      Create a league
    </h2>
    <mat-dialog-content>
      <form [formGroup]="form">
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>League name</mat-label>
          <input
            matInput
            formControlName="name"
            maxlength="40"
            cdkFocusInitial
            autocomplete="off"
          />
          <mat-hint align="end">{{ form.controls.name.value.length }}/40</mat-hint>
          @if (form.controls.name.touched && form.controls.name.hasError('minlength')) {
            <mat-error>At least 2 characters</mat-error>
          }
        </mat-form-field>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()" [disabled]="creating()">Cancel</button>
      <button
        mat-flat-button
        color="primary"
        (click)="submit()"
        [disabled]="form.invalid || creating()"
      >
        @if (creating()) {
          <mat-progress-spinner mode="indeterminate" diameter="20" />
        } @else {
          Create
        }
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    h2 {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
    }
    .title-icon {
      color: var(--mat-sys-primary);
    }
    mat-form-field {
      width: 100%;
      min-width: 320px;
    }
  `,
})
export class CreateLeagueDialogComponent {
  private readonly leagues = inject(LeaguesService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialogRef = inject(MatDialogRef<CreateLeagueDialogComponent, string>);
  private readonly fb = inject(FormBuilder);

  protected readonly creating = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(40)]],
  });

  protected cancel(): void {
    this.dialogRef.close();
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) return;
    this.creating.set(true);
    try {
      const { leagueId } = await this.leagues.createLeague(this.form.controls.name.value);
      this.dialogRef.close(leagueId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not create league';
      this.snackBar.open(msg, 'Dismiss', { duration: 4000 });
    } finally {
      this.creating.set(false);
    }
  }
}
