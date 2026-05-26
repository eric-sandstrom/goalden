import { Injectable, Signal, computed, effect, inject, signal } from '@angular/core';
import {
  DocumentData,
  Timestamp,
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { FIRESTORE } from '../firebase/firebase.providers';
import { PodiumPick } from '../models/podium.model';
import { AuthService } from './auth.service';

export interface MatchPrediction {
  readonly matchId: string;
  readonly homeScore: number;
  readonly awayScore: number;
  readonly submittedAt: Date | null;
  readonly points: number | null;
}

@Injectable({ providedIn: 'root' })
export class PredictionsService {
  private readonly db = inject(FIRESTORE);
  private readonly auth = inject(AuthService);

  private readonly _matchPredictions = signal<ReadonlyMap<string, MatchPrediction>>(new Map());
  private readonly _loaded = signal(false);
  private readonly _podiumPick = signal<PodiumPick | null>(null);
  private readonly _podiumLoaded = signal(false);

  readonly matchPredictions: Signal<ReadonlyMap<string, MatchPrediction>> =
    this._matchPredictions.asReadonly();
  readonly loaded: Signal<boolean> = this._loaded.asReadonly();
  readonly podiumPick: Signal<PodiumPick | null> = this._podiumPick.asReadonly();
  readonly podiumLoaded: Signal<boolean> = this._podiumLoaded.asReadonly();

  readonly count = computed(() => this._matchPredictions().size);

  constructor() {
    effect((onCleanup) => {
      const uid = this.auth.uid();
      if (!uid) {
        this._matchPredictions.set(new Map());
        this._loaded.set(false);
        return;
      }
      this._loaded.set(false);
      const ref = collection(this.db, `predictions/${uid}/matches`);
      const unsub = onSnapshot(ref, (snap) => {
        const m = new Map<string, MatchPrediction>();
        snap.forEach((d) => m.set(d.id, this.parse(d.id, d.data())));
        this._matchPredictions.set(m);
        this._loaded.set(true);
      });
      onCleanup(() => unsub());
    });

    effect((onCleanup) => {
      const uid = this.auth.uid();
      if (!uid) {
        this._podiumPick.set(null);
        this._podiumLoaded.set(false);
        return;
      }
      this._podiumLoaded.set(false);
      const ref = doc(this.db, `predictions/${uid}/podium/picks`);
      const unsub = onSnapshot(ref, (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          const submitted = data['submittedAt'];
          this._podiumPick.set({
            winnerTeamId: data['winnerTeamId'],
            secondTeamId: data['secondTeamId'],
            thirdTeamId: data['thirdTeamId'],
            submittedAt: submitted instanceof Timestamp ? submitted.toDate() : null,
            points: data['points'] ?? null,
          });
        } else {
          this._podiumPick.set(null);
        }
        this._podiumLoaded.set(true);
      });
      onCleanup(() => unsub());
    });
  }

  private parse(matchId: string, data: DocumentData): MatchPrediction {
    const submittedAt = data['submittedAt'];
    return {
      matchId,
      homeScore: data['homeScore'] ?? 0,
      awayScore: data['awayScore'] ?? 0,
      submittedAt: submittedAt instanceof Timestamp ? submittedAt.toDate() : null,
      points: data['points'] ?? null,
    };
  }

  async savePrediction(matchId: string, homeScore: number, awayScore: number): Promise<void> {
    const uid = this.auth.uid();
    if (!uid) throw new Error('Not authenticated');

    const ref = doc(this.db, `predictions/${uid}/matches/${matchId}`);
    await setDoc(ref, {
      matchId,
      homeScore,
      awayScore,
      submittedAt: serverTimestamp(),
      points: null,
    });
  }

  async savePodium(winnerTeamId: number, secondTeamId: number, thirdTeamId: number): Promise<void> {
    const uid = this.auth.uid();
    if (!uid) throw new Error('Not authenticated');

    const ref = doc(this.db, `predictions/${uid}/podium/picks`);
    await setDoc(ref, {
      winnerTeamId,
      secondTeamId,
      thirdTeamId,
      submittedAt: serverTimestamp(),
      points: null,
    });
  }
}
