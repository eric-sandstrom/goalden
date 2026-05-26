import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { FOOTBALL_DATA_TOKEN } from './poll-football-data';
import {
  FootballDataTeamsResponse,
  TeamDoc,
  mapTeam,
  teamChanged,
} from './lib/team-mapper';

/**
 * Inner poll logic, factored out so both the scheduled `pollTeams` and the
 * on-demand `devPollTeamsNow` dev callable can share it without duplicating
 * the fetch / diff / batch-write code path.
 *
 * @returns Summary of the poll for logging or dev-callable responses.
 */
export async function runPollTeams(token: string): Promise<{
  ok: boolean;
  fetched: number;
  written: number;
  message?: string;
}> {
  const res = await fetch('https://api.football-data.org/v4/competitions/WC/teams', {
    headers: { 'X-Auth-Token': token },
  });
  if (!res.ok) {
    const body = await res.text();
    logger.error('football-data teams fetch failed', { status: res.status, body });
    return { ok: false, fetched: 0, written: 0, message: `HTTP ${res.status}: ${body}` };
  }

  const data = (await res.json()) as FootballDataTeamsResponse;
  logger.info(`Received ${data.teams.length} teams from football-data`);

  const db = getFirestore();
  const refs = data.teams.map((t) => db.collection('teams').doc(`fd-${t.id}`));
  const snapshots = refs.length > 0 ? await db.getAll(...refs) : [];
  const existing = new Map<string, TeamDoc>();
  for (const s of snapshots) {
    if (s.exists) existing.set(s.id, s.data() as TeamDoc);
  }

  const batch = db.batch();
  let writes = 0;
  for (const t of data.teams) {
    const next = mapTeam(t);
    const id = `fd-${t.id}`;
    if (teamChanged(existing.get(id), next)) {
      batch.set(
        db.collection('teams').doc(id),
        { ...next, lastSyncedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      writes++;
    }
  }

  if (writes > 0) {
    await batch.commit();
    logger.info(`Updated ${writes} teams`);
  } else {
    logger.info('No team changes');
  }

  // Rollup doc: a single document containing every team's data, used by the
  // client's TeamsService to cold-fetch the whole list in ONE Firestore read
  // instead of 48 (one per team doc). We always rewrite this — even when no
  // per-team doc changed — so the rollup never falls out of sync with the
  // canonical collection. The cost of overwriting is trivial (one write per
  // hour) compared to the read savings (~48× per client cold-cache miss).
  const rollupTeams = data.teams.map((t) => ({
    id: `fd-${t.id}`,
    ...mapTeam(t),
  }));
  await db.collection('cache').doc('teams').set({
    teams: rollupTeams,
    count: rollupTeams.length,
    updatedAt: FieldValue.serverTimestamp(),
  });
  logger.info(`Rollup updated with ${rollupTeams.length} teams`);

  return { ok: true, fetched: data.teams.length, written: writes };
}

/**
 * Hourly scheduled fetch of every World Cup team — name, crest, coach, full
 * squad with positions and shirt numbers. One API call returns all 48 teams
 * with their squads included, so this is comfortably under the free tier's
 * 10 requests/minute limit. Diff-skips unchanged teams to avoid useless
 * Firestore writes.
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
