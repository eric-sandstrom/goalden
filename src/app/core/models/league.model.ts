export type LeagueRole = 'owner' | 'member';

/**
 * Three flavours of league:
 *  - `private` (default): user-created, invite-only via capability URL.
 *    Has an owner with mod powers.
 *  - `public`: user-created, **discoverable** by any signed-in user. Same
 *    owner powers as private. Joinable without an invite code from the
 *    browse list (the invite code still exists if the owner wants to share
 *    one). The differentiator vs private is solely discoverability +
 *    code-less join.
 *  - `global`: admin-created via createGlobalLeague(). No invite code, no
 *    owner. Users are auto-enrolled based on `globalConfig.autoEnroll`.
 */
export type LeagueType = 'private' | 'public' | 'global';

/**
 * Configuration that drives auto-enrollment for `global` leagues. Evaluated
 * on user create (new sign-ups) and on `syncGlobalLeague` callable (admin
 * backfill).
 */
export interface LeagueGlobalConfig {
  /** `'all'` matches every user; `'filter'` matches users whose user doc
   *  has the given field equal to the given value. */
  readonly autoEnroll: 'all' | 'filter';
  readonly filter?: {
    readonly field: string;
    readonly equals: string | number | boolean;
  };
  /** When false, the leaveLeague callable refuses to remove members of this
   *  league. UI hides the leave button to match. */
  readonly allowLeave: boolean;
}

export interface League {
  readonly id: string;
  readonly name: string;
  /** Defaults to `'private'` for legacy leagues that pre-date this field. */
  readonly type: LeagueType;
  /** Only present when `type === 'global'`. Null for private leagues. */
  readonly globalConfig: LeagueGlobalConfig | null;
  /**
   * Football-data competition shortcode this league predicts on
   * (e.g. `'WC'`, `'PL'`, `'CL'`). Immutable after league creation.
   * Defaults to `'WC'` in the client parser for legacy leagues that
   * pre-date multi-competition; the `migrateToMultiComp` admin
   * callable backfills the real field on the league doc so the
   * fallback eventually stops activating.
   */
  readonly competitionId: string;
  /**
   * Season identifier — uses the starting calendar year (e.g. `'2025'`
   * for EPL 2025–26, `'2026'` for WC 2026, Allsvenskan 2026). Paired
   * with `competitionId` to form the totals-shard key
   * `${competitionId}_${season}` and to scope fixture queries.
   * Defaults to `'2026'` for legacy leagues, same migration path.
   */
  readonly season: string;
  /** Empty string for global leagues (they have no owner). */
  readonly ownerId: string;
  /** Empty string for global leagues (no invite mechanism). */
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
