export type LeagueRole = 'owner' | 'member';

export interface League {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  readonly inviteCode: string;
  readonly memberCount: number;
  readonly createdAt: Date | null;
}

export interface LeagueMember {
  readonly uid: string;
  readonly role: LeagueRole;
  readonly joinedAt: Date | null;
}

export interface LeaguePublic {
  readonly inviteCode: string;
  readonly leagueId: string;
  readonly name: string;
  readonly memberCount: number;
}

export interface MyLeagueMembership {
  readonly leagueId: string;
  readonly role: LeagueRole;
  readonly joinedAt: Date | null;
}
