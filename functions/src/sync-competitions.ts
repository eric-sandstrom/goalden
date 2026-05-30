import * as logger from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { FOOTBALL_DATA_TOKEN } from './poll-football-data';
import { requireAdminOrEmulator } from './lib/admin-check';

/**
 * Sync the competitions/{code} collection from football-data.org's
 * /competitions endpoint.
 *
 * Why discover instead of hardcode: football-data returns exactly the
 * competitions our API token has access to. Re-running this when the
 * tier changes or a new comp gets added means no code deploy.
 *
 * Idempotent. Each invocation:
 *   - Creates new docs (with active: false) for previously-unseen comps.
 *   - Updates metadata fields (name, emblem, type, area, currentSeason)
 *     for known comps.
 *   - Preserves the admin-controlled flags (active, hasGlobalLeague).
 *
 * Polling stays gated by `active: true` — discovering a comp does NOT
 * make us start hitting its /matches endpoint. The admin still has to
 * flip the toggle in dev-tools. Keeps the polling surface deliberate.
 */
interface FdArea {
  readonly id: number;
  readonly name: string;
  readonly code?: string;
  readonly flag?: string | null;
}

interface FdSeason {
  readonly id: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly currentMatchday?: number | null;
  readonly winner?: unknown;
}

interface FdCompetition {
  readonly id: number;
  readonly area: FdArea;
  readonly name: string;
  // football-data leaves `code` blank/absent for some competitions
  // (more common since the tier upgrade). We key docs on `code`, so
  // code-less comps get filtered out below rather than typed as required.
  readonly code?: string | null;
  readonly type: 'LEAGUE' | 'CUP';
  readonly emblem: string | null;
  readonly plan?: string;
  readonly currentSeason?: FdSeason | null;
  readonly numberOfAvailableSeasons?: number;
  readonly lastUpdated?: string;
}

interface FdResponse {
  readonly count: number;
  readonly competitions: readonly FdCompetition[];
}

/** Upper bound on the football-data /competitions request. Sits well under
 *  the function's 60s deadline so a stalled upstream fails fast with a clear
 *  error, rather than consuming the whole budget and surfacing an opaque
 *  `deadline-exceeded` (the Cloud Run 504) to the client. */
const FETCH_TIMEOUT_MS = 20_000;

/** Competition code we use as the Firestore doc id. football-data leaves it
 *  blank for some comps (e.g. Superettan), so fall back to the first three
 *  alphanumeric letters of the name, uppercased (e.g. "Superettan" -> "SUP"). */
function resolveCode(c: FdCompetition): string {
  if (typeof c.code === 'string' && c.code.length > 0) return c.code;
  return c.name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase();
}

export const syncCompetitionsFromApi = onCall(
  { region: 'europe-west1', secrets: [FOOTBALL_DATA_TOKEN] },
  async (request) => {
    await requireAdminOrEmulator(request);

    const token = FOOTBALL_DATA_TOKEN.value();
    if (!token) {
      throw new HttpsError(
        'failed-precondition',
        'FOOTBALL_DATA_TOKEN secret missing — set it via `firebase functions:secrets:set FOOTBALL_DATA_TOKEN`.',
      );
    }

    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch('https://api.football-data.org/v4/competitions', {
        headers: { 'X-Auth-Token': token },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      logger.error('football-data /competitions fetch failed', { err: String(err) });
      throw new HttpsError(
        'unavailable',
        'football-data /competitions did not respond in time — try again in a moment.',
      );
    }
    if (!res.ok) {
      const body = await res.text();
      logger.error('football-data /competitions returned non-OK', {
        status: res.status,
        body,
      });
      throw new HttpsError(
        'unavailable',
        `football-data /competitions returned HTTP ${res.status}`,
      );
    }

    const data = (await res.json()) as FdResponse;
    logger.info(`Discovered ${data.competitions.length} competitions`);

    // We key competition docs on `code`. football-data returns some comps
    // (e.g. Superettan, fdId 2074) with a blank/missing code, which would
    // throw at `.doc(c.code)`. Fall back to the first 3 letters of the name,
    // uppercased, and use that as both the code and the doc id.
    const competitions = data.competitions.map((c) => ({
      ...c,
      code: resolveCode(c),
    }));
    const derived = competitions.filter((c, i) => c.code !== data.competitions[i].code);
    if (derived.length > 0) {
      logger.warn(`Derived a code for ${derived.length} competition(s) with none`, {
        names: derived.map((c) => `${c.name} -> ${c.code} (fdId ${c.id})`),
      });
    }

    const db = getFirestore();
    const refs = competitions.map((c) => db.collection('competitions').doc(c.code));
    const snapshots = refs.length > 0 ? await db.getAll(...refs) : [];
    const existingByCode = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    for (const s of snapshots) existingByCode.set(s.id, s);

    let created = 0;
    let updated = 0;
    const batch = db.batch();

    for (const c of competitions) {
      const ref = db.collection('competitions').doc(c.code);
      const existing = existingByCode.get(c.code);

      // Metadata block: rewritten on every sync from the API response.
      // Anything admin-controlled (active, hasGlobalLeague) lives outside
      // this block so it never gets clobbered.
      const metadata = {
        id: c.code,
        fdId: c.id,
        name: c.name,
        emblem: c.emblem ?? null,
        type: c.type,
        plan: c.plan ?? null,
        area: {
          id: c.area.id,
          name: c.area.name,
          code: c.area.code ?? null,
          flag: c.area.flag ?? null,
        },
        currentSeason: c.currentSeason
          ? {
              id: c.currentSeason.id,
              startDate: c.currentSeason.startDate,
              endDate: c.currentSeason.endDate,
              currentMatchday: c.currentSeason.currentMatchday ?? null,
            }
          : null,
        lastSyncedAt: FieldValue.serverTimestamp(),
      };

      if (!existing || !existing.exists) {
        // First sighting — initialise admin flags to safe defaults.
        batch.set(ref, {
          ...metadata,
          active: false,
          hasGlobalLeague: false,
          createdAt: FieldValue.serverTimestamp(),
        });
        created++;
      } else {
        // Existing — merge metadata, leave admin flags untouched.
        batch.set(ref, metadata, { merge: true });
        updated++;
      }
    }

    if (competitions.length > 0) {
      await batch.commit();
    }

    logger.info(`Competitions synced — created ${created}, updated ${updated}`);
    return {
      ok: true,
      discovered: data.competitions.length,
      derived: derived.length,
      created,
      updated,
    };
  },
);

/**
 * Admin toggle for the `active` flag on a competition doc. Flipping
 * to `true` makes the next pollFootballData cycle start fetching this
 * competition's fixtures. Flipping to `false` stops polling but does
 * NOT delete the competition's fixtures (in case we want to flip it
 * back on later or migrate to a different system).
 */
export const setCompetitionActive = onCall(
  { region: 'europe-west1' },
  async (request) => {
    await requireAdminOrEmulator(request);

    const { compId, active } = request.data ?? {};
    if (typeof compId !== 'string' || compId.length === 0) {
      throw new HttpsError('invalid-argument', 'compId required');
    }
    if (typeof active !== 'boolean') {
      throw new HttpsError('invalid-argument', 'active must be a boolean');
    }

    const db = getFirestore();
    const ref = db.collection('competitions').doc(compId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError(
        'not-found',
        `Competition ${compId} not found — sync from API first.`,
      );
    }

    await ref.update({
      active,
      activeChangedAt: FieldValue.serverTimestamp(),
    });

    logger.info(`Competition ${compId} active=${active}`);
    return { ok: true, compId, active };
  },
);
