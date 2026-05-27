import * as logger from 'firebase-functions/logger';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import {
  computeStats,
  bestFit,
  fallbackReasoning,
  type PredictionInput,
  type PersonalityStats,
} from './lib/personality-stats';
import { ARCHETYPES, isArchetype, type Archetype } from './lib/personality';

/**
 * Gemini API key — set with `firebase functions:secrets:set GEMINI_API_KEY`
 * once per project. Get a free-tier key from https://aistudio.google.com/.
 *
 * If the secret isn't set when the function deploys, Gemini calls fail and
 * we fall back to the deterministic best-fit. So the feature still ships
 * with no API key configured — just minus the AI-written reasoning text.
 */
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

// ---------------------------------------------------------------------------
// Tunables — keep these in sync with src/app/core/models/personality.model.ts
// so client-side disabled-button copy matches the server's eligibility
// check. The server is authoritative; the client gate is UX-only.
// ---------------------------------------------------------------------------

export const MIN_PREDICTIONS = 3;
export const COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours
/** Max predictions to fetch fixture metadata for in a single call. Keeps
 *  the function fast in pathological "predicted everything" scenarios
 *  (104 picks → 104 fixture reads → still well within Firestore limits). */
const FIXTURE_BATCH = 30;

interface PersonalityResult {
  archetype: Archetype;
  reasoning: string;
  source: 'gemini' | 'fallback';
}

/**
 * Callable: generate (or regenerate) the caller's predictor personality.
 *
 * Pipeline:
 *   1. Require auth.
 *   2. Read the user's current personality doc (if any) for the
 *      cooldown / "new picks since" check.
 *   3. Read the user's predictions.
 *   4. Enforce eligibility — total ≥ 3 picks, ≥ 3 new since last
 *      generation, ≥ 12 h since last generation. First generation
 *      only requires the ≥ 3-picks check.
 *   5. Read fixture metadata for the matchIds the user has picked,
 *      assemble PredictionInput[] for stats.
 *   6. Compute the deterministic stats profile.
 *   7. (Future) Call Gemini with the stats + notable picks. For now,
 *      always fall through to bestFit + fallbackReasoning.
 *   8. Write `users/{uid}/personality/current`.
 *   9. Return the result so the client can render immediately without
 *      waiting on its own `onSnapshot` to fire.
 */
export const generatePredictorPersonality = onCall(
  {
    region: 'europe-west1',
    timeoutSeconds: 30,
    secrets: [GEMINI_API_KEY],
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError('unauthenticated', 'Sign in first.');
    }

    const db = getFirestore();
    const personalityRef = db.doc(`users/${uid}/personality/current`);
    const existing = await personalityRef.get();
    const existingData = existing.exists ? existing.data() : null;

    // Fetch the user's predictions. `predictions/{uid}/matches/{matchId}`
    // — small collection (≤104 docs at WC scale), cheap to read in one
    // shot. We need the data, not a count, because predictionsAtGen is
    // the source of truth for the "≥3 new since" check.
    const predsSnap = await db.collection(`predictions/${uid}/matches`).get();
    const total = predsSnap.size;

    // ----- Eligibility -----------------------------------------------------

    if (total < MIN_PREDICTIONS) {
      throw new HttpsError(
        'failed-precondition',
        `Need at least ${MIN_PREDICTIONS} predictions to generate a personality (you have ${total}).`,
        { code: 'insufficient_predictions', total, required: MIN_PREDICTIONS },
      );
    }

    if (existingData) {
      const last = existingData['generatedAt'];
      const lastMs = last instanceof Timestamp ? last.toMillis() : 0;
      const elapsedMs = Date.now() - lastMs;
      if (elapsedMs < COOLDOWN_MS) {
        throw new HttpsError(
          'failed-precondition',
          `You can regenerate in ${formatRemaining(COOLDOWN_MS - elapsedMs)}.`,
          {
            code: 'cooldown',
            cooldownRemainingMs: COOLDOWN_MS - elapsedMs,
          },
        );
      }
      const predictionsAtGen = typeof existingData['predictionsAtGen'] === 'number'
        ? existingData['predictionsAtGen']
        : 0;
      const newPicks = total - predictionsAtGen;
      if (newPicks < MIN_PREDICTIONS) {
        throw new HttpsError(
          'failed-precondition',
          `Make ${MIN_PREDICTIONS - newPicks} more prediction(s) before regenerating.`,
          {
            code: 'insufficient_new_picks',
            newPredictionsSinceGen: newPicks,
            required: MIN_PREDICTIONS,
          },
        );
      }
    }

    // ----- Read fixture metadata ------------------------------------------
    // We only need team metadata for the matches the user has predicted,
    // so do batched `getAll` reads rather than scanning the whole
    // fixtures collection. Firestore's `getAll` is multi-doc-fetch and
    // each doc counts as one read, same as a single `get()`.

    const matchIds: string[] = [];
    const predictions: Array<{
      matchId: string;
      homeScore: number;
      awayScore: number;
      submittedAt: number;
    }> = [];

    for (const doc of predsSnap.docs) {
      const data = doc.data();
      if (typeof data['homeScore'] !== 'number' || typeof data['awayScore'] !== 'number') {
        continue;
      }
      const submitted = data['submittedAt'];
      const ms = submitted instanceof Timestamp ? submitted.toMillis() : Date.now();
      matchIds.push(doc.id);
      predictions.push({
        matchId: doc.id,
        homeScore: data['homeScore'],
        awayScore: data['awayScore'],
        submittedAt: ms,
      });
    }

    const fixturesByMatchId = new Map<string, FixtureRef>();
    for (let i = 0; i < matchIds.length; i += FIXTURE_BATCH) {
      const slice = matchIds.slice(i, i + FIXTURE_BATCH);
      const refs = slice.map((id) => db.doc(`fixtures/${id}`));
      const docs = await db.getAll(...refs);
      for (const d of docs) {
        if (!d.exists) continue;
        const data = d.data() ?? {};
        const home = data['homeTeam'] ?? {};
        const away = data['awayTeam'] ?? {};
        fixturesByMatchId.set(d.id, {
          homeTla: typeof home['tla'] === 'string' ? home['tla'] : null,
          awayTla: typeof away['tla'] === 'string' ? away['tla'] : null,
          homeName: typeof home['name'] === 'string' ? home['name'] : null,
          awayName: typeof away['name'] === 'string' ? away['name'] : null,
        });
      }
    }

    const inputs: PredictionInput[] = predictions
      .map((p) => {
        const fx = fixturesByMatchId.get(p.matchId);
        if (!fx) return null;
        return {
          matchId: p.matchId,
          homeScore: p.homeScore,
          awayScore: p.awayScore,
          submittedAt: p.submittedAt,
          homeTla: fx.homeTla,
          awayTla: fx.awayTla,
          homeName: fx.homeName,
          awayName: fx.awayName,
        };
      })
      .filter((x): x is PredictionInput => x !== null);

    // ----- Compute stats + classify ---------------------------------------

    const stats = computeStats(inputs);
    const result = await classify(stats);

    // ----- Persist + return -----------------------------------------------

    const generatedAt = FieldValue.serverTimestamp();
    await personalityRef.set({
      archetype: result.archetype,
      reasoning: result.reasoning,
      source: result.source,
      predictionsAtGen: total,
      generatedAt,
    });

    logger.info('Generated predictor personality', {
      uid,
      archetype: result.archetype,
      source: result.source,
      predictions: total,
    });

    return {
      archetype: result.archetype,
      reasoning: result.reasoning,
      source: result.source,
      predictionsAtGen: total,
    };
  },
);

// ---------------------------------------------------------------------------
// Classification — Gemini-first with deterministic fallback. The Gemini
// branch is added in a later step; today this always falls through to
// `bestFit` so the rest of the pipeline can ship and be tested without
// needing the API key wired up.
// ---------------------------------------------------------------------------

async function classify(stats: PersonalityStats): Promise<PersonalityResult> {
  const fallback = (): PersonalityResult => {
    const archetype = bestFit(stats);
    return {
      archetype,
      reasoning: fallbackReasoning(archetype, stats),
      source: 'fallback',
    };
  };
  // Try Gemini if it's wired and configured; on any error fall through
  // to the deterministic path so the user always gets a label. Errors
  // are logged with the full message + stack so a missing secret, an
  // invalid model name, or a malformed response are all diagnosable
  // from the functions emulator console.
  try {
    const gemini = await maybeRunGemini(stats);
    if (gemini) return { ...gemini, source: 'gemini' };
    logger.warn('Gemini call returned null — falling back (likely no API key or invalid response)');
  } catch (e: unknown) {
    const err = e as { message?: string; status?: number; stack?: string };
    logger.error('Gemini personality call threw — falling back', {
      message: err?.message ?? String(e),
      status: err?.status,
      stack: err?.stack,
    });
  }
  return fallback();
}

/**
 * Call Gemini to choose an archetype and write the reasoning text.
 *
 * Returns null (not throws) when:
 *   - The API key isn't configured (project hasn't run
 *     `firebase functions:secrets:set GEMINI_API_KEY`).
 *   - The response is missing or fails to parse.
 *   - The returned archetype isn't in our enum (should be impossible
 *     given `responseSchema`, but defensive).
 *
 * Throws on transport errors so `classify()` can log them as warnings
 * before falling back. Either way the user gets a label.
 *
 * Why we still send a pre-computed bestFit hint in the prompt: Gemini
 * wins on writing the reasoning text, but its archetype choice is
 * roughly as good as our deterministic scorer for the cleanest cases.
 * Including our hint lets the model agree fast for obvious patterns
 * and only override when it sees something the math missed.
 */
async function maybeRunGemini(
  stats: PersonalityStats,
): Promise<{ archetype: Archetype; reasoning: string } | null> {
  const apiKey = GEMINI_API_KEY.value();
  if (!apiKey) {
    // No secret configured — silently skip Gemini. Common in dev when
    // a developer hasn't set up an API key yet.
    return null;
  }

  // Lazy-import the SDK so cold starts on functions that don't use
  // Gemini aren't paying for the bundle. Top-level `import` would
  // load it for every function in this codebase.
  const { GoogleGenAI, Type } = await import('@google/genai');

  const ai = new GoogleGenAI({ apiKey });

  const hint = bestFit(stats);
  const prompt = buildPrompt(stats, hint);

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: prompt,
    config: {
      // Structured output — locks the response shape so we don't have
      // to error-handle freeform text. Enum constraint on `archetype`
      // means we literally cannot get back an unknown label.
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          archetype: {
            type: Type.STRING,
            enum: [...ARCHETYPES],
          },
          reasoning: {
            type: Type.STRING,
            description:
              'A short, punchy explanation under 200 characters that mentions a specific pick or stat from the user data.',
          },
        },
        required: ['archetype', 'reasoning'],
        propertyOrdering: ['archetype', 'reasoning'],
      },
      temperature: 0.7,
      maxOutputTokens: 250,
    },
  });

  const raw = response.text;
  if (!raw) {
    logger.warn('Gemini returned empty response');
    return null;
  }
  let parsed: { archetype?: unknown; reasoning?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    logger.warn('Gemini response not valid JSON', { raw: raw.slice(0, 200) });
    return null;
  }
  if (!isArchetype(parsed.archetype)) {
    logger.warn('Gemini archetype not in enum', { archetype: parsed.archetype });
    return null;
  }
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 240) : '';
  if (!reasoning) {
    logger.warn('Gemini returned empty reasoning');
    return null;
  }
  return { archetype: parsed.archetype, reasoning };
}

/**
 * Build the prompt sent to Gemini. Keeps the stats compact (numbers
 * rounded to 2dp) so token usage stays minimal, and includes 3-5
 * notable picks so Gemini can write reasoning text that references
 * actual matches the user picked.
 */
function buildPrompt(stats: PersonalityStats, hint: Archetype): string {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const pct = (n: number) => Math.round(n * 100);
  const profile = {
    totalPredictions: stats.total,
    pickedUnderdog: `${pct(stats.upsetRate)}%`,
    pickedBigUnderdog: `${pct(stats.bigUpsetRate)}%`,
    pickedFavorite: `${pct(stats.favoriteRate)}%`,
    pickedHomeWin: `${pct(stats.homePickRate)}%`,
    pickedDraw: `${pct(stats.drawPickRate)}%`,
    avgGoalsPerMatch: r2(stats.avgGoalsPerMatch),
    highScoringPicks: `${pct(stats.highScoringRate)}%`,
    lowScoringPicks: `${pct(stats.lowScoringRate)}%`,
    unusualScores: `${pct(stats.unusualScoreRate)}%`,
    scoreEntropy: r2(stats.scoreEntropy),
    favoriteTeam: stats.topTeamName,
    favoriteTeamWins: stats.topTeamPickCount,
    favoriteTeamPickRate: `${pct(stats.topTeamPickRate)}%`,
    earlyAvgGoals: r2(stats.earlyAvgGoals),
    lateAvgGoals: r2(stats.lateAvgGoals),
    earlyUpsetRate: `${pct(stats.earlyUpsetRate)}%`,
    lateUpsetRate: `${pct(stats.lateUpsetRate)}%`,
    notablePicks: stats.notablePicks.map((p) => ({
      pick: p.description,
      category: p.category,
      detail: p.detail,
    })),
  };

  return [
    `You're labelling a football prediction game user's personality.`,
    `Pick exactly one archetype from this list and write a punchy 1-sentence reasoning under 200 characters.`,
    ``,
    `Archetypes:`,
    `- AGAINST_ALL_ODDS: consistently backs FIFA-ranked underdogs.`,
    `- THE_STATISTICIAN: consistently backs the higher-ranked team.`,
    `- HOME_SWEET_HOME: heavy home-team-wins bias.`,
    `- GOAL_RUSH: predicts high-scoring matches.`,
    `- THE_WALL: predicts low-scoring, defensive matches.`,
    `- DRAW_DEALER: picks more draws than typical.`,
    `- CHAOS_GOBLIN: high variance, unusual scorelines.`,
    `- HOMETOWN_HERO: backs one specific team over and over.`,
    `- SNIPER: predicts specific unusual scores (3-2, 4-1) rather than common ones.`,
    `- LATE_BLOOMER: picks evolve over the tournament, getting bolder later.`,
    ``,
    `Pre-computed hint (you may agree or override): ${hint}`,
    ``,
    `User's prediction profile:`,
    JSON.stringify(profile, null, 2),
    ``,
    `Respond with the archetype enum and reasoning text. The reasoning should reference a specific stat or pick from the data above (e.g. "you backed Saudi Arabia 2-1 over Germany — bookies don't see you coming") and stay under 200 characters.`,
  ].join('\n');
}

// Re-exported for the future Gemini step so it can call directly into
// the same validators when parsing structured-output responses.
export const _internalsForGemini = {
  ARCHETYPES,
  isArchetype,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FixtureRef {
  homeTla: string | null;
  awayTla: string | null;
  homeName: string | null;
  awayName: string | null;
}

function formatRemaining(ms: number): string {
  const totalMin = Math.ceil(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
