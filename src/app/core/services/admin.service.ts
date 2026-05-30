import { Injectable, inject } from '@angular/core';
import { httpsCallable } from 'firebase/functions';
import { FUNCTIONS } from '../firebase/firebase.providers';

/** At-a-glance operational counts returned by the `getAdminMetrics`
 *  callable. Timestamps are epoch-millis (or null when unknown) so the
 *  client formats them however it likes. */
export interface AdminMetrics {
  readonly users: number;
  readonly predictions: number;
  readonly leagues: {
    readonly total: number;
    readonly global: number;
    readonly public: number;
    readonly private: number;
  };
  readonly competitions: { readonly total: number; readonly active: number };
  readonly lastFixturePoll: number | null;
  readonly lastLeaderboardRebuild: number | null;
}

/**
 * Thin gateway to the admin-only Cloud Functions that don't fit a domain
 * service (`LeaguesService` keeps the league callables). Every method here
 * hits a callable that re-checks the admin role server-side via
 * `requireAdminOrEmulator`, so this service is just transport.
 */
@Injectable({ providedIn: 'root' })
export class AdminService {
  private readonly functions = inject(FUNCTIONS);

  /** Correct a wrong/late full-time score on a FINISHED fixture and
   *  re-score every prediction by the resulting points delta. */
  async correctFixtureScore(
    matchId: string,
    homeScore: number,
    awayScore: number,
  ): Promise<{ rescored: number; winner: 'HOME' | 'AWAY' | 'DRAW' }> {
    const call = httpsCallable<
      { matchId: string; homeScore: number; awayScore: number },
      { ok: boolean; rescored: number; winner: 'HOME' | 'AWAY' | 'DRAW' }
    >(this.functions, 'correctFixtureScore');
    const res = await call({ matchId, homeScore, awayScore });
    return { rescored: res.data.rescored, winner: res.data.winner };
  }

  /** Push a one-off announcement to every registered device. */
  async broadcastNotification(
    title: string,
    body: string,
    link?: string,
  ): Promise<{ users: number; devices: number; sent: number; failed: number }> {
    const call = httpsCallable<
      { title: string; body: string; link?: string },
      { users: number; devices: number; sent: number; failed: number }
    >(this.functions, 'broadcastNotification');
    const res = await call({ title, body, link });
    return res.data;
  }

  /** Fetch operational counts for the admin dashboard. */
  async getMetrics(): Promise<AdminMetrics> {
    const call = httpsCallable<unknown, AdminMetrics>(this.functions, 'getAdminMetrics');
    const res = await call({});
    return res.data;
  }
}
