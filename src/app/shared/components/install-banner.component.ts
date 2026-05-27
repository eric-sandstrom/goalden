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
  templateUrl: './install-banner.component.html',
  styleUrl: './install-banner.component.scss',
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
