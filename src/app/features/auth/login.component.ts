import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-login',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="login-container">
      <mat-card class="login-card" appearance="outlined">
        <mat-card-header>
          <mat-card-title>Goalden</mat-card-title>
          <mat-card-subtitle>Sign in to play</mat-card-subtitle>
        </mat-card-header>

        <mat-card-content>
          <button
            type="button"
            mat-stroked-button
            class="google-btn"
            (click)="signInGoogle()"
            [disabled]="loading()"
          >
            <mat-icon>login</mat-icon>
            Continue with Google
          </button>

          <div class="divider"><span>or</span></div>

          <form [formGroup]="form" (ngSubmit)="submitEmail()" autocomplete="on">
            <mat-form-field appearance="outline">
              <mat-label>Email</mat-label>
              <input matInput type="email" formControlName="email" autocomplete="email" />
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Password</mat-label>
              <input
                matInput
                type="password"
                formControlName="password"
                [autocomplete]="mode() === 'signin' ? 'current-password' : 'new-password'"
              />
              @if (form.controls.password.touched && form.controls.password.hasError('minlength')) {
                <mat-error>Minimum 6 characters</mat-error>
              }
            </mat-form-field>

            <div class="actions">
              <button
                type="submit"
                mat-flat-button
                color="primary"
                [disabled]="form.invalid || loading()"
              >
                @if (loading()) {
                  <mat-progress-spinner mode="indeterminate" diameter="20" />
                } @else if (mode() === 'signin') {
                  Sign in
                } @else {
                  Create account
                }
              </button>
              <button type="button" mat-button (click)="toggleMode()">
                @if (mode() === 'signin') {
                  Create account
                } @else {
                  Have an account? Sign in
                }
              </button>
            </div>
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
    .login-container {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100%;
      padding: 1rem;
      overflow-y: auto;
      overscroll-behavior: contain;
      box-sizing: border-box;
    }
    .login-card {
      width: 100%;
      max-width: 420px;
    }
    .google-btn {
      width: 100%;
      margin-top: 1rem;
    }
    .divider {
      text-align: center;
      margin: 1.25rem 0;
      color: var(--mat-sys-on-surface-variant);
      font-size: 0.85rem;
      text-transform: uppercase;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    mat-form-field {
      width: 100%;
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-top: 0.5rem;
    }
    .error {
      color: var(--mat-sys-error);
      margin-top: 1rem;
      text-align: center;
      font-size: 0.9rem;
    }
  `,
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly fb = inject(FormBuilder);

  private get returnUrl(): string {
    return this.route.snapshot.queryParamMap.get('returnUrl') ?? '/';
  }

  protected readonly mode = signal<'signin' | 'signup'>('signin');
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]],
  });

  protected toggleMode(): void {
    this.mode.update((m) => (m === 'signin' ? 'signup' : 'signin'));
    this.error.set(null);
  }

  protected async signInGoogle(): Promise<void> {
    this.error.set(null);
    this.loading.set(true);
    try {
      await this.auth.signInWithGoogle();
      await this.router.navigateByUrl(this.returnUrl);
    } catch (e: unknown) {
      this.error.set(toMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected async submitEmail(): Promise<void> {
    if (this.form.invalid) return;
    this.error.set(null);
    this.loading.set(true);
    const { email, password } = this.form.getRawValue();
    try {
      if (this.mode() === 'signin') {
        await this.auth.signInWithEmail(email, password);
      } else {
        await this.auth.signUpWithEmail(email, password);
      }
      await this.router.navigateByUrl(this.returnUrl);
    } catch (e: unknown) {
      this.error.set(toMessage(e));
    } finally {
      this.loading.set(false);
    }
  }
}

function toMessage(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: string }).code;
    if (code === 'auth/invalid-credential') return 'Wrong email or password.';
    if (code === 'auth/email-already-in-use') return 'That email is already registered.';
    if (code === 'auth/weak-password') return 'Password is too weak.';
    if (code === 'auth/popup-closed-by-user') return 'Sign in cancelled.';
    return e.message;
  }
  return 'Something went wrong. Try again.';
}
