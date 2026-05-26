import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { InstallPromptService } from '../../core/services/install-prompt.service';
import { PredictionsService } from '../../core/services/predictions.service';

@Component({
  selector: 'app-install-banner',
  imports: [MatButtonModule, MatCardModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <mat-card appearance="outlined" class="banner" role="region" aria-label="Install Goalden">
        <mat-card-header>
          <mat-icon matCardAvatar class="icon">
            {{ showIOSHint() ? 'ios_share' : 'install_mobile' }}
          </mat-icon>
          <mat-card-title>Install Goalden</mat-card-title>
          <mat-card-subtitle>
            @if (showIOSHint()) {
              Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong> to install.
            } @else {
              Quick launcher + match reminders. Two seconds, no app store.
            }
          </mat-card-subtitle>
        </mat-card-header>

        <mat-card-actions align="end">
          <button mat-button (click)="dismiss()">Not now</button>
          @if (canInstall()) {
            <button mat-flat-button color="primary" (click)="install()">
              <mat-icon>install_desktop</mat-icon>
              Install
            </button>
          }
        </mat-card-actions>
      </mat-card>
    }
  `,
  styles: `
    .banner {
      margin: 1rem 1rem 0;
      border-color: var(--mat-sys-primary);
    }
    .icon {
      color: var(--mat-sys-primary);
    }
  `,
})
export class InstallBannerComponent {
  private readonly installPrompt = inject(InstallPromptService);
  private readonly predictions = inject(PredictionsService);

  protected readonly canInstall = this.installPrompt.canInstall;

  // Show the iOS hint when:
  //   - we're on iOS
  //   - the app isn't already installed
  //   - and the browser didn't fire beforeinstallprompt (iOS Safari never does)
  protected readonly showIOSHint = computed(
    () =>
      !this.installPrompt.canInstall() &&
      this.installPrompt.isIOS() &&
      !this.installPrompt.isStandalone(),
  );

  protected readonly visible = computed(() => {
    if (this.installPrompt.dismissed()) return false;
    if (this.installPrompt.isStandalone()) return false;

    const sessions = this.installPrompt.sessionCount();
    const hasPredictions = this.predictions.count() > 0;

    // CLAUDE.md Q14.D — show only after first prediction AND on 2nd+ session.
    if (sessions < 2 || !hasPredictions) return false;

    // Show if we have a native prompt OR we can guide the iOS user manually.
    return this.canInstall() || this.showIOSHint();
  });

  protected dismiss(): void {
    this.installPrompt.dismiss();
  }

  protected async install(): Promise<void> {
    await this.installPrompt.install();
  }
}
