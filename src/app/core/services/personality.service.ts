import { Injectable, Signal, computed, effect, inject, signal } from '@angular/core';
import { Timestamp, doc, getDoc, onSnapshot } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { FIRESTORE, FUNCTIONS } from '../firebase/firebase.providers';
import {
  Archetype,
  PERSONALITY_COOLDOWN_MS,
  PERSONALITY_MIN_PREDICTIONS,
  Personality,
  PersonalityDoc,
  PersonalityEligibility,
  isArchetype,
} from '../models/personality.model';
import { AuthService } from './auth.service';
import { PredictionsService } from './predictions.service';

/** Server's structured-error code for the rejection. Matches the
 *  `code` values thrown from the Cloud Function via HttpsError details. */
type GenerateErrorCode =
  | 'insufficient_predictions'
  | 'insufficient_new_picks'
  | 'cooldown';

/**
 * Owns the user's predictor personality state: live subscription to the
 * caller's own personality doc, one-shot reads for other users' docs,
 * and the callable invocation that (re)generates it.
 *
 * Eligibility is computed client-side so the UI can preview "Available
 * in 4h 23m" or "Make 2 more picks first" without round-tripping. The
 * Cloud Function re-validates the same rules and is the authority.
 */
@Injectable({ providedIn: 'root' })
export class PersonalityService {
  private readonly db = inject(FIRESTORE);
  private readonly functions = inject(FUNCTIONS);
  private readonly auth = inject(AuthService);
  private readonly predictions = inject(PredictionsService);

  private readonly _myPersonality = signal<Personality | null>(null);
  private readonly _loaded = signal<boolean>(false);

  readonly myPersonality: Signal<Personality | null> = this._myPersonality.asReadonly();
  readonly loaded: Signal<boolean> = this._loaded.asReadonly();

  /**
   * Live eligibility derived from the user's prediction count and the
   * most recent personality doc. Recomputes on every prediction change
   * so the button auto-enables the moment the third new pick lands.
   */
  readonly eligibility: Signal<PersonalityEligibility> = computed(() => {
    const total = this.predictions.matchPredictions().size;
    const current = this._myPersonality();
    return this.deriveEligibility(total, current);
  });

  constructor() {
    // Listen to the signed-in user's own personality doc. Tears down on
    // sign-out / sign-in via the standard Angular DestroyRef pattern.
    effect((onCleanup) => {
      const uid = this.auth.uid();
      if (!uid) {
        this._myPersonality.set(null);
        this._loaded.set(false);
        return;
      }
      this._loaded.set(false);
      const ref = doc(this.db, `users/${uid}/personality/current`);
      const unsub = onSnapshot(
        ref,
        (snap) => {
          this._myPersonality.set(snap.exists() ? this.parse(snap.data()) : null);
          this._loaded.set(true);
        },
        (err) => {
          // A 'permission-denied' here would be a misconfigured rule —
          // don't blow up the page, just log and stay in "not loaded".
          console.error('[PersonalityService] my personality listener error:', err);
          this._loaded.set(true);
        },
      );
      onCleanup(() => unsub());
    });
  }

  /**
   * One-shot fetch for another user's personality (for /users/:uid).
   * Returns null if the user has never generated one, or if the read
   * is denied (e.g. rules change in future). Errors are logged but
   * NOT thrown — visitors should never see a 500 because someone else
   * doesn't have a personality yet.
   */
  async getPersonality(uid: string): Promise<Personality | null> {
    try {
      const snap = await getDoc(doc(this.db, `users/${uid}/personality/current`));
      if (!snap.exists()) return null;
      return this.parse(snap.data());
    } catch (e) {
      console.error('[PersonalityService] getPersonality failed for', uid, e);
      return null;
    }
  }

  /**
   * Invoke the `generatePredictorPersonality` Cloud Function. Returns
   * the newly-written personality on success. The local `myPersonality`
   * signal will update via the live listener once Firestore propagates
   * the write — usually within a few hundred ms.
   *
   * On rejection (cooldown, insufficient picks), throws a structured
   * Error whose `cause` carries the server's error code. The card UI
   * inspects this to render a precise snackbar message.
   */
  async generate(): Promise<{ archetype: Archetype; reasoning: string; source: 'gemini' | 'fallback' }> {
    const callable = httpsCallable<unknown, { archetype: string; reasoning: string; source: 'gemini' | 'fallback' }>(
      this.functions,
      'generatePredictorPersonality',
    );
    try {
      const res = await callable({});
      const data = res.data;
      if (!isArchetype(data.archetype)) {
        throw new Error('Server returned unknown archetype');
      }
      return {
        archetype: data.archetype,
        reasoning: data.reasoning,
        source: data.source,
      };
    } catch (e: unknown) {
      // firebase/functions HttpsError surfaces .code (e.g. 'functions/failed-precondition')
      // and .details (the structured payload we threw).
      const err = e as { code?: string; message?: string; details?: { code?: GenerateErrorCode } };
      const detail = err?.details?.code;
      const wrap = new Error(err?.message ?? 'Failed to generate personality');
      (wrap as Error & { code?: GenerateErrorCode }).code = detail;
      throw wrap;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private parse(data: Record<string, unknown> | undefined): Personality | null {
    if (!data) return null;
    if (!isArchetype(data['archetype'])) return null;
    const ts = data['generatedAt'];
    return {
      archetype: data['archetype'],
      reasoning: typeof data['reasoning'] === 'string' ? data['reasoning'] : '',
      source: data['source'] === 'gemini' ? 'gemini' : 'fallback',
      predictionsAtGen: typeof data['predictionsAtGen'] === 'number' ? data['predictionsAtGen'] : 0,
      generatedAt: ts instanceof Timestamp ? ts.toDate() : new Date(0),
    };
  }

  private deriveEligibility(total: number, current: Personality | null): PersonalityEligibility {
    // Floor: need at least MIN_PREDICTIONS picks total. Below this we
    // don't even let the user try — the personality wouldn't be
    // meaningful.
    if (total < PERSONALITY_MIN_PREDICTIONS) {
      const needed = PERSONALITY_MIN_PREDICTIONS - total;
      return {
        eligible: false,
        totalPredictions: total,
        newPredictionsSinceGen: null,
        cooldownRemainingMs: null,
        disabledReason: `Make ${needed} more prediction${needed === 1 ? '' : 's'} to unlock your personality.`,
      };
    }

    // First-time generation — total ≥ 3 is the only requirement.
    if (!current) {
      return {
        eligible: true,
        totalPredictions: total,
        newPredictionsSinceGen: null,
        cooldownRemainingMs: null,
        disabledReason: null,
      };
    }

    // Regeneration — cooldown + new-picks delta.
    const elapsedMs = Date.now() - current.generatedAt.getTime();
    const cooldownRemainingMs = Math.max(0, PERSONALITY_COOLDOWN_MS - elapsedMs);
    const newSince = total - current.predictionsAtGen;

    if (cooldownRemainingMs > 0) {
      return {
        eligible: false,
        totalPredictions: total,
        newPredictionsSinceGen: newSince,
        cooldownRemainingMs,
        disabledReason: `Available again in ${this.formatRemaining(cooldownRemainingMs)}.`,
      };
    }

    if (newSince < PERSONALITY_MIN_PREDICTIONS) {
      const needed = PERSONALITY_MIN_PREDICTIONS - newSince;
      return {
        eligible: false,
        totalPredictions: total,
        newPredictionsSinceGen: newSince,
        cooldownRemainingMs: 0,
        disabledReason: `Make ${needed} more prediction${needed === 1 ? '' : 's'} before regenerating.`,
      };
    }

    return {
      eligible: true,
      totalPredictions: total,
      newPredictionsSinceGen: newSince,
      cooldownRemainingMs: 0,
      disabledReason: null,
    };
  }

  private formatRemaining(ms: number): string {
    const totalMin = Math.ceil(ms / 60_000);
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  // Quiet the unused-import warning until PersonalityDoc is referenced
  // from a test file. Exists so the type is reachable for callers who
  // might serialize the doc themselves.
  protected readonly _doctype?: PersonalityDoc;
}
