import { Team } from './fixture.model';

export interface KnownTeam {
  readonly id: number;
  readonly name: string;
  readonly tla: string;
  readonly crest: string | null;
}

export function asKnownTeam(t: Team): KnownTeam | null {
  if (t.id === null || t.name === null || t.tla === null) return null;
  return { id: t.id, name: t.name, tla: t.tla, crest: t.crest };
}

export interface PodiumPick {
  readonly winnerTeamId: number;
  readonly secondTeamId: number;
  readonly thirdTeamId: number;
  readonly submittedAt: Date | null;
  readonly points: number | null;
}

/** First match of WC 2026. Podium picks lock at or after this instant. */
export const PODIUM_LOCK = new Date(Date.UTC(2026, 5, 11, 0, 0, 0));
