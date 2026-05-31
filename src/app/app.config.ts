import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection, isDevMode,
} from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import {
  MAT_SNACK_BAR_DEFAULT_OPTIONS,
  MatSnackBarConfig,
} from '@angular/material/snack-bar';
import { MAT_ICON_DEFAULT_OPTIONS } from '@angular/material/icon';
import {
  provideRouter,
  withComponentInputBinding,
  withViewTransitions,
} from '@angular/router';

import { environment } from '../environments/environment';
import { onRouteViewTransition } from './core/router/view-transitions';
import { markRendererCapability } from './core/router/software-renderer';
import { provideFirebase } from './core/firebase/firebase.providers';
import { AppUpdateService } from './core/services/app-update.service';
import { NotificationsService } from './core/services/notifications.service';
import { routes } from './app.routes';
import { provideServiceWorker } from '@angular/service-worker';

/**
 * Global snack-bar defaults. Anchor every toast to the top of the
 * viewport — keeps notifications away from the bottom-nav (which
 * would otherwise overlap them on mobile) and matches the visual
 * weight of the install-banner that also lives up top.
 *
 * Per-call configs passed to `MatSnackBar.open(...)` still win — this
 * is just the baseline. Note that Material merges shallowly, so if a
 * call provides its own `verticalPosition` it overrides ours.
 */
const SNACK_BAR_DEFAULTS: MatSnackBarConfig = {
  verticalPosition: 'top',
  horizontalPosition: 'center',
};

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideAnimationsAsync(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withViewTransitions({
        // No animation on the very first paint — only on subsequent navigations.
        skipInitialTransition: true,
        onViewTransitionCreated: onRouteViewTransition,
      }),
    ),
    provideFirebase({
      options: environment.firebase,
      useEmulators: environment.useEmulators,
      functionsRegion: environment.functionsRegion,
    }), provideServiceWorker('ngsw-worker.js', {
            enabled: !isDevMode(),
            registrationStrategy: 'registerWhenStable:30000'
          }),
    { provide: MAT_SNACK_BAR_DEFAULT_OPTIONS, useValue: SNACK_BAR_DEFAULTS },
    // Render every <mat-icon> with the Material Symbols (Rounded) font instead
    // of the classic Material Icons font loaded by default. The ligature names
    // are shared between the two families, so existing icon usages are
    // unchanged — only the glyph style (modern, rounded) differs.
    { provide: MAT_ICON_DEFAULT_OPTIONS, useValue: { fontSet: 'material-symbols-rounded' } },
    // Boot the SwUpdate listener immediately so users see a "Reload" toast
    // when a new build is deployed mid-session.
    provideAppInitializer(() => {
      // Flag software rendering so the view transitions degrade to instant
      // (full-screen bitmap fades jank on a CPU rasterizer).
      markRendererCapability();
      inject(AppUpdateService).start();
      // Re-arm push for users who already opted in (refreshes the token and
      // re-binds the foreground message handler). No-op until permission is
      // granted and a VAPID key is configured.
      void inject(NotificationsService).syncOnStartup();
    }),
  ],
};
