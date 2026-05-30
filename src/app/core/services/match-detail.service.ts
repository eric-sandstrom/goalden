import { Injectable, inject } from '@angular/core';
import { Timestamp, doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { FIRESTORE, FUNCTIONS } from '../firebase/firebase.providers';
import {
  MatchBooking,
  MatchDetail,
  MatchGoal,
  MatchLineup,
  MatchReferee,
  MatchSubstitution,
} from '../models/match-detail.model';

/**
 * Reads + refreshes the rich per-match detail doc at
 * `fixtures/{matchId}/detail/full`. The doc is populated only on demand by
 * the `refreshMatchDetail` callable (the schedulers never fetch it), so a
 * fixture has no detail until someone taps refresh on the fixture-detail view.
 *
 * `loadDetail` is a pure one-shot read (backs the view's `resource()`);
 * `refreshDetail` invokes the callable, after which the caller re-reads via
 * `loadDetail` to pick up the freshly-written doc.
 */
@Injectable({ providedIn: 'root' })
export class MatchDetailService {
  private readonly db = inject(FIRESTORE);
  private readonly functions = inject(FUNCTIONS);

  /** One-shot read of the detail doc. Returns null when it hasn't been
   *  fetched yet. */
  async loadDetail(matchId: string): Promise<MatchDetail | null> {
    const snap = await getDoc(doc(this.db, 'fixtures', matchId, 'detail', 'full'));
    if (!snap.exists()) return null;
    return mapDetail(snap.data());
  }

  /**
   * Triggers a server-side fetch of football-data's `/v4/matches/{id}` detail
   * into the doc. Resolves once the callable returns; `throttled` is true when
   * the server served a recent fetch without hitting the API. Callers should
   * re-read with `loadDetail` afterwards to render the result.
   */
  async refreshDetail(matchId: string): Promise<{ throttled: boolean }> {
    const call = httpsCallable<{ matchId: string }, { ok: boolean; throttled: boolean }>(
      this.functions,
      'refreshMatchDetail',
    );
    const res = await call({ matchId });
    return { throttled: res.data.throttled };
  }
}

function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value && typeof value === 'object' && 'seconds' in value && 'nanoseconds' in value) {
    const { seconds, nanoseconds } = value as { seconds: number; nanoseconds: number };
    return new Date(seconds * 1000 + nanoseconds / 1_000_000);
  }
  return null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? (value.filter((e) => e && typeof e === 'object') as Record<string, unknown>[])
    : [];
}

function mapLineup(value: unknown): MatchLineup {
  const o = (value ?? {}) as Record<string, unknown>;
  const players = (raw: unknown) =>
    asArray(raw).map((p) => ({
      id: (p['id'] as number) ?? null,
      name: (p['name'] as string) ?? null,
      position: (p['position'] as string) ?? null,
      shirtNumber: (p['shirtNumber'] as number) ?? null,
    }));
  return {
    formation: (o['formation'] as string) ?? null,
    coach: (o['coach'] as MatchLineup['coach']) ?? null,
    lineup: players(o['lineup']),
    bench: players(o['bench']),
  };
}

/** Adapts the raw Firestore detail doc into the typed `MatchDetail`. The
 *  arrays are stored exactly as the backend mapper produced them, so they
 *  pass through; only timestamps need converting. */
function mapDetail(data: Record<string, unknown>): MatchDetail {
  const score = (data['score'] ?? {}) as Record<string, unknown>;
  const line = (v: unknown) => (v as { home: number | null; away: number | null } | null) ?? null;
  return {
    homeTeamId: (data['homeTeamId'] as number) ?? null,
    awayTeamId: (data['awayTeamId'] as number) ?? null,
    score: {
      winner: (score['winner'] as string) ?? null,
      duration: (score['duration'] as string) ?? null,
      fullTime: line(score['fullTime']),
      halfTime: line(score['halfTime']),
      regularTime: line(score['regularTime']),
      extraTime: line(score['extraTime']),
      penalties: line(score['penalties']),
    },
    goals: asArray(data['goals']) as unknown as MatchGoal[],
    bookings: asArray(data['bookings']) as unknown as MatchBooking[],
    substitutions: asArray(data['substitutions']) as unknown as MatchSubstitution[],
    referees: asArray(data['referees']) as unknown as MatchReferee[],
    home: mapLineup(data['home']),
    away: mapLineup(data['away']),
    venue: (data['venue'] as string) ?? null,
    attendance: (data['attendance'] as number) ?? null,
    detailSyncedAt: toDate(data['detailSyncedAt']),
  };
}
