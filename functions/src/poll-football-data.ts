import { defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import {
  FixtureDoc,
  FootballDataMatch,
  FootballDataResponse,
  fixtureChanged,
  mapFixture,
} from './lib/fixture-mapper';

export const FOOTBALL_DATA_TOKEN = defineSecret('FOOTBALL_DATA_TOKEN');

/**
 * Inner poll logic, factored out so both the scheduled `pollFootballData`
 * and the on-demand `devPollFixturesNow` dev callable share the same fetch /
 * diff / write / rollup pipeline without duplication.
 *
 * @returns Summary for logs and dev-callable responses.
 */
export async function runPollFootballData(token: string): Promise<{
  ok: boolean;
  fetched: number;
  written: number;
  message?: string;
}> {
  const res = await fetch('https://api.football-data.org/v4/competitions/WC/matches', {
    headers: { 'X-Auth-Token': token },
  });
  if (!res.ok) {
    const body = await res.text();
    logger.error('football-data fetch failed', { status: res.status, body });
    return { ok: false, fetched: 0, written: 0, message: `HTTP ${res.status}: ${body}` };
  }

  const data = (await res.json()) as FootballDataResponse;
  logger.info(`Received ${data.matches.length} matches from football-data`);

  const db = getFirestore();
  const refs = data.matches.map((m) => db.collection('fixtures').doc(`fd-${m.id}`));
  const snapshots = refs.length > 0 ? await db.getAll(...refs) : [];
  const existing = new Map<string, FixtureDoc>();
  for (const s of snapshots) {
    if (s.exists) existing.set(s.id, s.data() as FixtureDoc);
  }

  const batch = db.batch();
  let writes = 0;
  for (let i = 0; i < data.matches.length; i++) {
    const m = data.matches[i] as FootballDataMatch;
    const next = mapFixture(m);
    const id = `fd-${m.id}`;
    if (fixtureChanged(existing.get(id), next)) {
      batch.set(
        db.collection('fixtures').doc(id),
        { ...next, lastSyncedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      writes++;
    }
  }

  if (writes > 0) {
    await batch.commit();
    logger.info(`Updated ${writes} fixtures`);
  } else {
    logger.info('No fixture changes');
  }

  // Rollup doc — same approach as cache/teams. Lets the client read all
  // 104 fixtures in ONE Firestore read instead of N. We always rewrite the
  // rollup on every poll so it can't drift from the canonical per-fixture
  // docs (cheaper to overwrite than to detect "did any field change"
  // across the whole collection).
  const rollup = data.matches.map((m) => ({
    id: `fd-${m.id}`,
    ...mapFixture(m),
  }));
  await db.collection('cache').doc('fixtures').set({
    fixtures: rollup,
    count: rollup.length,
    updatedAt: FieldValue.serverTimestamp(),
  });
  logger.info(`Fixtures rollup updated with ${rollup.length} fixtures`);

  return { ok: true, fetched: data.matches.length, written: writes };
}

export const pollFootballData = onSchedule(
  {
    schedule: 'every 10 minutes',
    region: 'europe-west1',
    secrets: [FOOTBALL_DATA_TOKEN],
    maxInstances: 1,
    timeoutSeconds: 60,
  },
  async () => {
    const token = FOOTBALL_DATA_TOKEN.value();
    if (!token) {
      logger.error('FOOTBALL_DATA_TOKEN secret missing');
      return;
    }
    await runPollFootballData(token);
  },
);
