import { inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CanActivateFn, Router } from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';
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
