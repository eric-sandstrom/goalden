import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatSliderModule } from '@angular/material/slider';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';
import {
  ColorMode,
  PRESET_CUSTOM,
  PRESET_DEFAULT,
  PresetCode,
  ThemeService,
  VariantName,
} from '../../core/services/theme.service';
import { UserService } from '../../core/services/user.service';

@Component({
  selector: 'app-profile',
  imports: [
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatSelectModule,
    MatSliderModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="profile">
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-card-title>{{ displayName() }}</mat-card-title>
          <mat-card-subtitle>{{ email() }}</mat-card-subtitle>
        </mat-card-header>
        <mat-card-actions>
          <button mat-button (click)="changeName()">
            <mat-icon>edit</mat-icon>
            Change display name
          </button>
          <button mat-button (click)="signOut()">
            <mat-icon>logout</mat-icon>
            Sign out
          </button>
        </mat-card-actions>
      </mat-card>

      <!-- ===================================================================
           Browse links
      ==================================================================== -->
      <mat-card appearance="outlined">
        <mat-card-actions>
          <a mat-button routerLink="/teams">
            <mat-icon>groups</mat-icon>
            Browse teams
          </a>
        </mat-card-actions>
      </mat-card>

      <!-- ===================================================================
           Theme picker
      ==================================================================== -->
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-icon matCardAvatar>palette</mat-icon>
          <mat-card-title>Theme</mat-card-title>
          <mat-card-subtitle>Paint the app in your team's colors</mat-card-subtitle>
        </mat-card-header>

        <mat-card-content>
          <!-- ---- Color mode ---- -->
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="full-field">
            <mat-label>Color mode</mat-label>
            <mat-select
              [value]="colorMode()"
              (selectionChange)="setColorMode($event.value)"
            >
              <mat-select-trigger>
                <span class="mode-trigger">
                  <mat-icon class="mode-trigger-icon" aria-hidden="true">
                    {{ modeIcon(colorMode()) }}
                  </mat-icon>
                  {{ modeLabel(colorMode()) }}
                </span>
              </mat-select-trigger>
              <mat-option value="system">
                <mat-icon aria-hidden="true">brightness_auto</mat-icon>
                System
              </mat-option>
              <mat-option value="light">
                <mat-icon aria-hidden="true">light_mode</mat-icon>
                Light
              </mat-option>
              <mat-option value="dark">
                <mat-icon aria-hidden="true">dark_mode</mat-icon>
                Dark
              </mat-option>
            </mat-select>
          </mat-form-field>

          <!-- ---- Preset ---- -->
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="full-field">
            <mat-label>Preset</mat-label>
            <mat-select
              [value]="presetCode()"
              (selectionChange)="applyPreset($event.value)"
            >
              <mat-select-trigger>
                <span class="palette-trigger">
                  @if (currentPreset(); as p) {
                    @if (p.crest) {
                      <img class="preset-crest" [src]="p.crest" [alt]="p.name + ' crest'" />
                    } @else {
                      <mat-icon class="preset-icon" aria-hidden="true">
                        {{ presetCode() === customPresetValue ? 'palette' : 'sports_soccer' }}
                      </mat-icon>
                    }
                    {{ p.name }}
                  } @else {
                    <mat-icon class="preset-icon" aria-hidden="true">palette</mat-icon>
                    Custom
                  }
                </span>
              </mat-select-trigger>

              @for (preset of presets(); track preset.id) {
                <mat-option [value]="preset.id">
                  @if (preset.crest) {
                    <img class="preset-crest" [src]="preset.crest" [alt]="preset.name + ' crest'" />
                  } @else {
                    <mat-icon class="preset-icon" aria-hidden="true">
                      {{ preset.id === defaultPresetValue ? 'sports_soccer' : 'shield' }}
                    </mat-icon>
                  }
                  {{ preset.name }}
                </mat-option>
              }
              <!-- 'Custom' is disabled so the user can't pick it from the
                   list — Custom is something you become by editing colours,
                   not something you select. The option only needs to exist
                   so mat-select has a matching value to highlight via the
                   trigger when presetCode() === 'custom'. -->
              <mat-option [value]="customPresetValue" disabled>
                <mat-icon class="preset-icon" aria-hidden="true">palette</mat-icon>
                Custom
              </mat-option>
            </mat-select>
          </mat-form-field>

          <!-- ---- Color pickers ---- -->
          <div class="color-pickers">
            <div class="color-row">
              <label class="color-meta" [for]="primaryInputId">
                <span class="color-name">Primary</span>
                <span class="color-hint">Buttons · accents · live now</span>
              </label>
              <div class="color-input-wrap">
                <input
                  type="color"
                  [id]="primaryInputId"
                  [value]="colors().primary"
                  (input)="setPrimaryFromEvent($event)"
                  class="color-input"
                  aria-label="Primary color"
                />
                <span class="color-hex">{{ colors().primary }}</span>
              </div>
            </div>

            <div class="color-row">
              <label class="color-meta" [for]="secondaryInputId">
                <span class="color-name">Secondary</span>
                <span class="color-hint">Subtle accents · chips</span>
              </label>
              <div class="color-input-wrap">
                <input
                  type="color"
                  [id]="secondaryInputId"
                  [value]="colors().secondary"
                  (input)="setSecondaryFromEvent($event)"
                  class="color-input"
                  aria-label="Secondary color"
                />
                <span class="color-hex">{{ colors().secondary }}</span>
              </div>
            </div>

            <div class="color-row">
              <label class="color-meta" [for]="tertiaryInputId">
                <span class="color-name">Tertiary</span>
                <span class="color-hint">Highlights · warnings · podium</span>
              </label>
              <div class="color-input-wrap">
                <input
                  type="color"
                  [id]="tertiaryInputId"
                  [value]="colors().tertiary"
                  (input)="setTertiaryFromEvent($event)"
                  class="color-input"
                  aria-label="Tertiary color"
                />
                <span class="color-hex">{{ colors().tertiary }}</span>
              </div>
            </div>
          </div>

          <!-- ---- Style + contrast ---- -->
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="full-field">
            <mat-label>Style</mat-label>
            <mat-select [value]="variant()" (selectionChange)="setVariant($event.value)">
              @for (option of variantOptions; track option.value) {
                <mat-option [value]="option.value">{{ option.label }}</mat-option>
              }
            </mat-select>
          </mat-form-field>

          <div class="slider-field">
            <div class="slider-head">
              <span class="slider-label">Contrast</span>
              <span class="slider-value">{{ contrastLabel() }}</span>
            </div>
            <mat-slider min="-1" max="1" step="0.1" discrete showTickMarks>
              <input
                matSliderThumb
                [value]="contrast()"
                (valueChange)="setContrast($event)"
                aria-label="Contrast level"
              />
            </mat-slider>
            <div class="slider-scale" aria-hidden="true">
              <span>Low</span>
              <span>Standard</span>
              <span>High</span>
            </div>
          </div>

          <!-- ---- Preview ---- -->
          <div class="preview" aria-label="Theme preview">
            <h4 class="preview-title">Live preview</h4>
            <p class="preview-blurb">
              Each row uses the corresponding color tokens. Edit any picker above and
              watch the matching row update.
            </p>

            <div class="preview-block">
              <span class="preview-tag">Primary</span>
              <div class="preview-items">
                <button type="button" mat-flat-button class="preview-btn primary-btn">Action</button>
                <span class="preview-swatch primary-bg"></span>
                <span class="preview-swatch primary-container-bg">
                  <span class="preview-on">Aa</span>
                </span>
              </div>
            </div>

            <div class="preview-block">
              <span class="preview-tag">Secondary</span>
              <div class="preview-items">
                <span class="preview-swatch secondary-bg"></span>
                <span class="preview-swatch secondary-container-bg">
                  <span class="preview-on">Aa</span>
                </span>
                <mat-chip-set>
                  <mat-chip class="preview-secondary-chip">Selected</mat-chip>
                </mat-chip-set>
              </div>
            </div>

            <div class="preview-block">
              <span class="preview-tag">Tertiary</span>
              <div class="preview-items">
                <button type="button" mat-flat-button class="preview-btn tertiary-btn">
                  Highlight
                </button>
                <span class="preview-swatch tertiary-bg"></span>
                <span class="preview-swatch tertiary-container-bg">
                  <span class="preview-on">Aa</span>
                </span>
              </div>
            </div>

            <div class="preview-block">
              <span class="preview-tag">Surfaces</span>
              <div class="preview-items">
                <span class="preview-swatch surface-lowest"></span>
                <span class="preview-swatch surface-low"></span>
                <span class="preview-swatch surface"></span>
                <span class="preview-swatch surface-high"></span>
                <span class="preview-swatch surface-highest"></span>
              </div>
            </div>

            <div class="preview-block">
              <span class="preview-tag">Outline</span>
              <div class="preview-items">
                <span class="preview-swatch outline-swatch"></span>
                <span class="preview-swatch outline-variant-swatch"></span>
                <span class="preview-text on-surface">On-surface</span>
                <span class="preview-text on-surface-variant">On-surface-variant</span>
              </div>
            </div>
          </div>

          @if (showResetButton()) {
            <div class="reset-row">
              <button type="button" mat-stroked-button (click)="resetTheme()">
                <mat-icon>restart_alt</mat-icon>
                Reset to defaults
              </button>
            </div>
          }
        </mat-card-content>
      </mat-card>

      @if (showDev) {
        <mat-card appearance="outlined">
          <mat-card-header>
            <mat-icon matCardAvatar class="dev">science</mat-icon>
            <mat-card-title>Developer</mat-card-title>
            <mat-card-subtitle>Local-only tools</mat-card-subtitle>
          </mat-card-header>
          <mat-card-actions>
            <a mat-button routerLink="/dev">
              <mat-icon>build</mat-icon>
              Dev tools
            </a>
          </mat-card-actions>
        </mat-card>
      }
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      width: 100%;
    }
    .profile {
      padding: 1.5rem 1rem;
      max-width: 560px;
      width: 100%;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      overflow-y: auto;
      overscroll-behavior: contain;
      box-sizing: border-box;
    }
    mat-card-actions {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      padding: 0.5rem 1rem 1rem;
      gap: 0.25rem;
    }
    mat-card-actions button,
    mat-card-actions a[mat-button] {
      justify-content: flex-start;
    }
    .dev { color: var(--mat-sys-tertiary); }

    /* ---- Theme card layout ---- */
    .full-field { width: 100%; }
    mat-card-content {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      /* mat-card-header sits flush; without breathing room the first form
         field collides with the subtitle. */
      padding-top: 0.75rem;
    }

    .mode-trigger,
    .palette-trigger {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }
    .mode-trigger-icon {
      width: 18px;
      height: 18px;
      font-size: 18px;
      line-height: 18px;
    }
    mat-option mat-icon {
      margin-right: 0.5rem;
    }
    /* Crest images + fallback icons inside the preset select. The select
       options use Material's row layout (icon + label) so we mimic that
       sizing for the crest <img>. */
    .preset-crest {
      width: 22px;
      height: 22px;
      object-fit: contain;
      margin-right: 0.5rem;
      flex-shrink: 0;
    }
    .preset-icon {
      width: 20px;
      height: 20px;
      font-size: 20px;
      line-height: 20px;
      color: var(--mat-sys-on-surface-variant);
    }
    /* The trigger crest sits inside .palette-trigger flex, the option crest
       needs to align with mat-option's grid — same dimensions either way. */
    mat-option .preset-crest { margin-right: 0; }
    mat-option .preset-icon { margin-right: 0.5rem; }

    /* ---- Color pickers ---- */
    .color-pickers {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.5rem;
      background: var(--mat-sys-surface-container-low);
      border-radius: 12px;
      border: 1px solid var(--mat-sys-outline-variant);
    }
    .color-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.5rem 0.5rem;
    }
    .color-meta {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      min-width: 0;
      cursor: pointer;
    }
    .color-name {
      font-weight: 600;
      font-size: 0.95rem;
      color: var(--mat-sys-on-surface);
    }
    .color-hint {
      font-size: 0.78rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .color-input-wrap {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
    }
    /* Strip the native chrome off <input type="color"> and turn it into a
       tappable swatch. Different browsers paint it differently; the rules
       below cover Chromium, Firefox, and Safari. */
    .color-input {
      appearance: none;
      -webkit-appearance: none;
      width: 40px;
      height: 40px;
      border: 2px solid var(--mat-sys-outline-variant);
      border-radius: 50%;
      background: transparent;
      cursor: pointer;
      padding: 0;
      overflow: hidden;
      transition: border-color 120ms ease, transform 120ms ease;
    }
    .color-input:hover {
      border-color: var(--mat-sys-outline);
    }
    .color-input:active { transform: scale(0.94); }
    .color-input::-webkit-color-swatch-wrapper { padding: 0; }
    .color-input::-webkit-color-swatch {
      border: none;
      border-radius: 50%;
    }
    .color-input::-moz-color-swatch {
      border: none;
      border-radius: 50%;
    }
    .color-hex {
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 0.8rem;
      color: var(--mat-sys-on-surface-variant);
      letter-spacing: 0.02em;
      min-width: 6ch;
    }

    /* ---- Contrast slider ---- */
    .slider-field {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      padding: 0.25rem 0;
    }
    .slider-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .slider-label { font-size: 0.9rem; color: var(--mat-sys-on-surface); }
    .slider-value {
      font-size: 0.8rem;
      color: var(--mat-sys-on-surface-variant);
      font-variant-numeric: tabular-nums;
    }
    .slider-field mat-slider { width: 100%; }
    .slider-scale {
      display: flex;
      justify-content: space-between;
      font-size: 0.72rem;
      color: var(--mat-sys-on-surface-variant);
      padding: 0 0.25rem;
    }

    /* ---- Preview ---- */
    .preview {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.875rem;
      background: var(--mat-sys-surface-container-low);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
    }
    .preview-title {
      margin: 0;
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface);
    }
    .preview-blurb {
      margin: 0 0 0.25rem;
      font-size: 0.78rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .preview-block {
      display: grid;
      grid-template-columns: 80px 1fr;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }
    .preview-block:first-of-type { border-top: none; }
    .preview-tag {
      font-size: 0.75rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--mat-sys-on-surface-variant);
      font-weight: 600;
    }
    .preview-items {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
    }
    .preview-btn {
      min-width: 0;
      padding: 0 0.875rem;
      height: 32px;
      font-size: 0.85rem;
    }
    /* Override mat-flat-button colours so we can show tertiary variants
       without fighting Material's color input API in v20. */
    .preview-btn.primary-btn {
      background-color: var(--mat-sys-primary);
      color: var(--mat-sys-on-primary);
    }
    .preview-btn.tertiary-btn {
      background-color: var(--mat-sys-tertiary);
      color: var(--mat-sys-on-tertiary);
    }
    .preview-swatch {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      border: 1px solid var(--mat-sys-outline-variant);
    }
    .preview-on {
      font-size: 0.75rem;
      font-weight: 600;
    }
    /* Each swatch maps to a single system token. The on-X color of each
       container variant is rendered as 'Aa' inside so the user can see
       the text/background relationship at a glance. */
    .primary-bg { background: var(--mat-sys-primary); }
    .primary-container-bg {
      background: var(--mat-sys-primary-container);
    }
    .primary-container-bg .preview-on { color: var(--mat-sys-on-primary-container); }
    .secondary-bg { background: var(--mat-sys-secondary); }
    .secondary-container-bg { background: var(--mat-sys-secondary-container); }
    .secondary-container-bg .preview-on { color: var(--mat-sys-on-secondary-container); }
    .tertiary-bg { background: var(--mat-sys-tertiary); }
    .tertiary-container-bg { background: var(--mat-sys-tertiary-container); }
    .tertiary-container-bg .preview-on { color: var(--mat-sys-on-tertiary-container); }
    .surface-lowest { background: var(--mat-sys-surface-container-lowest); }
    .surface-low { background: var(--mat-sys-surface-container-low); }
    .surface { background: var(--mat-sys-surface-container); }
    .surface-high { background: var(--mat-sys-surface-container-high); }
    .surface-highest { background: var(--mat-sys-surface-container-highest); }
    .outline-swatch {
      background: transparent;
      border-color: var(--mat-sys-outline);
      border-width: 2px;
    }
    .outline-variant-swatch {
      background: transparent;
      border-color: var(--mat-sys-outline-variant);
      border-width: 2px;
    }
    .preview-text {
      font-size: 0.8rem;
      font-weight: 500;
    }
    .preview-text.on-surface { color: var(--mat-sys-on-surface); }
    .preview-text.on-surface-variant { color: var(--mat-sys-on-surface-variant); }
    /* The secondary-themed chip is a simple way to surface secondary-container
       in something that looks like a real app element. */
    .preview-secondary-chip {
      background-color: var(--mat-sys-secondary-container) !important;
      color: var(--mat-sys-on-secondary-container) !important;
    }

    .reset-row {
      display: flex;
      justify-content: flex-end;
      padding-top: 0.25rem;
    }
  `,
})
export class ProfileComponent {
  private readonly auth = inject(AuthService);
  private readonly userService = inject(UserService);
  private readonly themeService = inject(ThemeService);
  private readonly router = inject(Router);

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
  protected readonly showDev = !environment.production;

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
