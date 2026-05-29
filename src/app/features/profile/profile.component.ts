import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSliderModule } from '@angular/material/slider';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { httpsCallable } from 'firebase/functions';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { FUNCTIONS } from '../../core/firebase/firebase.providers';
import { AuthService } from '../../core/services/auth.service';
import { NotificationsService } from '../../core/services/notifications.service';
import { PersonalityService } from '../../core/services/personality.service';
import {
  ColorMode,
  PRESET_CUSTOM,
  PRESET_DEFAULT,
  PresetCode,
  ThemeService,
  VariantName,
} from '../../core/services/theme.service';
import { UserService } from '../../core/services/user.service';
import { LifetimeTotalsCardComponent } from './lifetime-totals-card.component';
import { PredictorPersonalityCardComponent } from './predictor-personality-card.component';
import { ThemePromptDialogComponent } from './theme-prompt-dialog.component';

@Component({
  selector: 'app-profile',
  imports: [
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSliderModule,
    MatTooltipModule,
    LifetimeTotalsCardComponent,
    PredictorPersonalityCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss',
})
export class ProfileComponent {
  private readonly auth = inject(AuthService);
  private readonly userService = inject(UserService);
  private readonly themeService = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  /** Exposed as `protected` because the template binds the personality
   *  card's inputs directly off the service signals. */
  protected readonly personality = inject(PersonalityService);
  protected readonly notifications = inject(NotificationsService);
  private readonly functions = inject(FUNCTIONS);
  private readonly dialog = inject(MatDialog);

  /** True while a Gemini theme request is in flight (disables the button). */
  protected readonly aiTheming = signal(false);

  // Unique IDs so the <label for> bindings address the right inputs even if
  // multiple instances of this component ever live in the DOM together.
  private static instanceId = 0;
  private readonly id = ProfileComponent.instanceId++;
  protected readonly primaryInputId = `theme-primary-${this.id}`;
  protected readonly secondaryInputId = `theme-secondary-${this.id}`;
  protected readonly tertiaryInputId = `theme-tertiary-${this.id}`;

  protected readonly displayName = computed(
    () => this.userService.userDoc()?.displayName ?? '',
  );
  protected readonly email = computed(() => this.auth.user()?.email ?? '');
  /** Current user's uid — feeds the lifetime-totals card. */
  protected readonly uid = computed(() => this.auth.uid() ?? '');
  protected readonly isAdmin = this.userService.isAdmin;

  /** Opt in to browser/OS notifications — requests permission and, on grant,
   *  registers this device for push. */
  protected async enableNotifications(): Promise<void> {
    const result = await this.notifications.enable();
    const msg =
      result === 'granted'
        ? 'Notifications enabled'
        : result === 'denied'
          ? 'Blocked — enable notifications for this site in your browser settings'
          : result === 'unsupported'
            ? "This browser doesn't support notifications"
            : 'Notifications not enabled';
    this.snackBar.open(msg, undefined, { duration: 3000 });
  }

  /** Fire a test push to this user's registered devices (proves the pipeline). */
  protected async sendTestNotification(): Promise<void> {
    try {
      const call = httpsCallable<unknown, { sent: number; failed: number; devices: number }>(
        this.functions,
        'sendTestNotification',
      );
      const { data } = await call();
      this.snackBar.open(
        data.devices === 0
          ? 'No registered devices yet'
          : `Test sent to ${data.sent}/${data.devices} device(s)`,
        undefined,
        { duration: 3000 },
      );
    } catch (e: unknown) {
      this.snackBar.open(e instanceof Error ? e.message : 'Could not send test', 'Dismiss', {
        duration: 4000,
      });
    }
  }
  /** Show the "Dev tools" link when we're in a non-production build OR
   *  the user has the admin role. Matches the `devOrAdminGuard` on the
   *  `/dev` route so the link doesn't promise access we won't grant. */
  protected readonly showDev = computed(() => !environment.production || this.isAdmin());

  protected readonly variantOptions = this.themeService.variantOptions;
  protected readonly defaultPresetValue = PRESET_DEFAULT;
  protected readonly customPresetValue = PRESET_CUSTOM;

  protected readonly colors = this.themeService.colors;
  protected readonly colorMode = this.themeService.colorMode;
  protected readonly variant = this.themeService.variant;
  protected readonly contrast = this.themeService.contrast;
  protected readonly presetCode = this.themeService.presetCode;
  protected readonly presets = this.themeService.presets;

  /** The preset object currently matched by colours (or null if Custom). The
   *  trigger renders the crest/name straight off this. */
  protected readonly currentPreset = computed(() => {
    const code = this.presetCode();
    if (code === PRESET_CUSTOM) return null;
    return this.themeService.presetsById().get(code) ?? null;
  });

  protected readonly contrastLabel = computed(() => {
    const v = this.contrast();
    if (v <= -0.34) return 'Low';
    if (v >= 0.34) return 'High';
    return 'Standard';
  });

  /** Show the reset button only when the user has deviated from any default. */
  protected readonly showResetButton = computed(() => {
    if (this.presetCode() !== PRESET_DEFAULT) return true;
    if (this.variant() !== 'TONAL_SPOT') return true;
    if (this.contrast() !== 0) return true;
    return false;
  });

  protected applyPreset(code: PresetCode): void {
    this.themeService.applyPreset(code);
  }

  /**
   * Full theme randomizer — rolls the dice on every knob the picker
   * exposes: colors (primary / secondary / tertiary), Material variant
   * (style), contrast slider, and color mode (system/light/dark).
   *
   * Material 3's HCT palette generator takes raw seed colors and
   * derives the full tonal scale, so even un-vetted random hex values
   * produce a usable theme. The picker dropdown drops into PRESET_CUSTOM
   * since the resulting palette won't match any known preset.
   */
  protected randomizeTheme(): void {
    // Colors
    this.themeService.setColors({
      primary: randomHex(),
      secondary: randomHex(),
      tertiary: randomHex(),
    });

    // Variant (style) — uniform pick from the available HCT schemes.
    const variants = this.variantOptions;
    const variant = variants[Math.floor(Math.random() * variants.length)].value;
    this.themeService.setVariant(variant);

    // Contrast — full range [-1, 1]. Service clamps if we drift.
    this.themeService.setContrast(Math.random() * 2 - 1);

    // Color mode — system / light / dark with equal weight. 'system'
    // means "follow OS", which can produce a less visible change if the
    // OS preference already matches the most-recent mode — but the
    // user explicitly asked to include it.
    const modes: ColorMode[] = ['system', 'light', 'dark'];
    this.themeService.setColorMode(modes[Math.floor(Math.random() * modes.length)]);

    this.snackBar.open('Theme randomized', undefined, { duration: 1500 });
  }

  /**
   * AI theming — prompt for a vibe, hand it to Gemini, and apply the colours +
   * variant it returns the same way the randomizer does (setColors + setVariant,
   * contrast reset to neutral so the AI palette renders cleanly).
   */
  protected async themeWithAi(): Promise<void> {
    const ref = this.dialog.open(ThemePromptDialogComponent, { width: '360px' });
    const prompt = await firstValueFrom(ref.afterClosed());
    if (!prompt) return;

    this.aiTheming.set(true);
    try {
      const call = httpsCallable<
        { prompt: string },
        {
          primary: string;
          secondary: string;
          tertiary: string;
          variant: VariantName;
          contrast: number;
        }
      >(this.functions, 'generateTheme');
      const { data } = await call({ prompt });
      this.themeService.setColors({
        primary: data.primary,
        secondary: data.secondary,
        tertiary: data.tertiary,
      });
      if (data.variant) this.themeService.setVariant(data.variant);
      this.themeService.setContrast(data.contrast ?? 0);
      this.snackBar.open(`Themed: ${prompt}`, undefined, { duration: 2500 });
    } catch (e: unknown) {
      this.snackBar.open(
        e instanceof Error ? e.message : 'Could not generate a theme',
        'Dismiss',
        { duration: 4000 },
      );
    } finally {
      this.aiTheming.set(false);
    }
  }

  protected setPrimaryFromEvent(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.themeService.setPrimary(value);
  }
  protected setSecondaryFromEvent(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.themeService.setSecondary(value);
  }
  protected setTertiaryFromEvent(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.themeService.setTertiary(value);
  }

  protected setColorMode(mode: ColorMode): void {
    this.themeService.setColorMode(mode);
  }

  protected setVariant(variant: VariantName): void {
    this.themeService.setVariant(variant);
  }

  protected setContrast(contrast: number): void {
    this.themeService.setContrast(contrast);
  }

  protected resetTheme(): void {
    this.themeService.resetToDefaults();
  }

  protected modeLabel(mode: ColorMode): string {
    switch (mode) {
      case 'system': return 'System';
      case 'light': return 'Light';
      case 'dark': return 'Dark';
    }
  }

  protected modeIcon(mode: ColorMode): string {
    switch (mode) {
      case 'system': return 'brightness_auto';
      case 'light': return 'light_mode';
      case 'dark': return 'dark_mode';
    }
  }

  protected changeName(): void {
    void this.router.navigate(['/onboarding/display-name']);
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigate(['/login']);
  }
}

/**
 * Produce a random 6-digit hex color (e.g. '#a3f72c'). Pure random
 * across the full RGB space — Material's HCT palette generator
 * tolerates any seed and derives a coherent tonal scale from it, so
 * we don't constrain saturation or lightness here.
 */
function randomHex(): string {
  const n = Math.floor(Math.random() * 0x1_00_00_00);
  return '#' + n.toString(16).padStart(6, '0');
}
