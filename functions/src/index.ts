import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions';

initializeApp();

setGlobalOptions({
  region: 'europe-west1',
  maxInstances: 10,
});

export { pollFootballData } from './poll-football-data';
export { pollTeams } from './poll-teams';
export { scoreMatch } from './score-match';
export { devFinishMatch } from './dev-finish-match';
export { devSetFixtureState } from './dev-set-fixture-state';
export { devSetKickoffTime } from './dev-set-kickoff';
export { devResetMyState } from './dev-reset-my-state';
export { devClearMyPersonality } from './dev-clear-personality';
export { devSignInAsAdmin } from './dev-sign-in-admin';
export { grantAdminRole, revokeAdminRole } from './admin-roles';
export { devPollTeamsNow } from './dev-poll-teams';
export { devPollFixturesNow } from './dev-poll-fixtures';
export { syncCompetitionsFromApi, setCompetitionActive } from './sync-competitions';
export { migrateToMultiComp } from './migrate-to-multi-comp';
export {
  createLeague,
  joinLeague,
  leaveLeague,
  deleteLeague,
  regenerateInviteCode,
  transferOwnership,
  kickMember,
} from './leagues';
export {
  createGlobalLeague,
  syncGlobalLeague,
  deleteGlobalLeague,
  autoEnrollOnUserCreate,
} from './global-leagues';
export { generatePredictorPersonality } from './personality';
