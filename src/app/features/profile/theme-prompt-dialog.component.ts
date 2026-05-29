import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

/**
 * Small dialog that collects a free-text "vibe" to hand to Gemini for AI
 * theming. Resolves (via `MatDialogRef`) to the trimmed text, or `undefined`
 * if the user cancels.
 */
@Component({
  selector: 'app-theme-prompt-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatChipsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './theme-prompt-dialog.component.html',
  styleUrl: './theme-prompt-dialog.component.scss',
})
export class ThemePromptDialogComponent {
  private readonly ref = inject(MatDialogRef<ThemePromptDialogComponent, string>);

  protected readonly prompt = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(120)],
  });

  /** Quick-fill suggestions to make the empty state friendlier. */
  protected readonly examples = [
    'Sunset over the ocean',
    'Brazilian carnival',
    'Forest at dawn',
    'Retro arcade',
  ];

  protected use(example: string): void {
    this.prompt.setValue(example);
  }

  protected cancel(): void {
    this.ref.close();
  }

  protected submit(): void {
    const value = this.prompt.value.trim();
    if (value) this.ref.close(value);
  }
}
