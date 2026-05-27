import { onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { getFirestore } from 'firebase-admin/firestore';
import { requireAdminOrEmulator } from './lib/admin-check';

/**
 * Wipe the caller's predictor-personality doc so they can regenerate
 * immediately, bypassing the 12 h cooldown + 3-new-picks eligibility
 * check.
 *
 * Local dev: used when tuning the Gemini prompt or verifying the
 * deterministic fallback path — generating costs an LLM call, so
 * iteration cycles matter.
 *
 * Production: kept available to admin users so we can demo the
 * regeneration flow during friends-tests without waiting out cooldowns.
 *
 * Access: emulator OR admin role. The wipe is self-scoped (we always
 * delete the CALLER's personality, never anyone else's), so the worst
 * a compromised admin account could do is wipe their own personality
 * — same harm as just clicking the button.
 */
export const devClearMyPersonality = onCall(
  { region: 'europe-west1' },
  async (request) => {
    await requireAdminOrEmulator(request);

    const uid = request.auth!.uid;
    const db = getFirestore();
    await db.doc(`users/${uid}/personality/current`).delete();

    logger.info(`devClearMyPersonality: uid=${uid} cleared`);

    return { ok: true };
  },
);
