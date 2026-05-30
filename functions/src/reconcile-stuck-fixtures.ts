import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as logger from 'firebase-functions/logger';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { FixtureDoc } from './lib/fixture-mapper';
import {
  FOOTBALL_DATA_TOKEN,
  MAX_MATCH_DURATION_MS,
  TERMINAL_STATUSES,
  runPollFootballData,
} from './poll-football-data';

/** How far back to bother reconciling. A fixture still non-terminal more
 *  than a day after kickoff is almost certainly abandoned/mislabelled at the
 *  provider and will never resolve — re-fetching it forever is wasteful, so
 *  we stop looking. (The admin `correctFixtureScore` callable is the manual
 *  escape hatch for those.) */
const RECONCILE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Safety net for fixtures that got stuck "live".
 *
 * The live poller (`pollFootballData`) only does work while a match sits in
 * the window `[now - MAX_MATCH_DURATION_MS, now + lookahead]`. That bound
 * keeps one wedged doc from pinning the poller in fast cadence forever — but
 * it also means a fixture still IN_PLAY/PAUSED more than `MAX_MATCH_DURATION`
 * after kickoff drops out of the window and stops being re-fetched. If
 * nothing else is live to trigger a poll, it stays stuck (never FINISHED, so
 * `scoreMatch` never fires and its predictions never score).
 *
 * This runs on a slow, independent cadence — so it can't reintroduce the
 * fast-cadence pin — finds those stragglers, and re-polls their
 * competition(s). `runPollFootballData` fetches the whole competition and
 * upserts changed fixtures, so once football-data has published the final
 * result the doc flips to FINISHED and scoring runs as normal. A single
 * bounded, single-field query gates the work: when nothing is stuck it costs
 * one tiny read and skips football-data entirely.
 */
export const reconcileStuckFixtures = onSchedule(
  {
    schedule: 'every 30 minutes',
    region: 'europe-west1',
    secrets: [FOOTBALL_DATA_TOKEN],
    maxInstances: 1,
    timeoutSeconds: 540,
  },
  async () => {
    const db = getFirestore();
    const now = Date.now();

    // Non-terminal fixtures that kicked off between MAX_MATCH_DURATION and
    // RECONCILE_LOOKBACK ago — past the live window (so the poller has given
    // up on them) but recent enough to still plausibly resolve. Range on a
    // single field (auto-indexed); status filtered in code to avoid a
    // composite index — same trick `isMatchWindow` uses.
    const lower = Timestamp.fromMillis(now - RECONCILE_LOOKBACK_MS);
    const upper = Timestamp.fromMillis(now - MAX_MATCH_DURATION_MS);
    const snap = await db
      .collection('fixtures')
      .where('utcKickoff', '>=', lower)
      .where('utcKickoff', '<=', upper)
      .limit(50)
      .get();

    const stuck = snap.docs.filter(
      (d) => !TERMINAL_STATUSES.has((d.data() as FixtureDoc).status),
    );
    if (stuck.length === 0) {
      logger.debug('reconcileStuckFixtures: nothing stuck');
      return;
    }

    const token = FOOTBALL_DATA_TOKEN.value();
    if (!token) {
      logger.error('reconcileStuckFixtures: FOOTBALL_DATA_TOKEN secret missing');
      return;
    }

    // Re-poll only the competitions that actually have a straggler. Missing
    // competitionId means a pre-multi-comp WC fixture (same default the
    // poller/scorer use).
    const comps = [...new Set(stuck.map((d) => (d.data() as FixtureDoc).competitionId ?? 'WC'))];
    logger.warn(
      `reconcileStuckFixtures: ${stuck.length} stuck fixture(s) across ${comps.length} comp(s) — re-polling`,
      { matchIds: stuck.map((d) => d.id), comps },
    );

    for (const compId of comps) {
      try {
        await runPollFootballData(token, compId);
      } catch (e: unknown) {
        // One comp failing must not block the others.
        logger.error(`reconcileStuckFixtures: re-poll failed for ${compId}`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  },
);
