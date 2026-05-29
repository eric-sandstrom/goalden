import * as logger from 'firebase-functions/logger';

/**
 * ESPN public-scoreboard helpers for the live-score overlay.
 *
 * ESPN exposes an undocumented but public JSON backend (the one espn.com
 * itself calls) with no key and no auth. We use it ONLY as a best-effort
 * live-score layer for display — never as a source of truth. The poller
 * writes the parsed values into `live*` fields on the fixture doc; the
 * authoritative `score`/`status`/`winner` always come from football-data,
 * and scoring never reads the `live*` fields. A wrong, stale, or missing
 * ESPN value can therefore never affect points.
 *
 * This module is deliberately free of any Firestore / FixtureDoc
 * dependency: it just fetches, parses, and builds the natural key used to
 * reconcile ESPN's id space with ours. The Firestore I/O lives in the
 * poller (see pollEspnLive in poll-football-data.ts).
 */

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

/**
 * Maps our competition shortcodes to ESPN soccer league slugs. Comps absent
 * from this map skip the live overlay entirely (no fetch, no writes). Add an
 * entry to switch a comp on — e.g. EC → 'uefa.euro', CL → 'uefa.champions',
 * PL → 'eng.1'. Kept as a static map rather than a competitions/{id} doc
 * field to avoid a data migration; promote it to a doc field later if the
 * mapping needs to be editable without a deploy.
 */
const ESPN_SLUG_BY_COMP: Readonly<Record<string, string>> = {
  WC: 'fifa.world',
};

export function getEspnSlug(compId: string): string | undefined {
  return ESPN_SLUG_BY_COMP[compId];
}

// ---------------------------------------------------------------------------
// API shape (the subset of ESPN's scoreboard response we read). Everything
// is optional because it's an unofficial endpoint that can change shape — we
// parse defensively and bail to null rather than throw.
// ---------------------------------------------------------------------------

interface EspnStatusType {
  readonly state?: string; // 'pre' | 'in' | 'post'
  readonly completed?: boolean;
  readonly description?: string; // e.g. 'In Progress', 'Final'
  readonly shortDetail?: string; // e.g. "67'", 'HT', 'FT'
}

interface EspnStatus {
  readonly displayClock?: string; // e.g. "67'"
  readonly type?: EspnStatusType;
}

interface EspnCompetitor {
  readonly homeAway?: string; // 'home' | 'away'
  readonly score?: string | number;
  readonly team?: { readonly abbreviation?: string; readonly displayName?: string };
}

interface EspnCompetition {
  readonly competitors?: readonly EspnCompetitor[];
  readonly status?: EspnStatus;
}

export interface EspnEvent {
  readonly id?: string | number;
  readonly date?: string; // ISO UTC, e.g. '2026-06-11T19:00Z'
  readonly status?: EspnStatus;
  readonly competitions?: readonly EspnCompetition[];
}

interface EspnScoreboard {
  readonly events?: readonly EspnEvent[];
}

// ---------------------------------------------------------------------------
// Parsed shapes
// ---------------------------------------------------------------------------

/** Display-only live snapshot extracted from one ESPN event. */
export interface LiveSnapshot {
  readonly score: { home: number; away: number } | null; // null until kickoff
  readonly state: 'pre' | 'in' | 'post';
  readonly clock: string | null; // e.g. "67'", null when not playing
  readonly detail: string | null; // e.g. 'HT', 'Final', "67' - 1st Half"
}

export interface MappedEspnEvent {
  readonly eventId: string;
  /** naturalKey(date, homeCode, awayCode) — the cross-provider join key. */
  readonly key: string;
  readonly homeCode: string;
  readonly awayCode: string;
  readonly live: LiveSnapshot;
}

/**
 * The cross-provider join key. ESPN and football-data have disjoint id
 * spaces, so we reconcile a match by what both report identically: the UTC
 * match day plus the unordered pair of FIFA 3-letter codes. The pair alone
 * is unique within a single day's fixtures; adding the day guards against a
 * pair meeting twice across a tournament (always on different days). Both
 * providers emit scheduled kickoffs as the same UTC instant, so the day
 * slice agrees.
 */
export function naturalKey(dateIso: string, codeA: string, codeB: string): string {
  const day = dateIso.slice(0, 10); // YYYY-MM-DD in UTC
  const pair = [codeA.toUpperCase().trim(), codeB.toUpperCase().trim()].sort().join('-');
  return `${day}|${pair}`;
}

function normaliseState(raw: string | undefined): 'pre' | 'in' | 'post' {
  if (raw === 'in') return 'in';
  if (raw === 'post') return 'post';
  return 'pre';
}

function parseScore(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses one ESPN event into a MappedEspnEvent, or null when it can't be
 * matched/used — missing id, missing date, or missing either team
 * abbreviation (TBD knockout slots, malformed payloads). Returning null
 * makes the event simply invisible to the matcher rather than crashing the
 * pass.
 */
export function mapEspnEvent(event: EspnEvent): MappedEspnEvent | null {
  const eventId = event.id != null ? String(event.id) : null;
  const date = typeof event.date === 'string' ? event.date : null;
  if (!eventId || !date) return null;

  const comp = event.competitions?.[0];
  const competitors = comp?.competitors ?? [];
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');
  const homeCode = home?.team?.abbreviation?.toUpperCase().trim();
  const awayCode = away?.team?.abbreviation?.toUpperCase().trim();
  if (!homeCode || !awayCode) return null; // can't natural-key without both

  const status = comp?.status ?? event.status;
  const state = normaliseState(status?.type?.state);
  const clock = typeof status?.displayClock === 'string' ? status.displayClock : null;
  const detail = status?.type?.shortDetail ?? status?.type?.description ?? null;

  let score: { home: number; away: number } | null = null;
  if (state !== 'pre') {
    const h = parseScore(home?.score);
    const a = parseScore(away?.score);
    if (h !== null && a !== null) score = { home: h, away: a };
  }

  return {
    eventId,
    key: naturalKey(date, homeCode, awayCode),
    homeCode,
    awayCode,
    live: { score, state, clock, detail },
  };
}

/**
 * Fetches one ESPN soccer scoreboard (the current matchday for the league).
 * Never throws: any network/HTTP/parse failure logs a warning and returns an
 * empty list so the overlay degrades to "no live data" rather than breaking
 * the poll run.
 */
export async function fetchEspnScoreboard(slug: string): Promise<readonly EspnEvent[]> {
  try {
    const res = await fetch(`${ESPN_BASE}/${slug}/scoreboard`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      logger.warn(`[espn] scoreboard ${slug} HTTP ${res.status}`);
      return [];
    }
    const data = (await res.json()) as EspnScoreboard;
    return data.events ?? [];
  } catch (e: unknown) {
    logger.warn(`[espn] scoreboard ${slug} fetch failed`, {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}
