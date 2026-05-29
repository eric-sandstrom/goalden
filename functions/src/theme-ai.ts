import * as logger from 'firebase-functions/logger';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

/** Shared with the personality feature — set once via
 *  `firebase functions:secrets:set GEMINI_API_KEY`. */
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

/** Material 3 scheme variants — keep in sync with VariantName in
 *  src/app/core/services/theme.service.ts. */
const VARIANTS = [
  'TONAL_SPOT',
  'VIBRANT',
  'EXPRESSIVE',
  'FIDELITY',
  'CONTENT',
  'MONOCHROME',
  'NEUTRAL',
  'RAINBOW',
  'FRUIT_SALAD',
] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * AI theming: turn a free-text vibe ("sunset over the ocean") into the same
 * theme payload the randomizer/picker uses — three seed colours plus a Material
 * 3 scheme variant. The client feeds the result straight into ThemeService
 * (setColors + setVariant), exactly like the randomizer, with Gemini as the
 * "make it pretty" layer in between.
 *
 * Structured output locks the response to {primary, secondary, tertiary,
 * variant}; we still validate the hex + variant server-side and reject garbage.
 */
export const generateTheme = onCall({ secrets: [GEMINI_API_KEY] }, async (req) => {
  if (!req.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Sign in to use AI theming.');
  }
  const prompt = typeof req.data?.prompt === 'string' ? req.data.prompt.trim() : '';
  if (!prompt) {
    throw new HttpsError('invalid-argument', 'Describe a theme first.');
  }
  if (prompt.length > 200) {
    throw new HttpsError('invalid-argument', 'Theme description is too long.');
  }

  const apiKey = GEMINI_API_KEY.value();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'AI theming is not configured.');
  }

  // Lazy-import so functions that don't use Gemini don't pay the bundle cost.
  const { GoogleGenAI, Type } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents:
      `You are a UI theme designer for "Goalden", a football (soccer) prediction ` +
      `app built with Material 3. Given a vibe, choose three seed colours and the ` +
      `Material 3 scheme variant that best capture it.\n\n` +
      `- primary: the dominant brand/accent colour\n` +
      `- secondary: a supporting colour\n` +
      `- tertiary: a contrasting accent\n` +
      `- variant: the Material 3 colour-scheme algorithm matching the mood\n` +
      `- contrast: how punchy the theme reads, from -1 (soft/low) to 1 (bold/high), ` +
      `0 is standard. Use higher contrast for vivid/energetic vibes, lower for muted/calm ones.\n\n` +
      `Return rich, saturated #RRGGBB seeds (Material derives the full tonal scale ` +
      `from them) — avoid near-black or near-white.\n\n` +
      `Vibe: "${prompt}"`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          primary: { type: Type.STRING, description: 'Seed colour as #RRGGBB hex' },
          secondary: { type: Type.STRING, description: 'Seed colour as #RRGGBB hex' },
          tertiary: { type: Type.STRING, description: 'Seed colour as #RRGGBB hex' },
          variant: { type: Type.STRING, enum: [...VARIANTS] },
          contrast: {
            type: Type.NUMBER,
            description: 'Contrast level from -1 (soft) to 1 (bold); 0 is standard.',
          },
        },
        required: ['primary', 'secondary', 'tertiary', 'variant', 'contrast'],
        propertyOrdering: ['primary', 'secondary', 'tertiary', 'variant', 'contrast'],
      },
      thinkingConfig: { thinkingBudget: 0 },
      temperature: 1.0,
      maxOutputTokens: 1024,
    },
  });

  const raw = response.text;
  logger.info('generateTheme raw response', { prompt, text: raw ?? null });
  if (!raw) {
    throw new HttpsError('internal', 'AI returned no theme. Try again.');
  }

  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  let parsed: {
    primary?: unknown;
    secondary?: unknown;
    tertiary?: unknown;
    variant?: unknown;
    contrast?: unknown;
  };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new HttpsError('internal', 'AI returned a malformed theme. Try again.');
  }

  const primary = normHex(parsed.primary);
  const secondary = normHex(parsed.secondary);
  const tertiary = normHex(parsed.tertiary);
  if (!primary || !secondary || !tertiary) {
    throw new HttpsError('internal', 'AI returned invalid colours. Try again.');
  }
  const variant =
    typeof parsed.variant === 'string' && (VARIANTS as readonly string[]).includes(parsed.variant)
      ? parsed.variant
      : 'TONAL_SPOT';

  return { primary, secondary, tertiary, variant, contrast: clampContrast(parsed.contrast) };
});

/** Coerce + clamp the AI's contrast to the [-1, 1] the theme engine accepts. */
function clampContrast(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

/** Normalise a value to a `#rrggbb` hex string, or null if it isn't one. */
function normHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s.startsWith('#')) s = `#${s}`;
  return HEX.test(s) ? s.toLowerCase() : null;
}
