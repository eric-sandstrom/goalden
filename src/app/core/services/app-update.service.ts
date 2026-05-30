import { DestroyRef, Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import {
  AppRelease,
  AppUpdateData,
  WhatsNewDialogComponent,
} from '../../shared/components/whats-new-dialog.component';
import { NotificationsService } from './notifications.service';

/**
 * Surfaces in-app notifications when a new version of the app has been
 * deployed and the service worker has finished downloading it.
 *
 * Background: the Angular service worker activates a new version on the
 * next page navigation by default. If the user keeps the tab open across
 * a deploy, they'll happily use the cached old version forever. This
 * service:
 *   1. Subscribes to `versionUpdates$` — when a `VERSION_READY` event
 *      arrives, shows a sticky snackbar offering the user a Reload and a
 *      "What's new" action that opens a change-log dialog. The change log
 *      rides along on the new version's `appData` (set in `ngsw-config.json`),
 *      so it needs no extra network fetch. Reload simply calls
 *      `location.reload()`; the service worker then activates the
 *      freshly-downloaded version on the new page load.
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
  private readonly dialog = inject(MatDialog);
  private readonly destroyRef = inject(DestroyRef);
  private readonly notifications = inject(NotificationsService);

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

    // The change log rides along on appData. The latest build carries the
    // full release history (newest-first); the build the user is currently
    // running carries its own version label. Slice the history down to just
    // the releases between the two, so a user several versions behind sees
    // every update they missed — not only the newest one.
    const changelog: AppUpdateData = {
      releases: selectReleases(event.latestVersion.appData, event.currentVersion.appData),
    };

    // The snackbar action is "What's new" — it opens the change-log dialog,
    // which is where the actual Reload lives. We surface a dedicated action
    // rather than just "Reload" so the user sees what changed before
    // committing to a page reload mid-session.
    // No duration: stays visible until the user acts. We're asking them to
    // reload the app — a deliberate choice rather than a 5-second toast.
    const ref = this.snackBar.open('A new version is available', "What's new", {});
    ref.onAction().subscribe(() => {
      this.openChangelog(changelog);
    });

    // Also fire an OS notification (no-op unless the user enabled them) so a
    // backgrounded tab still surfaces the update outside the app. Fold the
    // change log into the body when we have one.
    void this.notifications.showLocal(
      'A new version is available',
      changelogBody(changelog),
      'app-update',
    );
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

  /** Open the change-log dialog; reload only if the user confirms. */
  private openChangelog(data: AppUpdateData): void {
    const dialogRef = this.dialog.open<WhatsNewDialogComponent, AppUpdateData, boolean>(
      WhatsNewDialogComponent,
      { data, autoFocus: false, restoreFocus: false },
    );
    dialogRef.afterClosed().subscribe((reload) => {
      if (reload) {
        document.location.reload();
      } else {
        // User chose "Later" / dismissed — re-arm so the next VERSION_READY
        // (or the next tab focus) can prompt again.
        this.snackbarShown = false;
      }
    });
  }
}

/**
 * Pick the releases to show: everything in the latest build's history that's
 * newer than the build the user is currently running.
 *
 * The latest build's `appData.releases` is the full history (newest-first),
 * and `current.version` labels the running build. We locate the running
 * version in that history and return everything above it. No semver math —
 * we match the version label against the retained history array, which is
 * robust to any labelling scheme.
 *
 * Fallbacks (defensive — appData is opaque and may be stale or malformed):
 *   - current version unknown, or not found in the retained history (the user
 *     is so far behind we've pruned their version): show the whole history.
 *   - current version is the newest entry: show nothing (a deploy that didn't
 *     bump the version) — the dialog falls back to its generic message.
 */
function selectReleases(latest: unknown, current: unknown): AppRelease[] {
  const history = readReleases(latest);
  if (history.length === 0) return [];
  const currentVersion = readVersion(current);
  if (currentVersion) {
    const idx = history.findIndex((r) => r.version === currentVersion);
    if (idx === 0) return [];
    if (idx > 0) return history.slice(0, idx);
  }
  return history;
}

/** Read the release history from a build's appData. Accepts the current
 *  `{ releases: [...] }` shape and, for resilience against an older deployed
 *  build, the legacy single-release `{ version, changes }` shape. */
function readReleases(appData: unknown): AppRelease[] {
  if (!appData || typeof appData !== 'object') return [];
  const bag = appData as Record<string, unknown>;
  if (Array.isArray(bag['releases'])) {
    return bag['releases']
      .map(toRelease)
      .filter((r): r is AppRelease => r !== null);
  }
  const single = toRelease(bag);
  return single ? [single] : [];
}

/** Coerce one opaque entry into an AppRelease, or null if it carries nothing. */
function toRelease(value: unknown): AppRelease | null {
  if (!value || typeof value !== 'object') return null;
  const bag = value as Record<string, unknown>;
  const version = typeof bag['version'] === 'string' ? bag['version'] : undefined;
  const changes = Array.isArray(bag['changes'])
    ? bag['changes'].filter((c): c is string => typeof c === 'string')
    : [];
  if (!version && changes.length === 0) return null;
  return { version, changes };
}

/** The top-level `version` label a build stamps on its own appData. */
function readVersion(appData: unknown): string | undefined {
  if (!appData || typeof appData !== 'object') return undefined;
  const v = (appData as Record<string, unknown>)['version'];
  return typeof v === 'string' ? v : undefined;
}

/** Notification body text: a flat list of every change across the shown
 *  releases, else a generic line. */
function changelogBody(data: AppUpdateData): string {
  const all = data.releases.flatMap((r) => r.changes);
  if (all.length) return all.join(' • ');
  return 'Reopen Goalden to update to the latest version.';
}
