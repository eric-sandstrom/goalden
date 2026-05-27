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
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { DocumentData, Timestamp, doc, getDoc } from 'firebase/firestore';
import { FIRESTORE } from '../../core/firebase/firebase.providers';
import { AuthService } from '../../core/services/auth.service';
import { FixturesService } from '../../core/services/fixtures.service';
import {
  MatchPrediction,
  PredictionsService,
} from '../../core/services/predictions.service';
import { Fixture, isLocked } from '../../core/models/fixture.model';
import { PODIUM_LOCK, PodiumPick } from '../../core/models/podium.model';
import { UserTotals, parseTotals } from '../../core/services/user.service';
import { SkelComponent } from '../../shared/components/skel.component';
import { FixtureRowComponent } from '../predict/fixture-row.component';

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
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    SkelComponent,
    FixtureRowComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <a mat-button routerLink="/leagues" class="back-link">
        <mat-icon>arrow_back</mat-icon>
        Back
      </a>

      @if (!loaded()) {
        <mat-card appearance="outlined" class="hero-card">
          <mat-card-header>
            <app-skel width="56px" height="56px" rounded />
            <div class="skel-hdr">
              <app-skel width="60%" height="1.5rem" block />
              <div style="height: 6px;"></div>
              <app-skel width="40%" height="1rem" block />
            </div>
          </mat-card-header>
        </mat-card>
      } @else if (otherUser(); as u) {
        <!-- Hero card -->
        <mat-card appearance="outlined" class="hero-card">
          <mat-card-header>
            @if (u.photoURL) {
              <img
                matCardAvatar
                [ngSrc]="u.photoURL"
                width="56"
                height="56"
                [alt]="u.displayName + ' avatar'"
              />
            } @else {
              <mat-icon matCardAvatar aria-hidden="true">person</mat-icon>
            }
            <mat-card-title>{{ u.displayName }}</mat-card-title>
            <mat-card-subtitle>
              {{ u.totals.total }} pts ·
              {{ u.totals.exactScoreHits }} exact ·
              {{ u.totals.correctOutcomeHits }} outcomes
            </mat-card-subtitle>
          </mat-card-header>
          <mat-card-content class="stats-grid">
            <div class="stat">
              <span class="stat-value">{{ u.totals.total }}</span>
              <span class="stat-label">points</span>
            </div>
            <div class="stat">
              <span class="stat-value">{{ u.totals.exactScoreHits }}</span>
              <span class="stat-label">exact</span>
            </div>
            <div class="stat">
              <span class="stat-value">{{ u.totals.correctOutcomeHits }}</span>
              <span class="stat-label">outcome</span>
            </div>
          </mat-card-content>
        </mat-card>

        @if (podiumPick(); as podium) {
          <mat-card appearance="outlined">
            <mat-card-header>
              <mat-icon matCardAvatar class="trophy">emoji_events</mat-icon>
              <mat-card-title>Podium picks</mat-card-title>
              <mat-card-subtitle>
                @if (podium.points !== null) {
                  Earned {{ podium.points }} pts
                } @else {
                  Awaiting tournament end
                }
              </mat-card-subtitle>
            </mat-card-header>
            <mat-card-content class="podium-grid">
              <div class="podium-spot">
                <mat-icon class="medal gold">emoji_events</mat-icon>
                <span class="podium-label">Winner</span>
                <span class="podium-team">{{ teamName(podium.winnerTeamId) }}</span>
              </div>
              <div class="podium-spot">
                <mat-icon class="medal silver">emoji_events</mat-icon>
                <span class="podium-label">2nd</span>
                <span class="podium-team">{{ teamName(podium.secondTeamId) }}</span>
              </div>
              <div class="podium-spot">
                <mat-icon class="medal bronze">emoji_events</mat-icon>
                <span class="podium-label">3rd</span>
                <span class="podium-team">{{ teamName(podium.thirdTeamId) }}</span>
              </div>
            </mat-card-content>
          </mat-card>
        }

        <!-- Locked predictions list -->
        <mat-card appearance="outlined" class="fixtures-card card-grow">
          <mat-card-header>
            <mat-icon matCardAvatar>history</mat-icon>
            <mat-card-title>Their predictions</mat-card-title>
            <mat-card-subtitle>
              {{ predictionsSubtitle() }}
            </mat-card-subtitle>
          </mat-card-header>
          <div class="card-scroll">
            @if (lockedFixtures().length === 0) {
              <div class="empty">
                <mat-icon aria-hidden="true">event_busy</mat-icon>
                <p>No locked predictions yet — check back after matches kick off.</p>
              </div>
            } @else {
              @for (f of lockedFixtures(); track f.id) {
                <app-fixture-row
                  [fixture]="f"
                  [prediction]="predictionFor(f.id)"
                />
              }
            }
          </div>
        </mat-card>
      } @else {
        <mat-card appearance="outlined" class="empty-card">
          <mat-icon aria-hidden="true">person_off</mat-icon>
          <p>User not found.</p>
        </mat-card>
      }
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      width: 100%;
    }
    .back-link {
      align-self: flex-start;
    }
    .hero-card {
      min-height: 120px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.5rem;
      margin-top: 0.5rem;
    }
    .stat {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.15rem;
      padding: 1rem 0.5rem;
      border-radius: 14px;
      background: var(--mat-sys-surface-container-low);
    }
    .stat-value {
      font: var(--mat-sys-headline-medium);
      font-variant-numeric: tabular-nums;
    }
    .stat-label {
      font-size: 0.72rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--mat-sys-on-surface-variant);
    }
    .trophy { color: var(--mat-sys-tertiary); }
    .podium-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.5rem;
      margin-top: 0.5rem;
    }
    .podium-spot {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.25rem;
      padding: 0.75rem 0.5rem;
      border-radius: 12px;
      background: var(--mat-sys-surface-container-low);
      text-align: center;
    }
    .medal {
      font-size: 24px;
      width: 24px;
      height: 24px;
    }
    .medal.gold { color: var(--mat-sys-tertiary); }
    .medal.silver { color: var(--mat-sys-outline); }
    .medal.bronze {
      color: color-mix(in srgb, var(--mat-sys-tertiary) 55%, var(--mat-sys-error) 45%);
    }
    .podium-label {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mat-sys-on-surface-variant);
    }
    .podium-team {
      font-weight: 600;
      font-size: 0.9rem;
    }

    .fixtures-card {
      padding: 0;
    }
    .fixtures-card mat-card-header {
      padding: 1rem 1rem 0;
    }
    .empty,
    .empty-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
      padding: 2rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .skel-hdr { flex: 1; min-width: 0; }
  `,
})
export class UserProfileComponent {
  private readonly db = inject(FIRESTORE);
  private readonly auth = inject(AuthService);
  private readonly fixtures = inject(FixturesService);
  private readonly predictions = inject(PredictionsService);
  private readonly router = inject(Router);

  /** Wired from the route param via withComponentInputBinding(). */
  readonly uid = input.required<string>();

  protected readonly otherUser = signal<OtherUserDoc | null>(null);
  protected readonly otherPredictions = signal<ReadonlyMap<string, MatchPrediction>>(new Map());
  protected readonly podiumPick = signal<PodiumPick | null>(null);
  protected readonly loaded = signal(false);

  constructor() {
    // If someone navigates to their own /users/:uid, send them to /profile
    // (the editable surface). Other users land here normally.
    effect(() => {
      const targetUid = this.uid();
      const selfUid = this.auth.uid();
      if (selfUid && targetUid === selfUid) {
        void this.router.navigate(['/profile']);
        return;
      }
      void this.loadAll(targetUid);
    });
  }

  /** Subset of fixtures that are locked (status !== TIMED) — the only ones
   *  we're allowed to read this user's predictions for. */
  protected readonly lockedFixtures = computed(() => {
    const now = new Date();
    return this.fixtures
      .fixtures()
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
    try {
      const [userOk] = await Promise.all([
        this.loadUserDoc(uid),
        this.loadLockedPredictions(uid),
        this.loadPodiumIfUnlocked(uid),
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
    // Wait until fixtures are loaded so lockedFixtures() returns the full list.
    // The fixtures cache + live overlay populates the signal asynchronously.
    if (this.fixtures.fixtures().length === 0) {
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

  /** Podium picks are public after the lock date. Skip the fetch entirely
   *  before then to avoid a noisy permission-denied error in the console. */
  private async loadPodiumIfUnlocked(uid: string): Promise<void> {
    if (Date.now() < PODIUM_LOCK.getTime()) return;
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
      // Quietly ignore — podium might just not be set.
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
