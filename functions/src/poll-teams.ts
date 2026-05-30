import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { FOOTBALL_DATA_TOKEN } from './poll-football-data';
import {
  CompetitionContext,
  resolveCompetitionContexts,
  sleep,
} from './lib/competition-contexts';
import {
  FootballDataTeam,
  FootballDataTeamsResponse,
  TeamDoc,
  mapTeam,
  teamChanged,
} from './lib/team-mapper';

/** Politeness gap between per-competition requests, mirroring the fixtures
 *  and standings pollers, to stay under the free-tier 10 req/min cap. */
const INTER_REQUEST_DELAY_MS = 200;

/** Firestore caps a write batch at 500 ops. We chunk team writes below that
 *  with headroom so a many-competition poll can't overflow a single batch. */
const MAX_BATCH_OPS = 450;

interface CompetitionTeamsResult {
  compId: string;
  ok: boolean;
  fetched: number;
  error?: string;
}

export interface PollTeamsResult {
  ok: boolean;
  fetched: number;
  written: number;
  competitions: CompetitionTeamsResult[];
  message?: string;
}

/** Fetches one competition's teams (with squads) from football-data. Addresses
 *  the comp by its numeric `fdId` rather than our doc id — some comps have no
 *  textual code, and only the numeric id resolves against the API. */
async function fetchCompetitionTeams(
  token: string,
  ctx: CompetitionContext,
): Promise<readonly FootballDataTeam[]> {
  const res = await fetch(
    `https://api.football-data.org/v4/competitions/${ctx.fdId ?? ctx.id}/teams`,
    { headers: { 'X-Auth-Token': token } },
  );
  if (!res.ok) {
    const body = await res.text();
    logger.error(`[${ctx.id}] teams fetch failed`, { status: res.status, body });
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  const data = (await res.json()) as FootballDataTeamsResponse;
  logger.info(`[${ctx.id}] received ${data.teams.length} teams`);
  return data.teams;
}

/**
 * Inner poll logic, factored out so both the scheduled `pollTeams` and the
 * on-demand `devPollTeamsNow` dev callable can share it without duplicating
 * the fetch / diff / batch-write code path.
 *
 * Polls teams for every active competition (or one, when `compId` is given),
 * not just the World Cup. A club can appear in more than one active comp (its
 * domestic league and a continental cup), so teams are deduped by their
 * football-data id before any writes. Per-competition fetch failures don't
 * abort the run — they're logged and reported per-comp, and whatever teams
 * we did gather are still written.
 *
 * @returns Summary of the poll for logging or dev-callable responses.
 */
export async function runPollTeams(
  token: string,
  compId?: string,
): Promise<PollTeamsResult> {
  const db = getFirestore();
  const contexts = await resolveCompetitionContexts(db, compId);

  if (contexts.length === 0) {
    const message = compId
      ? `Competition ${compId} not found or has no current season`
      : 'No active competitions — toggle some in dev-tools';
    logger.warn(message);
    return { ok: true, fetched: 0, written: 0, competitions: [], message };
  }

  // Gather teams per competition, and separately dedupe by football-data team
  // id for the canonical-doc writes. A club can appear in several active comps
  // (its domestic league and a continental cup) — we write its canonical doc
  // once, but list it in each comp's rollup.
  const perComp: CompetitionTeamsResult[] = [];
  const byComp = new Map<string, { season: string; teams: readonly FootballDataTeam[] }>();
  const allById = new Map<number, FootballDataTeam>();
  for (let i = 0; i < contexts.length; i++) {
    const ctx = contexts[i];
    try {
      const teams = await fetchCompetitionTeams(token, ctx);
      byComp.set(ctx.id, { season: ctx.season, teams });
      for (const t of teams) allById.set(t.id, t);
      perComp.push({ compId: ctx.id, ok: true, fetched: teams.length });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      perComp.push({ compId: ctx.id, ok: false, fetched: 0, error: message });
    }

    // Politeness gap before the next competition. Skip after the last one.
    if (i < contexts.length - 1) {
      await sleep(INTER_REQUEST_DELAY_MS);
    }
  }

  const ok = perComp.every((c) => c.ok);

  if (allById.size === 0) {
    logger.warn('No teams gathered from any active competition');
    return { ok, fetched: 0, written: 0, competitions: perComp };
  }

  // Map every distinct team once, reuse for both the canonical diff-write and
  // the per-comp rollups.
  const mappedById = new Map<number, { id: string; doc: TeamDoc }>();
  for (const [externalId, t] of allById) {
    mappedById.set(externalId, { id: `fd-${t.id}`, doc: mapTeam(t) });
  }

  // Canonical docs: diff against existing, write only changed teams, chunked
  // under the 500-op batch limit.
  const distinct = [...mappedById.values()];
  const refs = distinct.map((m) => db.collection('teams').doc(m.id));
  const snapshots = await db.getAll(...refs);
  const existing = new Map<string, TeamDoc>();
  for (const s of snapshots) {
    if (s.exists) existing.set(s.id, s.data() as TeamDoc);
  }

  let writes = 0;
  let batch = db.batch();
  let ops = 0;
  for (const m of distinct) {
    if (!teamChanged(existing.get(m.id), m.doc)) continue;
    batch.set(
      db.collection('teams').doc(m.id),
      { ...m.doc, lastSyncedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    writes++;
    ops++;
    if (ops >= MAX_BATCH_OPS) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) {
    await batch.commit();
  }
  logger.info(writes > 0 ? `Updated ${writes} teams` : 'No team changes');

  // Per-comp rollups at `cache/teams-{compId}`: one doc per competition with
  // that comp's teams, so the client cold-fetches a comp's squad list in ONE
  // read. Per-comp (rather than one global rollup) keeps every doc well under
  // Firestore's 1 MiB limit no matter how many comps are active. Always
  // rewritten so a rollup never drifts from the canonical docs; isolated per
  // comp so one oversized/failed write can't sink the rest of the poll.
  for (const [compId, { season, teams }] of byComp) {
    const rollupTeams = teams.map((t) => {
      const m = mappedById.get(t.id);
      return { id: `fd-${t.id}`, ...(m ? m.doc : mapTeam(t)) };
    });
    try {
      await db.collection('cache').doc(`teams-${compId}`).set({
        competitionId: compId,
        season,
        teams: rollupTeams,
        count: rollupTeams.length,
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.info(`[${compId}] teams rollup updated with ${rollupTeams.length} teams`);
    } catch (e: unknown) {
      logger.error(`[${compId}] teams rollup write failed (canonical docs still written)`, {
        count: rollupTeams.length,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { ok, fetched: allById.size, written: writes, competitions: perComp };
}

/**
 * Hourly scheduled fetch of every active competition's teams — name, crest,
 * coach, full squad with positions and shirt numbers. One API call per comp
 * returns all of that comp's teams with squads included. Diff-skips unchanged
 * teams to avoid useless Firestore writes.
 */
export const pollTeams = onSchedule(
  {
    schedule: 'every 1 hours',
    region: 'europe-west1',
    secrets: [FOOTBALL_DATA_TOKEN],
    maxInstances: 1,
    timeoutSeconds: 120,
  },
  async () => {
    const token = FOOTBALL_DATA_TOKEN.value();
    if (!token) {
      logger.error('FOOTBALL_DATA_TOKEN secret missing');
      return;
    }
    await runPollTeams(token);
  },
);
