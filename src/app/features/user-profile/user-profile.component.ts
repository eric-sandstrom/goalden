import { NgOptimizedImage } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { DocumentData, Timestamp, doc, getDoc } from 'firebase/firestore';
import { FIRESTORE } from '../../core/firebase/firebase.providers';
import { AuthService } from '../../core/services/auth.service';
import { FixturesService } from '../../core/services/fixtures.service';
import { PersonalityService } from '../../core/services/personality.service';
import {
  MatchPrediction,
  PredictionsService,
} from '../../core/services/predictions.service';
import { Fixture, isLocked } from '../../core/models/fixture.model';
import { Personality } from '../../core/models/personality.model';
import { PodiumPick } from '../../core/models/podium.model';
import { UserTotals, parseTotals } from '../../core/services/user.service';
import { SkelComponent } from '../../shared/components/skel.component';
import { FixtureRowComponent } from '../predict/fixture-row.component';
import { PredictorPersonalityCardComponent } from '../profile/predictor-personality-card.component';

interface OtherUserDoc {
  readonly uid: string;
  readonly displayName: string;
  readonly photoURL: string | null;
  readonly totals: UserTotals;
}

@Component({
  selector: 'app-user-profile',
  imports: [
    NgOptimizedImage,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    SkelComponent,
    FixtureRowComponent,
    PredictorPersonalityCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './user-profile.component.html',
  styleUrl: './user-profile.component.scss',
})
export class UserProfileComponent {
  private readonly db = inject(FIRESTORE);
  private readonly auth = inject(AuthService);
  private readonly fixtures = inject(FixturesService);
  private readonly predictions = inject(PredictionsService);
  private readonly personalityService = inject(PersonalityService);

  /**
   * Hardcoded to WC for now — the public profile view shows a user's
   * locked predictions, and pre-multi-comp those are all WC. Once other
   * comps go live this becomes "comps the visited user has totals in"
   * derived from their `users/{uid}/totals/*` subcollection.
   */
  private readonly _wcFixtures = this.fixtures.fixturesFor('WC', '2026');

  /** Wired from the route param via withComponentInputBinding(). */
  readonly uid = input.required<string>();

  protected readonly otherUser = signal<OtherUserDoc | null>(null);
  protected readonly otherPredictions = signal<ReadonlyMap<string, MatchPrediction>>(new Map());
  protected readonly podiumPick = signal<PodiumPick | null>(null);
  /** Visited user's personality. Null until loaded; remains null if they
   *  have never generated one. The card renders an empty state in that
   *  case (no Generate button — owner-mode is false here). */
  protected readonly otherPersonality = signal<Personality | null>(null);
  protected readonly loaded = signal(false);

  constructor() {
    // /users/:uid is the public-profile surface for any user, including
    // the signed-in one — it shows their (locked) match predictions,
    // podium picks and totals. Editing yourself happens on /profile;
    // viewing yourself "from the outside" happens here.
    effect(() => {
      void this.loadAll(this.uid());
    });
  }

  /** Subset of fixtures that are locked (status !== TIMED) — the only ones
   *  we're allowed to read this user's predictions for. */
  protected readonly lockedFixtures = computed(() => {
    const now = new Date();
    return this._wcFixtures()
      .filter((f) => isLocked(f, now))
      .sort((a, b) => b.utcKickoff.getTime() - a.utcKickoff.getTime());
  });

  protected readonly predictionsSubtitle = computed(() => {
    const n = this.otherPredictions().size;
    if (n === 0) return 'No predictions on locked matches yet';
    return `${n} ${n === 1 ? 'prediction' : 'predictions'} on locked matches`;
  });

  protected predictionFor(matchId: string): MatchPrediction | null {
    return this.otherPredictions().get(matchId) ?? null;
  }

  protected teamName(teamId: number): string {
    return this.fixtures.teamsById().get(teamId)?.name ?? `Team ${teamId}`;
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  private async loadAll(uid: string): Promise<void> {
    this.loaded.set(false);
    this.otherPersonality.set(null);
    try {
      const [userOk] = await Promise.all([
        this.loadUserDoc(uid),
        this.loadLockedPredictions(uid),
        this.loadPodium(uid),
        this.loadPersonality(uid),
      ]);
      if (!userOk) {
        this.otherUser.set(null);
      }
    } catch (err) {
      console.error('[UserProfile] load failed', err);
    } finally {
      this.loaded.set(true);
    }
  }

  private async loadUserDoc(uid: string): Promise<boolean> {
    const snap = await getDoc(doc(this.db, 'users', uid));
    if (!snap.exists()) {
      this.otherUser.set(null);
      return false;
    }
    const data = snap.data();
    this.otherUser.set({
      uid,
      displayName: (data['displayName'] as string) ?? 'Unknown',
      photoURL: (data['photoURL'] as string) ?? null,
      totals: parseTotals(data['totals']),
    });
    return true;
  }

  /** Fetches one prediction doc per locked fixture in parallel. Non-existent
   *  predictions (user didn't predict that match) are skipped silently.
   *  Each read is rules-gated on the fixture being non-TIMED, which we
   *  guarantee by only iterating lockedFixtures(). */
  private async loadLockedPredictions(uid: string): Promise<void> {
    // Wait until fixtures are loaded so lockedFixtures() returns the full
    // list. The fixtures cache + live overlay populate the signal
    // asynchronously, so on a cold load we may arrive before data is in.
    if (this._wcFixtures().length === 0) {
      // Best effort — if fixtures haven't loaded yet, retry shortly.
      await new Promise((r) => setTimeout(r, 250));
    }
    const locked = this.lockedFixtures();
    const results = await Promise.all(
      locked.map(async (f) => {
        try {
          const snap = await getDoc(doc(this.db, `predictions/${uid}/matches/${f.id}`));
          if (!snap.exists()) return null;
          return parseMatchPrediction(f.id, snap.data());
        } catch {
          // Permission denied on a single doc → skip it.
          return null;
        }
      }),
    );
    const map = new Map<string, MatchPrediction>();
    for (const r of results) {
      if (r) map.set(r.matchId, r);
    }
    this.otherPredictions.set(map);
  }

  /** Loads the target user's AI-generated personality if they have one.
   *  Any signed-in user can read it via the open subcollection rule.
   *  Null result = never generated; the card renders an empty state. */
  private async loadPersonality(uid: string): Promise<void> {
    const result = await this.personalityService.getPersonality(uid);
    this.otherPersonality.set(result);
  }

  /** Loads the target user's podium picks if they've submitted any.
   *  Any signed-in user can read them via the relaxed rules, regardless
   *  of whether the podium lock date has passed. */
  private async loadPodium(uid: string): Promise<void> {
    try {
      const snap = await getDoc(doc(this.db, `predictions/${uid}/podium/picks`));
      if (!snap.exists()) return;
      const data = snap.data();
      const submitted = data['submittedAt'];
      this.podiumPick.set({
        winnerTeamId: data['winnerTeamId'],
        secondTeamId: data['secondTeamId'],
        thirdTeamId: data['thirdTeamId'],
        submittedAt: submitted instanceof Timestamp ? submitted.toDate() : null,
        points: data['points'] ?? null,
      });
    } catch {
      // Quietly ignore — podium might just not be set, or rules denied.
    }
  }
}

function parseMatchPrediction(matchId: string, data: DocumentData): MatchPrediction {
  const submittedAt = data['submittedAt'];
  return {
    matchId,
    homeScore: data['homeScore'] ?? 0,
    awayScore: data['awayScore'] ?? 0,
    submittedAt: submittedAt instanceof Timestamp ? submittedAt.toDate() : null,
    points: data['points'] ?? null,
  };
}
