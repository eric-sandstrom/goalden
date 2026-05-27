import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { environment } from '../../../environments/environment';
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
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
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

  /** Show the "Sign in as Admin (dev)" button only when running
   *  against the local Functions emulator. The callable behind it
   *  refuses to run anywhere else, so this is purely UX trimming —
   *  no security boundary lives here. */
  protected readonly showDevLogin = environment.useEmulators;

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

  /** Emulator-only one-click admin sign-in. Behind a server-side
   *  emulator gate, so calling this in prod fails cleanly. */
  protected async signInAsDevAdmin(): Promise<void> {
    this.error.set(null);
    this.loading.set(true);
    try {
      await this.auth.signInAsDevAdmin();
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
