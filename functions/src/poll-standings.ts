import * as logger from 'firebase-functions/logger';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import {
  CompetitionContext,
  resolveCompetitionContexts,
  sleep,
} from './lib/competition-contexts';
import {
  FootballDataStandingsResponse,
  StandingsTableDoc,
  mapStandings,
  standingsSignature,
} from './lib/standings-mapper';

/** Pause between competition fetches — same politeness gap the fixtures
 *  poller uses to stay clear of the free-tier 10 req/min burst cap. */
const INTER_REQUEST_DELAY_MS = 200;

interface CompetitionStandingsResult {
  readonly compId: string;
  readonly ok: boolean;
  /** Number of TOTAL tables persisted (1 for a league, N groups for a
   *  group-stage tournament, 0 for a knockout-only phase). */
  readonly tables: number;
  /** 1 if the rollup was rewritten this cycle, 0 if unchanged. */
  readonly written: number;
  /** True when football-data has no standings for this comp (404) or doesn't
   *  grant us access (403, paid tier). Not a failure — `ok` stays true. */
  readonly skipped?: boolean;
  readonly error?: string;
}

export interface StandingsPollSummary {
  readonly ok: boolean;
  readonly tables: number;
  readonly written: number;
  readonly competitions: readonly CompetitionStandingsResult[];
  readonly message?: string;
}

/**
 * Inner standings-poll logic, shared by the scheduled `pollStandings` cron
 * and the on-demand `devPollStandingsNow` dev callable.
 *
 * Mirrors the fixtures poller: resolve the (comp, season) contexts (one
 * explicit comp, or every active comp), fetch each comp's standings in
 * sequence with a politeness delay, and write a per-comp rollup at
 * `cache/standings-{compId}`. Per-comp failures (e.g. a paid-tier comp
 * returning 403) are logged and don't abort the loop.
 *
 * Standings change far less often than fixtures, so each write is gated on
 * a content signature — unchanged tables are skipped to avoid needless
 * writes and `updatedAt` churn.
 */
export async function runPollStandings(
  token: string,
  compId?: string,
): Promise<StandingsPollSummary> {
  const db = getFirestore();
  const contexts = await resolveCompetitionContexts(db, compId);

  if (contexts.length === 0) {
    const message = compId
      ? `Competition ${compId} not found or has no current season`
      : 'No active competitions — toggle some in dev-tools';
    logger.warn(message);
    return { ok: true, tables: 0, written: 0, competitions: [], message };
  }

  const perComp: CompetitionStandingsResult[] = [];
  let totalTables = 0;
  let totalWritten = 0;

  for (let i = 0; i < contexts.length; i++) {
    const ctx = contexts[i];
    try {
      const result = await pollOneCompetitionStandings(token, ctx);
      perComp.push(result);
      totalTables += result.tables;
      totalWritten += result.written;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error(`[${ctx.id}] standings poll failed`, { error: message });
      perComp.push({ compId: ctx.id, ok: false, tables: 0, written: 0, error: message });
    }

    if (i < contexts.length - 1) {
      await sleep(INTER_REQUEST_DELAY_MS);
    }
  }

  logger.info(
    `Polled standings for ${contexts.length} competition(s) — ${totalTables} tables, wrote ${totalWritten}`,
    { competitions: perComp.map((c) => ({ id: c.compId, ok: c.ok, written: c.written })) },
  );

  return {
    ok: perComp.every((c) => c.ok),
    tables: totalTables,
    written: totalWritten,
    competitions: perComp,
  };
}

/** Fetches one competition's standings and refreshes its rollup doc when
 *  the table content has changed. We address the comp by its football-data
 *  numeric id (`fdId`) rather than our doc id — some comps have no textual
 *  code, and only the numeric id resolves against the API. */
async function pollOneCompetitionStandings(
  token: string,
  ctx: CompetitionContext,
): Promise<CompetitionStandingsResult> {
  const res = await fetch(
    `https://api.football-data.org/v4/competitions/${ctx.fdId ?? ctx.id}/standings`,
    { headers: { 'X-Auth-Token': token } },
  );
  // Some comps simply have no standings on our tier: a 404 (no standings
  // resource — e.g. Superettan's stale free-tier season) or a 403 (comp
  // gated behind a paid plan). Neither is a real failure; skip quietly so
  // one such comp can't make the whole poll report `ok: false`.
  if (res.status === 404 || res.status === 403) {
    logger.warn(`[${ctx.id}] no standings available (HTTP ${res.status}) — skipping`);
    return { compId: ctx.id, ok: true, tables: 0, written: 0, skipped: true };
  }
  if (!res.ok) {
    const body = await res.text();
    logger.error(`[${ctx.id}] standings fetch failed`, { status: res.status, body });
    return {
      compId: ctx.id,
      ok: false,
      tables: 0,
      written: 0,
      error: `HTTP ${res.status}: ${body}`,
    };
  }

  const data = (await res.json()) as FootballDataStandingsResponse;
  const tables = mapStandings(data);
  logger.info(`[${ctx.id}] received ${tables.length} standings table(s)`);

  const db = getFirestore();
  const ref = db.collection('cache').doc(`standings-${ctx.id}`);

  // Skip the write when nothing material changed since last poll.
  const existing = await ref.get();
  if (existing.exists) {
    const prior = (existing.data()?.['standings'] ?? []) as StandingsTableDoc[];
    if (standingsSignature(prior) === standingsSignature(tables)) {
      return { compId: ctx.id, ok: true, tables: tables.length, written: 0 };
    }
  }

  await ref.set({
    competitionId: ctx.id,
    season: ctx.season,
    standings: tables,
    count: tables.length,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { compId: ctx.id, ok: true, tables: tables.length, written: 1 };
}

// The 30-minute `pollStandings` scheduler was retired. Standings now refresh
// (a) once when a competition is activated / re-synced (see sync-competitions.ts)
// and (b) event-driven whenever a match in that comp finishes (see score-match.ts),
// both via `runPollStandings(token, compId)`. `devPollStandingsNow` still wraps
// the same helper for on-demand runs.
