import * as logger from 'firebase-functions/logger';

/**
 * Shared helpers for the football-data pollers (fixtures + standings).
 *
 * Both pollers resolve the same set of (competitionId, season) contexts —
 * either a single explicit comp, or every `competitions/{id}` doc where
 * `active == true` — and pace their requests with a small delay to respect
 * the free-tier rate cap. Factored out so the two surfaces share one
 * source of truth for "which comps do we poll, and for which season".
 */

export interface CompetitionContext {
  /** Firestore doc id = our competition code. Internal identity: cache keys,
   *  fixtures.competitionId, ESPN slug, logging. May be a derived code (e.g.
   *  "SUP" for Superettan) when football-data ships no code for the comp. */
  readonly id: string;
  /** football-data's numeric competition id. Use this — not `id` — in
   *  football-data API URLs: their `/v4/competitions/{id}` path accepts the
   *  numeric id, which always exists, whereas the textual code does not for
   *  every comp. Null only for legacy docs synced before fdId was stored. */
  readonly fdId: number | null;
  readonly season: string;
}

/** Pulls the season starting calendar year out of the API's date format.
 *  e.g. `currentSeason.startDate = '2025-08-16'` → `'2025'`. */
export function extractSeason(currentSeason: unknown): string | null {
  if (!currentSeason || typeof currentSeason !== 'object') return null;
  const startDate = (currentSeason as { startDate?: unknown })['startDate'];
  if (typeof startDate !== 'string' || startDate.length < 4) return null;
  return startDate.slice(0, 4);
}

/**
 * Resolves the list of (compId, season) contexts to poll. Two paths:
 *   - explicit `compId`: read that single doc; if missing or no
 *     currentSeason, return empty so the caller surfaces the warning.
 *   - implicit: list `competitions/` where `active == true`.
 *
 * Comps without a `currentSeason` are filtered out — football-data
 * returns null for these during the between-seasons window and there's
 * nothing to poll until the next season starts.
 */
export async function resolveCompetitionContexts(
  db: FirebaseFirestore.Firestore,
  compId: string | undefined,
): Promise<readonly CompetitionContext[]> {
  const snap = compId
    ? await db.collection('competitions').doc(compId).get().then((d) => (d.exists ? [d] : []))
    : (await db.collection('competitions').where('active', '==', true).get()).docs;

  const contexts: CompetitionContext[] = [];
  for (const doc of snap) {
    const data = doc.data() ?? {};
    const season = extractSeason(data['currentSeason']);
    if (!season) {
      logger.info(`[${doc.id}] skipped — no current season`);
      continue;
    }
    const fdId = typeof data['fdId'] === 'number' ? (data['fdId'] as number) : null;
    contexts.push({ id: doc.id, fdId, season });
  }
  return contexts;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
