import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { getFirestore } from 'firebase-admin/firestore';

/**
 * Dev-only callable: wipe the caller's predictor-personality doc so they
 * can regenerate immediately, bypassing the 12 h cooldown + 3-new-picks
 * eligibility check.
 *
 * Used during local development when tuning the Gemini prompt or
 * verifying the deterministic fallback path — generating costs an LLM
 * call, so iteration cycles matter.
 *
 * Emulator-only: refuses to run anywhere `FUNCTIONS_EMULATOR !== 'true'`
 * (same gate as `devResetMyState`). Production deployments can deploy
 * this file without any security risk because production env never sets
 * that flag.
 */
export const devClearMyPersonality = onCall(
  { region: 'europe-west1' },
  async (request) => {
    if (process.env['FUNCTIONS_EMULATOR'] !== 'true') {
      throw new HttpsError('failed-precondition', 'Dev tools are emulator-only.');
    }
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in first.');
    }

    const uid = request.auth.uid;
    const db = getFirestore();
    await db.doc(`users/${uid}/personality/current`).delete();

    logger.info(`devClearMyPersonality: uid=${uid} cleared`);

    return { ok: true };
  },
);
