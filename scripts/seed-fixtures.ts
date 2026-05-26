/**
 * Goalden — one-time fixtures seed.
 *
 * Fetches all 104 World Cup 2026 matches from football-data.org and writes
 * them to Firestore. Defaults to the local emulator; pass --target=prod to
 * write to production (requires GOOGLE_APPLICATION_CREDENTIALS).
 *
 * Usage:
 *   npm run seed:fixtures              # writes to emulator (default)
 *   npm run seed:fixtures -- --target=prod
 */

import 'dotenv/config';
import { cert, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

const FOOTBALL_DATA_TOKEN = process.env['FOOTBALL_DATA_TOKEN'];
if (!FOOTBALL_DATA_TOKEN) {
  console.error('Error: FOOTBALL_DATA_TOKEN not set. Create a .env file at the project root.');
  process.exit(1);
}

const target = process.argv.includes('--target=prod') ? 'prod' : 'emulator';

if (target === 'emulator') {
  process.env['FIRESTORE_EMULATOR_HOST'] = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080';
  console.log(`Target: emulator (${process.env['FIRESTORE_EMULATOR_HOST']})`);
} else {
  if (!process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
    console.error(
      'Error: --target=prod requires GOOGLE_APPLICATION_CREDENTIALS pointing to a service account key.',
    );
    process.exit(1);
  }
  console.log('Target: PRODUCTION Firestore');
}

initializeApp({ projectId: 'goalden-693dc' });
const db = getFirestore();

interface FootballDataMatch {
  readonly id: number;
  readonly utcDate: string;
  readonly status: string;
  readonly stage: string;
  readonly group: string | null;
  readonly homeTeam: { id: number | null; name: string | null; tla: string | null; crest: string | null };
  readonly awayTeam: { id: number | null; name: string | null; tla: string | null; crest: string | null };
  readonly score: {
    winner: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
    fullTime: { home: number | null; away: number | null };
  };
}

interface FootballDataResponse {
  readonly matches: readonly FootballDataMatch[];
  readonly resultSet?: { count: number };
}

const STAGE_MAP: Record<string, string> = {
  GROUP_STAGE: 'GROUP',
  LAST_32: 'R32',
  LAST_16: 'R16',
  QUARTER_FINALS: 'QF',
  SEMI_FINALS: 'SF',
  FINAL: 'F',
  THIRD_PLACE: 'THIRD_PLACE',
};

const STATUS_MAP: Record<string, string> = {
  SCHEDULED: 'TIMED',
  TIMED: 'TIMED',
  IN_PLAY: 'IN_PLAY',
  PAUSED: 'PAUSED',
  FINISHED: 'FINISHED',
  POSTPONED: 'POSTPONED',
  CANCELLED: 'CANCELLED',
  AWARDED: 'AWARDED',
  SUSPENDED: 'POSTPONED',
};

function mapWinner(w: string | null): 'HOME' | 'AWAY' | 'DRAW' | null {
  if (w === 'HOME_TEAM') return 'HOME';
  if (w === 'AWAY_TEAM') return 'AWAY';
  if (w === 'DRAW') return 'DRAW';
  return null;
}

function mapGroup(g: string | null): string | null {
  if (!g) return null;
  return g.replace(/^GROUP_/, '');
}

async function main(): Promise<void> {
  console.log('Fetching World Cup fixtures from football-data.org...');

  const res = await fetch('https://api.football-data.org/v4/competitions/WC/matches', {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN! },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`football-data.org returned ${res.status}: ${body}`);
  }

  const data = (await res.json()) as FootballDataResponse;
  console.log(`Received ${data.matches.length} matches.`);

  const counts: Record<string, number> = {};
  for (const m of data.matches) {
    const stage = STAGE_MAP[m.stage] ?? m.stage;
    counts[stage] = (counts[stage] ?? 0) + 1;
  }
  console.log('Matches by stage:', counts);

  if (data.matches.length === 0) {
    console.error('No matches returned. Aborting.');
    process.exit(1);
  }

  const batch = db.batch();
  for (const m of data.matches) {
    const ref = db.collection('fixtures').doc(`fd-${m.id}`);
    const fullTime = m.score.fullTime;
    batch.set(ref, {
      homeTeam: {
        id: m.homeTeam.id,
        name: m.homeTeam.name,
        tla: m.homeTeam.tla,
        crest: m.homeTeam.crest,
      },
      awayTeam: {
        id: m.awayTeam.id,
        name: m.awayTeam.name,
        tla: m.awayTeam.tla,
        crest: m.awayTeam.crest,
      },
      utcKickoff: Timestamp.fromDate(new Date(m.utcDate)),
      status: STATUS_MAP[m.status] ?? 'TIMED',
      stage: STAGE_MAP[m.stage] ?? m.stage,
      group: mapGroup(m.group),
      score: {
        fullTime:
          fullTime.home !== null && fullTime.away !== null
            ? { home: fullTime.home, away: fullTime.away }
            : null,
        winner: mapWinner(m.score.winner),
      },
      lastSyncedAt: FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  console.log(`Wrote ${data.matches.length} fixtures to ${target}.`);
}

main().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
