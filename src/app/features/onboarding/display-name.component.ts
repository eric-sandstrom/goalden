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
  template: `
    <div class="container">
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-card-title>What should we call you?</mat-card-title>
          <mat-card-subtitle>This shows up on leaderboards.</mat-card-subtitle>
        </mat-card-header>

        <mat-card-content>
          <form [formGroup]="form" (ngSubmit)="submit()">
            <mat-form-field appearance="outline">
              <mat-label>Display name</mat-label>
              <input
                matInput
                formControlName="name"
                autocomplete="nickname"
                maxlength="30"
                #nameInput
              />
              <mat-hint align="end">{{ length() }}/30</mat-hint>
              @if (form.controls.name.touched && form.controls.name.hasError('minlength')) {
                <mat-error>Minimum 2 characters</mat-error>
              }
            </mat-form-field>

            <button
              type="submit"
              mat-flat-button
              color="primary"
              [disabled]="form.invalid || loading()"
            >
              Continue
            </button>
          </form>

          @if (error()) {
            <div class="error" role="alert">{{ error() }}</div>
          }
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
    }
    .container {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100%;
      padding: 1rem;
      overflow-y: auto;
      overscroll-behavior: contain;
      box-sizing: border-box;
    }
    mat-card {
      width: 100%;
      max-width: 420px;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    mat-form-field {
      width: 100%;
    }
    .error {
      color: var(--mat-sys-error);
      margin-top: 1rem;
      text-align: center;
      font-size: 0.9rem;
    }
  `,
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
