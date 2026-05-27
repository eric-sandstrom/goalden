import { inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CanActivateFn, Router } from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../services/auth.service';
import { UserService } from '../services/user.service';

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const userService = inject(UserService);
  const router = inject(Router);

  const authInit$ = toObservable(auth.initialized);
  const userLoaded$ = toObservable(userService.loaded);

  await firstValueFrom(authInit$.pipe(filter((v) => v)));

  if (!auth.isAuthenticated()) {
    return router.parseUrl('/login');
  }

  await firstValueFrom(userLoaded$.pipe(filter((v) => v)));

  if (!userService.hasDisplayName()) {
    return router.parseUrl('/onboarding/display-name');
  }

  return true;
};

export const requiresAuthGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const authInit$ = toObservable(auth.initialized);
  await firstValueFrom(authInit$.pipe(filter((v) => v)));

  if (!auth.isAuthenticated()) {
    return router.parseUrl('/login');
  }
  return true;
};

/** Gate for the /admin section. Requires both authenticated AND the
 *  user-doc `roles` field to include `'admin'`. Sends non-admins back to
 *  the home page. */
export const adminGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const userService = inject(UserService);
  const router = inject(Router);

  const authInit$ = toObservable(auth.initialized);
  const userLoaded$ = toObservable(userService.loaded);

  await firstValueFrom(authInit$.pipe(filter((v) => v)));
  if (!auth.isAuthenticated()) {
    return router.parseUrl('/login');
  }
  await firstValueFrom(userLoaded$.pipe(filter((v) => v)));
  if (!userService.isAdmin()) {
    return router.parseUrl('/');
  }
  return true;
};

/**
 * Gate for `/dev`. Two ways to pass:
 *   - The build is non-production (`environment.production === false`) —
 *     covers `ng serve` and dev builds. Anyone gets in.
 *   - The build IS production but the caller has the 'admin' role —
 *     covers friends-test sessions where we want the admin to drive
 *     match-state changes against live data.
 *
 * Server-side, the corresponding Cloud Functions use the matching
 * `requireAdminOrEmulator` helper, so the actual mutation always
 * re-checks the role (route gate is purely UX).
 */
export const devOrAdminGuard: CanActivateFn = async () => {
  if (!environment.production) return true;

  const auth = inject(AuthService);
  const userService = inject(UserService);
  const router = inject(Router);

  const authInit$ = toObservable(auth.initialized);
  const userLoaded$ = toObservable(userService.loaded);

  await firstValueFrom(authInit$.pipe(filter((v) => v)));
  if (!auth.isAuthenticated()) {
    return router.parseUrl('/login');
  }
  await firstValueFrom(userLoaded$.pipe(filter((v) => v)));
  if (!userService.isAdmin()) {
    return router.parseUrl('/');
  }
  return true;
};

export const redirectIfAuthenticatedGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const authInit$ = toObservable(auth.initialized);
  await firstValueFrom(authInit$.pipe(filter((v) => v)));

  if (auth.isAuthenticated()) {
    return router.parseUrl('/');
  }
  return true;
};
