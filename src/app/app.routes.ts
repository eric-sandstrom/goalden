import { Routes } from '@angular/router';
import {
  adminGuard,
  authGuard,
  devOrAdminGuard,
  redirectIfAuthenticatedGuard,
  requiresAuthGuard,
} from './core/guards/auth.guard';

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
        path: 'podium',
        loadComponent: () =>
          import('./features/podium/podium-picks.component').then(
            (m) => m.PodiumPicksComponent,
          ),
      },
      {
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
        path: 'profile',
        loadComponent: () =>
          import('./features/profile/profile.component').then((m) => m.ProfileComponent),
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
      {
        path: 'admin',
        canActivate: [adminGuard],
        loadComponent: () =>
          import('./features/admin/admin.component').then((m) => m.AdminComponent),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
