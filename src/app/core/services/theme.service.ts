import { Injectable, Signal, computed, effect, inject, signal } from '@angular/core';
import {
  DynamicScheme,
  Hct,
  TonalPalette,
  Variant,
  argbFromHex,
  hexFromArgb,
} from '@material/material-color-utilities';
import { Team } from '../models/team.model';
import { TEAM_THEME_OVERRIDES, findThemeOverride } from '../models/team-themes';
import { TeamsService } from './teams.service';

export type ColorMode = 'system' | 'light' | 'dark';

export type VariantName =
  | 'TONAL_SPOT'
  | 'VIBRANT'
  | 'EXPRESSIVE'
  | 'FIDELITY'
  | 'CONTENT'
  | 'MONOCHROME'
  | 'NEUTRAL'
  | 'RAINBOW'
  | 'FRUIT_SALAD';

export interface ThemeColors {
  readonly primary: string;
  readonly secondary: string;
  readonly tertiary: string;
}

/** A theme preset surfaced in the picker. Combines a team's display metadata
 *  (crest, name) with a colour palette pulled from TEAM_THEME_OVERRIDES. */
export interface ThemePreset {
  readonly id: string; // 'default' or a team Firestore doc id ("fd-759")
  readonly name: string;
  readonly crest: string | null;
  readonly colors: ThemeColors;
}

export type PresetCode = string; // 'default' | 'custom' | team doc id

export const PRESET_DEFAULT: PresetCode = 'default';
export const PRESET_CUSTOM: PresetCode = 'custom';

export const VARIANT_OPTIONS: ReadonlyArray<{ readonly value: VariantName; readonly label: string }> = [
  { value: 'TONAL_SPOT', label: 'Tonal spot (default)' },
  { value: 'VIBRANT', label: 'Vibrant' },
  { value: 'EXPRESSIVE', label: 'Expressive' },
  { value: 'FIDELITY', label: 'Fidelity' },
  { value: 'CONTENT', label: 'Content' },
  { value: 'MONOCHROME', label: 'Monochrome' },
  { value: 'NEUTRAL', label: 'Neutral' },
  { value: 'RAINBOW', label: 'Rainbow' },
  { value: 'FRUIT_SALAD', label: 'Fruit salad' },
];

const COLORS_STORAGE_KEY = 'goalden:colors';
const LEGACY_CHOICE_STORAGE_KEY = 'goalden:theme';
const COLOR_MODE_STORAGE_KEY = 'goalden:color-mode';
const VARIANT_STORAGE_KEY = 'goalden:theme-variant';
const CONTRAST_STORAGE_KEY = 'goalden:theme-contrast';
const STYLE_ELEMENT_ID = 'goalden-country-theme';

const DEFAULT_COLOR_MODE: ColorMode = 'system';
const DEFAULT_VARIANT: VariantName = 'TONAL_SPOT';
const DEFAULT_CONTRAST = 0;

const GOALDEN_PRIMARY = '#0F7B3A';
const GOALDEN_TERTIARY = '#D4A017';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly teamsService = inject(TeamsService);

  private readonly _colors = signal<ThemeColors>(this.loadColorsFromStorage());
  private readonly _colorMode = signal<ColorMode>(this.loadColorModeFromStorage());
  private readonly _variant = signal<VariantName>(this.loadVariantFromStorage());
  private readonly _contrast = signal<number>(this.loadContrastFromStorage());

  readonly colors: Signal<ThemeColors> = this._colors.asReadonly();
  readonly colorMode: Signal<ColorMode> = this._colorMode.asReadonly();
  readonly variant: Signal<VariantName> = this._variant.asReadonly();
  readonly contrast: Signal<number> = this._contrast.asReadonly();

  readonly variantOptions = VARIANT_OPTIONS;
  readonly defaultColors: ThemeColors = canonicalColors({
    primary: GOALDEN_PRIMARY,
    tertiary: GOALDEN_TERTIARY,
  });

  /** Always-present default preset that doesn't depend on the teams collection. */
  readonly defaultPreset: ThemePreset = {
    id: PRESET_DEFAULT,
    name: 'Goalden (default)',
    crest: null,
    colors: this.defaultColors,
  };

  /**
   * Theme presets exposed to the picker. Joins the live teams collection
   * (which provides crests, full names, and doc ids) with the curated
   * TEAM_THEME_OVERRIDES table (which provides colours we trust, since
   * football-data's `clubColors` field is unreliable).
   *
   * Teams without a hand-picked colour override are skipped — the picker
   * stays focused on teams we have a designed palette for.
   *
   * Always includes the Goalden default first.
   */
  readonly presets = computed<readonly ThemePreset[]>(() => {
    const teams = this.teamsService.teams();
    const result: ThemePreset[] = [this.defaultPreset];
    // Index teams by lowercased name for quick lookup against override entries.
    const teamsByName = new Map<string, Team>();
    for (const t of teams) {
      teamsByName.set(t.name.trim().toLowerCase(), t);
    }
    for (const override of TEAM_THEME_OVERRIDES) {
      let matchedTeam: Team | null = null;
      for (const candidate of override.matchNames) {
        const found = teamsByName.get(candidate.toLowerCase());
        if (found) {
          matchedTeam = found;
          break;
        }
      }
      // Surface the preset even when the team hasn't loaded yet — falls back
      // to using the first matchName as the display label and no crest, so
      // the picker isn't empty pre-pollTeams.
      if (matchedTeam) {
        result.push({
          id: matchedTeam.id,
          name: matchedTeam.name,
          crest: matchedTeam.crest,
          colors: canonicalColors(override),
        });
      } else {
        result.push({
          id: `name:${override.matchNames[0]}`,
          name: override.matchNames[0],
          crest: null,
          colors: canonicalColors(override),
        });
      }
    }
    return result;
  });

  /** Map preset id → preset for cheap lookup from the picker. */
  readonly presetsById = computed<ReadonlyMap<string, ThemePreset>>(() => {
    const m = new Map<string, ThemePreset>();
    for (const p of this.presets()) m.set(p.id, p);
    return m;
  });

  /** Resolved preset code derived from current colours. */
  readonly presetCode = computed<PresetCode>(() => {
    const c = this._colors();
    for (const p of this.presets()) {
      if (colorsEqual(c, p.colors)) return p.id;
    }
    return PRESET_CUSTOM;
  });

  constructor() {
    effect(() => {
      this.applyToDOM(this._colors(), this._variant(), this._contrast());
    });
    effect(() => {
      this.applyColorModeToDOM(this._colorMode());
    });
  }

  // ---------------------------------------------------------------------------
  // Mutators
  // ---------------------------------------------------------------------------

  setColors(colors: ThemeColors): void {
    const normalized = {
      primary: normalizeHex(colors.primary),
      secondary: normalizeHex(colors.secondary),
      tertiary: normalizeHex(colors.tertiary),
    };
    this._colors.set(normalized);
    this.persistColors(normalized);
  }

  setPrimary(hex: string): void {
    this.setColors({ ...this._colors(), primary: hex });
  }
  setSecondary(hex: string): void {
    this.setColors({ ...this._colors(), secondary: hex });
  }
  setTertiary(hex: string): void {
    this.setColors({ ...this._colors(), tertiary: hex });
  }

  applyPreset(code: PresetCode): void {
    const preset = this.presetsById().get(code);
    if (preset) this.setColors(preset.colors);
  }

  setColorMode(mode: ColorMode): void {
    if (mode !== 'system' && mode !== 'light' && mode !== 'dark') return;
    this._colorMode.set(mode);
    this.persistColorMode(mode);
  }

  setVariant(variant: VariantName): void {
    if (!VARIANT_OPTIONS.some((v) => v.value === variant)) return;
    this._variant.set(variant);
    this.persistVariant(variant);
  }

  setContrast(contrast: number): void {
    if (!Number.isFinite(contrast)) return;
    const clamped = Math.max(-1, Math.min(1, contrast));
    this._contrast.set(clamped);
    this.persistContrast(clamped);
  }

  resetToDefaults(): void {
    this.setColors(this.defaultColors);
    this.setVariant(DEFAULT_VARIANT);
    this.setContrast(DEFAULT_CONTRAST);
  }

  // ---------------------------------------------------------------------------
  // DOM application
  // ---------------------------------------------------------------------------

  private needsOverride(colors: ThemeColors, variant: VariantName, contrast: number): boolean {
    if (!colorsEqual(colors, this.defaultColors)) return true;
    if (variant !== DEFAULT_VARIANT) return true;
    if (contrast !== DEFAULT_CONTRAST) return true;
    return false;
  }

  private applyToDOM(colors: ThemeColors, variant: VariantName, contrast: number): void {
    if (typeof document === 'undefined') return;

    if (!this.needsOverride(colors, variant, contrast)) {
      document.getElementById(STYLE_ELEMENT_ID)?.remove();
      return;
    }

    const variantEnum = VARIANT_ENUM_MAP[variant];
    const lightScheme = buildScheme(colors, variantEnum, contrast, false);
    const darkScheme = buildScheme(colors, variantEnum, contrast, true);
    const css = renderCss(tokensFromScheme(lightScheme), tokensFromScheme(darkScheme));

    let el = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ELEMENT_ID;
      document.head.appendChild(el);
    }
    el.textContent = css;
  }

  private applyColorModeToDOM(mode: ColorMode): void {
    if (typeof document === 'undefined') return;
    const value =
      mode === 'system' ? 'light dark' : mode === 'light' ? 'only light' : 'only dark';
    document.documentElement.style.colorScheme = value;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private loadColorsFromStorage(): ThemeColors {
    if (typeof localStorage === 'undefined') return this.computeDefaults();

    const raw = localStorage.getItem(COLORS_STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<ThemeColors>;
        if (
          typeof parsed.primary === 'string' &&
          typeof parsed.secondary === 'string' &&
          typeof parsed.tertiary === 'string'
        ) {
          return {
            primary: normalizeHex(parsed.primary),
            secondary: normalizeHex(parsed.secondary),
            tertiary: normalizeHex(parsed.tertiary),
          };
        }
      } catch {
        // Fall through to legacy migration.
      }
    }

    // Legacy migration: previous format was a ThemeChoice union with country
    // codes like { kind: 'country', code: 'BR' }. Convert to the new colour
    // triple via the team-themes override table (still keyed by the same
    // country names we used to ship).
    const legacy = localStorage.getItem(LEGACY_CHOICE_STORAGE_KEY);
    if (legacy) {
      try {
        const parsed = JSON.parse(legacy) as { kind?: string; code?: string };
        if (parsed.kind === 'country' && typeof parsed.code === 'string') {
          // Old codes were ISO 3166 alpha-2 (BR, AR, etc.). The team-themes
          // table indexes by team name. We have to fall back to the in-mem
          // mapping that the old country-themes file held.
          const colorsForLegacyCode = LEGACY_COUNTRY_CODE_TO_NAME[parsed.code];
          if (colorsForLegacyCode) {
            const override = findThemeOverride(colorsForLegacyCode);
            if (override) {
              const migrated = canonicalColors(override);
              this.persistColors(migrated);
              return migrated;
            }
          }
        }
      } catch {
        // Malformed — fall through to default.
      }
    }

    return this.computeDefaults();
  }

  private computeDefaults(): ThemeColors {
    return canonicalColors({ primary: GOALDEN_PRIMARY, tertiary: GOALDEN_TERTIARY });
  }

  private persistColors(colors: ThemeColors): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(COLORS_STORAGE_KEY, JSON.stringify(colors));
    } catch {
      // Quota / privacy mode — silently ignore.
    }
  }

  private loadColorModeFromStorage(): ColorMode {
    if (typeof localStorage === 'undefined') return DEFAULT_COLOR_MODE;
    const raw = localStorage.getItem(COLOR_MODE_STORAGE_KEY);
    if (raw === 'system' || raw === 'light' || raw === 'dark') return raw;
    return DEFAULT_COLOR_MODE;
  }

  private persistColorMode(mode: ColorMode): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(COLOR_MODE_STORAGE_KEY, mode);
    } catch {
      // Quota / privacy mode — silently ignore.
    }
  }

  private loadVariantFromStorage(): VariantName {
    if (typeof localStorage === 'undefined') return DEFAULT_VARIANT;
    const raw = localStorage.getItem(VARIANT_STORAGE_KEY);
    if (raw && VARIANT_OPTIONS.some((v) => v.value === raw)) return raw as VariantName;
    return DEFAULT_VARIANT;
  }

  private persistVariant(variant: VariantName): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(VARIANT_STORAGE_KEY, variant);
    } catch {
      // Quota / privacy mode — silently ignore.
    }
  }

  private loadContrastFromStorage(): number {
    if (typeof localStorage === 'undefined') return DEFAULT_CONTRAST;
    const raw = localStorage.getItem(CONTRAST_STORAGE_KEY);
    if (raw === null) return DEFAULT_CONTRAST;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_CONTRAST;
    return Math.max(-1, Math.min(1, parsed));
  }

  private persistContrast(contrast: number): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(CONTRAST_STORAGE_KEY, String(contrast));
    } catch {
      // Quota / privacy mode — silently ignore.
    }
  }
}

// =============================================================================
// Legacy migration table
// =============================================================================

/** Maps the old ISO 3166 country codes (used in the pre-refactor
 *  ThemeChoice format) to the team name we use as the team-themes key.
 *  Allows existing localStorage entries to migrate cleanly. */
const LEGACY_COUNTRY_CODE_TO_NAME: Record<string, string> = {
  AR: 'Argentina',
  AT: 'Austria',
  AU: 'Australia',
  BE: 'Belgium',
  BR: 'Brazil',
  CA: 'Canada',
  CH: 'Switzerland',
  CL: 'Chile',
  CO: 'Colombia',
  CZ: 'Czechia',
  DE: 'Germany',
  DK: 'Denmark',
  EN: 'England',
  ES: 'Spain',
  FR: 'France',
  HR: 'Croatia',
  IT: 'Italy',
  JP: 'Japan',
  KR: 'South Korea',
  MA: 'Morocco',
  MX: 'Mexico',
  NG: 'Nigeria',
  NL: 'Netherlands',
  NO: 'Norway',
  PL: 'Poland',
  PT: 'Portugal',
  SE: 'Sweden',
  SN: 'Senegal',
  UA: 'Ukraine',
  US: 'USA',
  UY: 'Uruguay',
};

// =============================================================================
// Material 3 scheme construction
// =============================================================================

const VARIANT_ENUM_MAP: Record<VariantName, Variant> = {
  TONAL_SPOT: Variant.TONAL_SPOT,
  VIBRANT: Variant.VIBRANT,
  EXPRESSIVE: Variant.EXPRESSIVE,
  FIDELITY: Variant.FIDELITY,
  CONTENT: Variant.CONTENT,
  MONOCHROME: Variant.MONOCHROME,
  NEUTRAL: Variant.NEUTRAL,
  RAINBOW: Variant.RAINBOW,
  FRUIT_SALAD: Variant.FRUIT_SALAD,
};

function buildScheme(
  colors: ThemeColors,
  variant: Variant,
  contrastLevel: number,
  isDark: boolean,
): DynamicScheme {
  const primaryHct = Hct.fromInt(argbFromHex(colors.primary));
  const secondaryHct = Hct.fromInt(argbFromHex(colors.secondary));
  const tertiaryHct = Hct.fromInt(argbFromHex(colors.tertiary));

  return new DynamicScheme({
    sourceColorHct: primaryHct,
    variant,
    contrastLevel,
    isDark,
    primaryPalette: TonalPalette.fromHct(primaryHct),
    secondaryPalette: TonalPalette.fromHct(secondaryHct),
    tertiaryPalette: TonalPalette.fromHct(tertiaryHct),
  });
}

function tokensFromScheme(scheme: DynamicScheme): Record<string, string> {
  const hex = (argb: number) => hexFromArgb(argb).slice(0, 7);
  return {
    '--mat-sys-primary': hex(scheme.primary),
    '--mat-sys-on-primary': hex(scheme.onPrimary),
    '--mat-sys-primary-container': hex(scheme.primaryContainer),
    '--mat-sys-on-primary-container': hex(scheme.onPrimaryContainer),
    '--mat-sys-primary-fixed': hex(scheme.primaryFixed),
    '--mat-sys-primary-fixed-dim': hex(scheme.primaryFixedDim),
    '--mat-sys-on-primary-fixed': hex(scheme.onPrimaryFixed),
    '--mat-sys-on-primary-fixed-variant': hex(scheme.onPrimaryFixedVariant),
    '--mat-sys-inverse-primary': hex(scheme.inversePrimary),
    '--mat-sys-secondary': hex(scheme.secondary),
    '--mat-sys-on-secondary': hex(scheme.onSecondary),
    '--mat-sys-secondary-container': hex(scheme.secondaryContainer),
    '--mat-sys-on-secondary-container': hex(scheme.onSecondaryContainer),
    '--mat-sys-secondary-fixed': hex(scheme.secondaryFixed),
    '--mat-sys-secondary-fixed-dim': hex(scheme.secondaryFixedDim),
    '--mat-sys-on-secondary-fixed': hex(scheme.onSecondaryFixed),
    '--mat-sys-on-secondary-fixed-variant': hex(scheme.onSecondaryFixedVariant),
    '--mat-sys-tertiary': hex(scheme.tertiary),
    '--mat-sys-on-tertiary': hex(scheme.onTertiary),
    '--mat-sys-tertiary-container': hex(scheme.tertiaryContainer),
    '--mat-sys-on-tertiary-container': hex(scheme.onTertiaryContainer),
    '--mat-sys-tertiary-fixed': hex(scheme.tertiaryFixed),
    '--mat-sys-tertiary-fixed-dim': hex(scheme.tertiaryFixedDim),
    '--mat-sys-on-tertiary-fixed': hex(scheme.onTertiaryFixed),
    '--mat-sys-on-tertiary-fixed-variant': hex(scheme.onTertiaryFixedVariant),
    '--mat-sys-error': hex(scheme.error),
    '--mat-sys-on-error': hex(scheme.onError),
    '--mat-sys-error-container': hex(scheme.errorContainer),
    '--mat-sys-on-error-container': hex(scheme.onErrorContainer),
    '--mat-sys-background': hex(scheme.background),
    '--mat-sys-on-background': hex(scheme.onBackground),
    '--mat-sys-surface': hex(scheme.surface),
    '--mat-sys-on-surface': hex(scheme.onSurface),
    '--mat-sys-surface-variant': hex(scheme.surfaceVariant),
    '--mat-sys-on-surface-variant': hex(scheme.onSurfaceVariant),
    '--mat-sys-surface-dim': hex(scheme.surfaceDim),
    '--mat-sys-surface-bright': hex(scheme.surfaceBright),
    '--mat-sys-surface-container-lowest': hex(scheme.surfaceContainerLowest),
    '--mat-sys-surface-container-low': hex(scheme.surfaceContainerLow),
    '--mat-sys-surface-container': hex(scheme.surfaceContainer),
    '--mat-sys-surface-container-high': hex(scheme.surfaceContainerHigh),
    '--mat-sys-surface-container-highest': hex(scheme.surfaceContainerHighest),
    '--mat-sys-surface-tint': hex(scheme.surfaceTint),
    '--mat-sys-inverse-surface': hex(scheme.inverseSurface),
    '--mat-sys-inverse-on-surface': hex(scheme.inverseOnSurface),
    '--mat-sys-outline': hex(scheme.outline),
    '--mat-sys-outline-variant': hex(scheme.outlineVariant),
    '--mat-sys-shadow': hex(scheme.shadow),
    '--mat-sys-scrim': hex(scheme.scrim),
  };
}

function renderCss(
  light: Record<string, string>,
  dark: Record<string, string>,
): string {
  const lines = Object.keys(light)
    .map((key) => `  ${key}: light-dark(${light[key]}, ${dark[key]});`)
    .join('\n');
  return `:root {\n${lines}\n}`;
}

// =============================================================================
// Colour helpers
// =============================================================================

function canonicalColors(input: {
  primary: string;
  secondary?: string;
  tertiary: string;
}): ThemeColors {
  return {
    primary: normalizeHex(input.primary),
    secondary: normalizeHex(input.secondary ?? deriveCanonicalSecondary(input.primary)),
    tertiary: normalizeHex(input.tertiary),
  };
}

function deriveCanonicalSecondary(primaryHex: string): string {
  const primaryHct = Hct.fromInt(argbFromHex(primaryHex));
  const scheme = new DynamicScheme({
    sourceColorHct: primaryHct,
    variant: Variant.TONAL_SPOT,
    contrastLevel: 0,
    isDark: false,
    primaryPalette: TonalPalette.fromHct(primaryHct),
  });
  return hexFromArgb(scheme.secondaryPaletteKeyColor).slice(0, 7);
}

function normalizeHex(hex: string): string {
  const trimmed = hex.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return withHash.toUpperCase();
}

function colorsEqual(a: ThemeColors, b: ThemeColors): boolean {
  return a.primary === b.primary && a.secondary === b.secondary && a.tertiary === b.tertiary;
}
