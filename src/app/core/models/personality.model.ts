import { Timestamp } from 'firebase/firestore';

/**
 * Predictor-personality archetypes. Mirrors
 * `functions/src/lib/personality.ts` so the client can render the same
 * enum the server writes.
 *
 * If you add or rename an archetype here, update the server file too —
 * they're a coordinated pair. Compile-time check below ensures the enum
 * shape matches what the generator returns.
 */
export const ARCHETYPES = [
  'AGAINST_ALL_ODDS',
  'THE_STATISTICIAN',
  'HOME_SWEET_HOME',
  'GOAL_RUSH',
  'THE_WALL',
  'DRAW_DEALER',
  'CHAOS_GOBLIN',
  'HOMETOWN_HERO',
  'SNIPER',
  'LATE_BLOOMER',
] as const;

export type Archetype = typeof ARCHETYPES[number];

export function isArchetype(value: unknown): value is Archetype {
  return typeof value === 'string' && (ARCHETYPES as readonly string[]).includes(value);
}

/** Presentation metadata for an archetype — icon + tagline + accent
 *  semantic colour. Used by `PredictorPersonalityCardComponent` to render
 *  any archetype consistently regardless of who picked it. */
export interface ArchetypePresentation {
  readonly name: string;
  readonly emoji: string;
  readonly icon: string;
  readonly tagline: string;
  /** A `--mat-sys-*` token for the chip background tint. */
  readonly tintToken: string;
}

export const ARCHETYPE_PRESENTATION: Readonly<Record<Archetype, ArchetypePresentation>> = {
  AGAINST_ALL_ODDS: {
    name: 'Against All Odds',
    emoji: '🎲',
    icon: 'casino',
    tagline: 'You love a Cinderella story.',
    tintToken: '--mat-sys-tertiary',
  },
  THE_STATISTICIAN: {
    name: 'The Statistician',
    emoji: '📐',
    icon: 'analytics',
    tagline: 'The bookies and you tend to agree.',
    tintToken: '--mat-sys-primary',
  },
  HOME_SWEET_HOME: {
    name: 'Home Sweet Home',
    emoji: '🏠',
    icon: 'home',
    tagline: 'The home crowd lifts your picks.',
    tintToken: '--mat-sys-secondary',
  },
  GOAL_RUSH: {
    name: 'Goal Rush',
    emoji: '⚽',
    icon: 'sports_soccer',
    tagline: 'Strikers, not defenders, write your tickets.',
    tintToken: '--mat-sys-error',
  },
  THE_WALL: {
    name: 'The Wall',
    emoji: '🧱',
    icon: 'shield',
    tagline: 'Clean sheets and 1-0 grinders.',
    tintToken: '--mat-sys-outline',
  },
  DRAW_DEALER: {
    name: 'Draw Dealer',
    emoji: '🤝',
    icon: 'handshake',
    tagline: 'You see deadlocks where others see winners.',
    tintToken: '--mat-sys-secondary',
  },
  CHAOS_GOBLIN: {
    name: 'Chaos Goblin',
    emoji: '🌪️',
    icon: 'tornado',
    tagline: 'No two picks alike.',
    tintToken: '--mat-sys-error',
  },
  HOMETOWN_HERO: {
    name: 'Hometown Hero',
    emoji: '🦁',
    icon: 'workspace_premium',
    tagline: 'One team. Always backed.',
    tintToken: '--mat-sys-tertiary',
  },
  SNIPER: {
    name: 'Sniper',
    emoji: '🎯',
    icon: 'gps_fixed',
    tagline: 'Specific scores nobody else dares pick.',
    tintToken: '--mat-sys-primary',
  },
  LATE_BLOOMER: {
    name: 'Late Bloomer',
    emoji: '⏳',
    icon: 'hourglass_bottom',
    tagline: 'You warm up — your picks get bolder over time.',
    tintToken: '--mat-sys-tertiary',
  },
};

/**
 * Client-side shape of `users/{uid}/personality/current`. The wire format
 * stores `generatedAt` as a Firestore Timestamp, so we type it as such
 * here; the service hands a `Date`-converted version to components.
 */
export interface PersonalityDoc {
  readonly archetype: Archetype;
  readonly reasoning: string;
  readonly source: 'gemini' | 'fallback';
  readonly predictionsAtGen: number;
  readonly generatedAt: Timestamp;
}

/** Convenience for the card — fully-resolved view-model after the
 *  service has converted the Timestamp. */
export interface Personality {
  readonly archetype: Archetype;
  readonly reasoning: string;
  readonly source: 'gemini' | 'fallback';
  readonly predictionsAtGen: number;
  readonly generatedAt: Date;
}

// ---------------------------------------------------------------------------
// Eligibility — exposed so the client can render exact "Available in …" or
// "Make N more picks first" copy on the disabled regenerate button.
// Mirrors the constants in functions/src/personality.ts. Keep in lockstep.
// ---------------------------------------------------------------------------

export const PERSONALITY_MIN_PREDICTIONS = 3;
export const PERSONALITY_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface PersonalityEligibility {
  /** Whether the user can hit the Generate button right now. */
  readonly eligible: boolean;
  /** Total predictions submitted — drives the "<3 picks" empty state. */
  readonly totalPredictions: number;
  /** New predictions since the last generation; null if never generated. */
  readonly newPredictionsSinceGen: number | null;
  /** Milliseconds remaining on the cooldown; null if never generated. */
  readonly cooldownRemainingMs: number | null;
  /** Human-readable reason the button is disabled, or null if eligible. */
  readonly disabledReason: string | null;
}
