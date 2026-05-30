import { Routes } from '@angular/router';
import {
  adminGuard,
  authGuard,
  devOrAdminGuard,
  redirectIfAuthenticatedGuard,
  requiresAuthGuard,
} from './core/guards/auth.guard';
import { predictLastLocationGuard } from './features/predict/predict-view-storage';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [redirectIfAuthenticatedGuard],
    loadComponent: () =>
      import('./features/auth/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'j/:code',
    loadComponent: () =>
      import('./features/leagues/join-league.component').then((m) => m.JoinLeagueComponent),
  },
  {
    path: 'onboarding/display-name',
    canActivate: [requiresAuthGuard],
    loadComponent: () =>
      import('./features/onboarding/display-name.component').then(
        (m) => m.DisplayNameComponent,
      ),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./shared/components/shell.component').then((m) => m.ShellComponent),
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./features/home/home.component').then((m) => m.HomeComponent),
      },
      {
        path: 'predict',
        loadComponent: () =>
          import('./features/predict/predict.component').then((m) => m.PredictComponent),
        // Two componentless child routes carry the view's state in the URL so
        // a refresh restores it: `:comp` is the selected competition's
        // `${compId}_${season}` key, `:tab` is the lower-cased filter chip.
        // Neither renders anything — PredictComponent reads them off the
        // activated route and writes them back on selection.
        children: [
          {
            // A bare /predict redirects to the last-viewed comp + tab so
            // pressing "Predict" returns you where you left off. Falls
            // through to the component (which picks a default) on a first
            // visit with nothing saved.
            path: '',
            canActivate: [predictLastLocationGuard],
            children: [],
          },
          {
            path: ':comp',
            // Empty `children` keeps `:tab` a valid componentless route
            // (Angular rejects a leaf with no component/children/redirect)
            // while still rendering nothing — it only carries the param.
            children: [{ path: ':tab', children: [] }],
          },
        ],
      },
      // /leaderboard merged into /leagues. Keep the path as a redirect so
      // existing bookmarks / shared links still land on the right page.
      { path: 'leaderboard', redirectTo: 'leagues', pathMatch: 'full' },
      {
        path: 'leagues',
        loadComponent: () =>
          import('./features/leagues/leagues.component').then((m) => m.LeaguesComponent),
      },
      {
        path: 'leagues/:leagueId',
        loadComponent: () =>
          import('./features/leagues/league-detail.component').then(
            (m) => m.LeagueDetailComponent,
          ),
      },
      {
        // Comp-scoped podium path, matching the /comp/:id/standings shape.
        // Podium picks are a WC-only concept, so the comp segment is literal.
        path: 'comp/WC/podium',
        loadComponent: () =>
          import('./features/podium/podium-picks.component').then(
            (m) => m.PodiumPicksComponent,
          ),
      },
      // Legacy /podium → comp-scoped path, so existing bookmarks/links still land.
      { path: 'podium', redirectTo: 'comp/WC/podium', pathMatch: 'full' },
      {
        // Dedicated standings view. `:competitionId` binds to the
        // component's required input via withComponentInputBinding(); the
        // season is derived from the competition catalogue.
        path: 'comp/:competitionId/standings',
        loadComponent: () =>
          import('./features/standings/standings-view.component').then(
            (m) => m.StandingsViewComponent,
          ),
      },
      {
        // Comp-scoped teams browser. `:competitionId` binds to the
        // component's input via withComponentInputBinding(), scoping the
        // list to that competition's `cache/teams-{compId}` rollup.
        path: 'comp/:competitionId/teams',
        loadComponent: () =>
          import('./features/teams/teams.component').then((m) => m.TeamsComponent),
      },
      {
        // Unscoped fallback — merges every active competition's teams.
        path: 'teams',
        loadComponent: () =>
          import('./features/teams/teams.component').then((m) => m.TeamsComponent),
      },
      {
        path: 'teams/:teamId',
        loadComponent: () =>
          import('./features/teams/team-detail.component').then(
            (m) => m.TeamDetailComponent,
          ),
      },
      {
        // Per-match detail. `:fdid` is the football-data match id (the bare
        // numeric id behind our `fd-{id}` fixture doc); binds to the
        // component's required input via withComponentInputBinding().
        path: 'match/:fdid',
        loadComponent: () =>
          import('./features/fixture-detail/fixture-detail.component').then(
            (m) => m.FixtureDetailComponent,
          ),
      },
      {
        // Componentless parent so /profile/admin nests under Profile while
        // both children still render in the shell's router-outlet.
        path: 'profile',
        children: [
          {
            path: '',
            loadComponent: () =>
              import('./features/profile/profile.component').then((m) => m.ProfileComponent),
          },
          {
            path: 'admin',
            canActivate: [adminGuard],
            loadComponent: () =>
              import('./features/admin/admin.component').then((m) => m.AdminComponent),
          },
        ],
      },
      {
        path: 'users/:uid',
        loadComponent: () =>
          import('./features/user-profile/user-profile.component').then(
            (m) => m.UserProfileComponent,
          ),
      },
      {
        path: 'dev',
        canActivate: [devOrAdminGuard],
        loadComponent: () =>
          import('./features/dev/dev-tools.component').then((m) => m.DevToolsComponent),
      },
      // Admin moved under Profile. Keep /admin as a redirect so existing
      // bookmarks / links still land on the right page.
      { path: 'admin', redirectTo: 'profile/admin', pathMatch: 'full' },
    ],
  },
  { path: '**', redirectTo: '' },
];
