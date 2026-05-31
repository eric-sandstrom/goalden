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

/** The active-competition set changes rarely (only via setCompetitionActive /
 *  syncCompetitionsFromApi), yet the fixtures poller resolves it every minute.
 *  Cache the resolved contexts in module scope for a short TTL so the
 *  every-minute path costs N reads per TTL instead of N reads per minute.
 *  Per function instance (a cold start just re-queries); the explicit-compId
 *  path is never cached. A comp toggle takes effect within ACTIVE_TTL_MS. */
let activeContextsCache: { at: number; contexts: readonly CompetitionContext[] } | null = null;
const ACTIVE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolves the list of (compId, season) contexts to poll. Two paths:
 *   - explicit `compId`: read that single doc; if missing or no
 *     currentSeason, return empty so the caller surfaces the warning.
 *   - implicit: list `competitions/` where `active == true` (cached, see above).
 *
 * Comps without a `currentSeason` are filtered out — football-data
 * returns null for these during the between-seasons window and there's
 * nothing to poll until the next season starts.
 */
export async function resolveCompetitionContexts(
  db: FirebaseFirestore.Firestore,
  compId: string | undefined,
): Promise<readonly CompetitionContext[]> {
  if (!compId && activeContextsCache && Date.now() - activeContextsCache.at < ACTIVE_TTL_MS) {
    return activeContextsCache.contexts;
  }

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

  if (!compId) activeContextsCache = { at: Date.now(), contexts };
  return contexts;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
