import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { AuthService } from '../../core/services/auth.service';
import { UserService } from '../../core/services/user.service';

@Component({
  selector: 'app-display-name',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './display-name.component.html',
  styleUrl: './display-name.component.scss',
})
export class DisplayNameComponent {
  private readonly userService = inject(UserService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    name: [
      this.initialName(),
      [Validators.required, Validators.minLength(2), Validators.maxLength(30)],
    ],
  });

  protected readonly length = computed(() => this.form.controls.name.value?.length ?? 0);

  private initialName(): string {
    const existing = this.userService.userDoc()?.displayName;
    if (existing) return existing;
    return this.auth.user()?.displayName ?? '';
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) return;
    this.error.set(null);
    this.loading.set(true);
    try {
      await this.userService.setDisplayName(this.form.controls.name.value);
      await this.router.navigate(['/']);
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      this.loading.set(false);
    }
  }
}
