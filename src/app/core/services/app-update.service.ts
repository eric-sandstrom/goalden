import { DestroyRef, Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';

/**
 * Surfaces in-app notifications when a new version of the app has been
 * deployed and the service worker has finished downloading it.
 *
 * Background: the Angular service worker activates a new version on the
 * next page navigation by default. If the user keeps the tab open across
 * a deploy, they'll happily use the cached old version forever. This
 * service:
 *   1. Subscribes to `versionUpdates$` — when a `VERSION_READY` event
 *      arrives, shows a sticky snackbar offering the user a Reload.
 *      Reload simply calls `location.reload()`; the service worker then
 *      activates the freshly-downloaded version on the new page load.
 *   2. Polls `checkForUpdate()` on a schedule so we catch deploys that
 *      land while the user is mid-session. Without the poll, the worker
 *      only checks at app startup — a fan watching a live match with the
 *      tab open for 90 minutes would never see the update.
 *   3. Re-checks on tab focus (visibilitychange) — cheap, and catches the
 *      common pattern of "user switches tabs for a bit, comes back".
 *   4. Listens for the unrecoverable state event. This is the rare case
 *      where the worker's cache is broken (browser evicted assets,
 *      half-baked deploy). The only safe move is to hard-reload.
 *
 * Bootstrapped via `provideAppInitializer` in app.config.ts so it runs at
 * launch with no explicit consumer.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly updates = inject(SwUpdate);
  private readonly snackBar = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);

  /** 30 minutes. Compromise between responsiveness and not hammering the
   *  hosting CDN. A live match window is ~2 hours; this gives us up to
   *  four chances to notice a deploy within a single match session. */
  private readonly POLL_INTERVAL_MS = 30 * 60 * 1000;

  /** Guard so we only ever show the snackbar once per pending update. The
   *  versionUpdates stream can emit duplicate VERSION_READY events if the
   *  worker re-evaluates; the user already got the prompt. */
  private snackbarShown = false;

  start(): void {
    if (!this.updates.isEnabled) {
      // Dev mode, no service worker — nothing to do. The build target
      // strips the service worker outside production anyway.
      return;
    }

    // 1. React to update events.
    const versionSub = this.updates.versionUpdates.subscribe((event) => {
      if (event.type === 'VERSION_READY') {
        this.promptReload(event);
      }
    });
    this.destroyRef.onDestroy(() => versionSub.unsubscribe());

    // 2. Cache corruption — only graceful path is a hard reload, which
    //    forces the browser to re-fetch index.html and re-register a
    //    fresh worker.
    const unrecoverableSub = this.updates.unrecoverable.subscribe((event) => {
      console.error('Service worker unrecoverable state:', event.reason);
      this.snackBar
        .open('App needs to reload to recover', 'Reload', {})
        .onAction()
        .subscribe(() => document.location.reload());
    });
    this.destroyRef.onDestroy(() => unrecoverableSub.unsubscribe());

    // 3. Periodic polling. The first checkForUpdate runs immediately so
    //    that if a deploy landed between worker registration (30s after
    //    app stabilizes) and now, we still surface it quickly.
    void this.checkSafe();
    const intervalId = window.setInterval(
      () => void this.checkSafe(),
      this.POLL_INTERVAL_MS,
    );
    this.destroyRef.onDestroy(() => window.clearInterval(intervalId));

    // 4. Tab-focus check. Cheap on the network (worker compares hashes
    //    server-side) and catches "user came back from another tab".
    if (typeof document !== 'undefined') {
      const onVisibility = () => {
        if (document.visibilityState === 'visible') void this.checkSafe();
      };
      document.addEventListener('visibilitychange', onVisibility);
      this.destroyRef.onDestroy(() =>
        document.removeEventListener('visibilitychange', onVisibility),
      );
    }
  }

  /** Wraps checkForUpdate in a try/catch — network failures, offline, etc.
   *  should never bubble up and surface in the console as unhandled. */
  private async checkSafe(): Promise<void> {
    try {
      await this.updates.checkForUpdate();
    } catch (e: unknown) {
      // Don't spam the console with offline-fetch errors. Logged at debug
      // level intentionally — it's expected to fail when the user's on a
      // plane or behind a captive portal.
      console.debug('SwUpdate.checkForUpdate failed', e);
    }
  }

  private promptReload(event: VersionReadyEvent): void {
    if (this.snackbarShown) return;
    this.snackbarShown = true;
    // No duration: stays visible until the user acts. We're asking them
    // to reload the app — they should make a deliberate choice rather
    // than miss a 5-second toast.
    const ref = this.snackBar.open('A new version is available', 'Reload', {});
    ref.onAction().subscribe(() => {
      document.location.reload();
    });
    ref.afterDismissed().subscribe((dismissed) => {
      // If the user dismisses without reloading, allow the prompt to
      // come back on the next VERSION_READY (e.g. a second deploy lands
      // in the same session). Reset the guard so the next event shows
      // a fresh snackbar.
      if (!dismissed.dismissedByAction) {
        this.snackbarShown = false;
      }
    });
    console.info(
      `New app version detected: ${event.latestVersion.hash.slice(0, 7)} ` +
        `(current ${event.currentVersion.hash.slice(0, 7)})`,
    );
  }
}
