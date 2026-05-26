/**
 * Position bucket. Football-data.org's API uses "Goalkeeper" / "Defender" /
 * "Midfielder" / "Forward" as free-text strings; we normalise on the server
 * before writing to Firestore so the client can rely on a stable union.
 */
export type PlayerPosition = 'GOALKEEPER' | 'DEFENDER' | 'MIDFIELDER' | 'FORWARD' | 'UNKNOWN';

export interface Player {
  readonly id: number;
  readonly name: string;
  readonly position: PlayerPosition;
  readonly nationality: string | null;
  readonly dateOfBirth: Date | null;
  readonly shirtNumber: number | null;
}

export interface Coach {
  readonly id: number | null;
  readonly name: string;
  readonly nationality: string | null;
  readonly dateOfBirth: Date | null;
}

export interface Team {
  readonly id: string; // Firestore document id, e.g. "fd-759"
  readonly externalId: number; // football-data.org numeric id
  readonly name: string;
  readonly shortName: string | null;
  readonly tla: string | null;
  readonly crest: string | null;
  readonly founded: number | null;
  readonly clubColors: string | null;
  readonly venue: string | null;
  readonly website: string | null;
  readonly coach: Coach | null;
  readonly squad: readonly Player[];
  readonly lastSyncedAt: Date | null;
}

/** Visual + sorting helper for position rendering on the team detail view. */
export const POSITION_ORDER: Record<PlayerPosition, number> = {
  GOALKEEPER: 0,
  DEFENDER: 1,
  MIDFIELDER: 2,
  FORWARD: 3,
  UNKNOWN: 4,
};

export const POSITION_LABEL: Record<PlayerPosition, string> = {
  GOALKEEPER: 'Goalkeepers',
  DEFENDER: 'Defenders',
  MIDFIELDER: 'Midfielders',
  FORWARD: 'Forwards',
  UNKNOWN: 'Other',
};
