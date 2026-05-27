/**
 * Predictor-personality archetypes. Fixed taxonomy of 10 labels assigned
 * by the `generatePredictorPersonality` callable. The label is either
 * chosen by Gemini given the user's pre-computed stats, or by the
 * deterministic best-fit fallback when Gemini is unavailable.
 *
 * Order is meaningful only in that the first matching archetype in the
 * fallback's priority list wins. The visible card UI sorts by whatever
 * order makes sense per design.
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

/**
 * Shape of the personality doc written to
 * `users/{uid}/personality/current`. Read by the Angular
 * `PersonalityService` and rendered by `PredictorPersonalityCardComponent`.
 *
 * `predictionsAtGen` is the user's prediction count at generation time,
 * used by the server to enforce the "≥3 new picks since last generation"
 * rule on the next regeneration attempt.
 *
 * `source` lets us debug which path produced a given result without
 * sniffing the reasoning string — `'gemini'` means the LLM responded
 * with a parseable structured-output answer; `'fallback'` means we used
 * the deterministic best-fit because Gemini was unavailable, returned
 * garbage, or the user lives in a region where the Functions secret
 * isn't wired yet.
 */
export interface PersonalityDoc {
  readonly archetype: Archetype;
  readonly reasoning: string;
  readonly source: 'gemini' | 'fallback';
  readonly predictionsAtGen: number;
  // generatedAt is a Firestore Timestamp on the wire; modelled as `unknown`
  // here so this file can stay free of the firebase-admin/firestore types
  // (it's shared with the Angular side via a parallel copy).
  readonly generatedAt: unknown;
}
