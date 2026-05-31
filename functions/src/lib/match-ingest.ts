import { FieldValue } from 'firebase-admin/firestore';
import {
  FixtureDoc,
  FixtureMapContext,
  FootballDataMatch,
  fixtureChanged,
  mapFixture,
} from './fixture-mapper';
import { MatchDetailDoc, mapMatchDetail } from './match-detail-mapper';

/**
 * Shared ingestion helpers for the football-data match endpoints.
 *
 * Sending the four `X-Unfold-*` headers makes the match-LIST responses
 * (`/v4/matches` and `/v4/competitions/{id}/matches`) carry the same rich
 * payload the single-match endpoint does — goals, bookings, substitutions and
 * lineups. So a single list request now yields BOTH our docs: the lean
 * `fixtures/{id}` (list-facing fields + live clock) via `mapFixture`, and the
 * rich `fixtures/{id}/detail/full` via `mapMatchDetail`. `stageMatchWrite`
 * splits one raw match into those two writes; the bulk live poll, the per-comp
 * full sync and competition activation all share it.
 */

type Json = Record<string, unknown>;

/** Auth token + the four unfold headers. One place so every match fetch agrees. */
export function matchHeaders(token: string): Record<string, string> {
  return {
    'X-Auth-Token': token,
    'X-Unfold-Goals': 'true',
    'X-Unfold-Bookings': 'true',
    'X-Unfold-Lineups': 'true',
    'X-Unfold-Subs': 'true',
  };
}

// --- detailChanged (moved here from poll-live-detail so every writer shares it) ---

function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function len(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

/**
 * True when the freshly-mapped detail differs from what's stored in a way worth
 * a write. Compares event/lineup counts (events only grow) and the full-time
 * score — enough to catch a new goal/card/sub, lineups appearing, or the final
 * landing, without deep-diffing every field on every poll.
 */
export function detailChanged(existing: Json | null, next: MatchDetailDoc): boolean {
  if (!existing) return true;
  if (len(existing['goals']) !== next.goals.length) return true;
  if (len(existing['bookings']) !== next.bookings.length) return true;
  if (len(existing['substitutions']) !== next.substitutions.length) return true;
  const eh = obj(existing['home']);
  const ea = obj(existing['away']);
  if (len(eh?.['lineup']) !== next.home.lineup.length) return true;
  if (len(ea?.['lineup']) !== next.away.lineup.length) return true;
  if (len(eh?.['bench']) !== next.home.bench.length) return true;
  if (len(ea?.['bench']) !== next.away.bench.length) return true;
  const es = obj(existing['score']) ?? {};
  if (str(es['winner']) !== next.score.winner) return true;
  const eft = obj(es['fullTime']);
  if (num(eft?.['home']) !== (next.score.fullTime?.home ?? null)) return true;
  if (num(eft?.['away']) !== (next.score.fullTime?.away ?? null)) return true;
  return false;
}

/**
 * True when the mapped detail actually carries something worth a subdoc —
 * any event, lineup, bench or referee. A scheduled future match with none of
 * these (the common case on a freshly-activated season) skips the write, so we
 * don't create hundreds of empty `detail/full` docs; the detail appears once a
 * lineup/events show up (live poll) or the match finishes.
 */
export function detailHasContent(detail: MatchDetailDoc): boolean {
  return (
    detail.goals.length > 0 ||
    detail.bookings.length > 0 ||
    detail.substitutions.length > 0 ||
    detail.referees.length > 0 ||
    detail.home.lineup.length > 0 ||
    detail.away.lineup.length > 0 ||
    detail.home.bench.length > 0 ||
    detail.away.bench.length > 0
  );
}

/**
 * True when a raw match would produce a detail write — it's terminal or
 * already carries detail content. Lets a caller pre-filter which fixtures'
 * existing detail docs to read (see `readDetailDocs`) without reading the rest.
 */
export function matchNeedsDetail(raw: FootballDataMatch, ctx?: FixtureMapContext): boolean {
  const status = mapFixture(raw, ctx).status;
  const terminal = status === 'FINISHED' || status === 'AWARDED';
  return terminal || detailHasContent(mapMatchDetail(raw));
}

/**
 * Reads the existing `fixtures/{id}/detail/full` docs for the given fixture
 * ids, chunked under Firestore's getAll limits, into an `id -> data|null` map
 * (null = no doc yet). Callers pass only the ids that will actually write
 * detail (terminal/with-content), so a season of empty future fixtures costs
 * no reads. Used to dedup detail writes via `detailChanged`.
 */
export async function readDetailDocs(
  db: FirebaseFirestore.Firestore,
  ids: readonly string[],
): Promise<Map<string, Json | null>> {
  const out = new Map<string, Json | null>();
  const CHUNK = 300;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const refs = slice.map((id) =>
      db.collection('fixtures').doc(id).collection('detail').doc('full'),
    );
    const snaps = refs.length > 0 ? await db.getAll(...refs) : [];
    snaps.forEach((s, j) => out.set(slice[j], s.exists ? (s.data() ?? {}) : null));
  }
  return out;
}

export interface MatchWriteResult {
  readonly leanWritten: boolean;
  readonly detailWritten: boolean;
}

/**
 * Stages the writes for one raw (unfolded) football-data match on `batch`:
 *
 *  - The lean `fixtures/{id}` doc (list fields + live clock), gated by
 *    `fixtureChanged`. The `lineupCaptured`/`finalCaptured` capture flags are
 *    folded in only when they newly flip true, so a steady-state poll doesn't
 *    churn the doc (and its rollup).
 *  - The rich `fixtures/{id}/detail/full` doc, gated by `detailChanged` and
 *    written only when the match is terminal or actually has detail content.
 *
 * The lean doc carries NO rich arrays — those live exclusively in detail/full.
 * Returns which docs were staged so the caller can count writes.
 */
export function stageMatchWrite(
  db: FirebaseFirestore.Firestore,
  batch: FirebaseFirestore.WriteBatch,
  id: string,
  raw: FootballDataMatch,
  ctx: FixtureMapContext,
  existing: FixtureDoc | undefined,
  existingDetail: Json | null,
): MatchWriteResult {
  const next = mapFixture(raw, ctx);
  const detail = mapMatchDetail(raw);
  const terminal = next.status === 'FINISHED' || next.status === 'AWARDED';
  const lineupNow = detail.home.lineup.length > 0 || detail.away.lineup.length > 0;

  const fixtureRef = db.collection('fixtures').doc(id);

  let leanWritten = false;
  const leanPatch: Record<string, unknown> = {};
  if (fixtureChanged(existing, next)) {
    Object.assign(leanPatch, next, { lastSyncedAt: FieldValue.serverTimestamp() });
  }
  if (lineupNow && existing?.lineupCaptured !== true) leanPatch['lineupCaptured'] = true;
  if (terminal && existing?.finalCaptured !== true) leanPatch['finalCaptured'] = true;
  if (Object.keys(leanPatch).length > 0) {
    batch.set(fixtureRef, leanPatch, { merge: true });
    leanWritten = true;
  }

  // Once a match's closing detail is captured it never changes again, so skip
  // it entirely — no read, no write — on every subsequent poll.
  const detailAlreadyFinal = existing?.finalCaptured === true;

  let detailWritten = false;
  if (
    !detailAlreadyFinal &&
    (terminal || detailHasContent(detail)) &&
    detailChanged(existingDetail, detail)
  ) {
    batch.set(
      fixtureRef.collection('detail').doc('full'),
      { ...detail, detailSyncedAt: FieldValue.serverTimestamp(), finalCaptured: terminal },
      { merge: false },
    );
    detailWritten = true;
  }

  return { leanWritten, detailWritten };
}
