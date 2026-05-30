import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

/**
 * Persistence + restore for the Predict view's location (which competition
 * and which filter tab). The URL is the source of truth while you're on the
 * page; these localStorage values let a *bare* `/predict` (the bottom-nav
 * link, the home "predict" link) restore where you last were.
 */

/** Last-viewed competition, stored as the `${compId}_${season}` tab key. */
const STORAGE_KEY_SELECTED_COMP = 'goalden:predict-selected-comp';

/** Last-viewed filter tab, stored as the raw lower-cased `:tab` segment. */
const STORAGE_KEY_SELECTED_TAB = 'goalden:predict-selected-tab';

export function readSelectedComp(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(STORAGE_KEY_SELECTED_COMP);
  } catch {
    return null;
  }
}

export function writeSelectedComp(key: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY_SELECTED_COMP, key);
  } catch {
    // localStorage disabled / quota exceeded — fine, the URL still drives
    // current-session behaviour, only cross-session restore is lost.
  }
}

export function readSelectedTab(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(STORAGE_KEY_SELECTED_TAB);
  } catch {
    return null;
  }
}

export function writeSelectedTab(tab: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY_SELECTED_TAB, tab);
  } catch {
    // See writeSelectedComp.
  }
}

/**
 * Guards the bare `/predict` route: if we remember a competition, redirect
 * straight to `/predict/:comp/:tab` so pressing "Predict" returns you to the
 * exact view you left. Doing this at the routing layer (rather than letting
 * the component navigate after it mounts) means the bare URL never commits,
 * so no in-flight view transition gets aborted.
 *
 * Returns `true` when nothing is saved yet (a first-ever visit) — the bare
 * route renders and PredictComponent resolves a sensible default itself.
 */
export const predictLastLocationGuard: CanActivateFn = () => {
  const comp = readSelectedComp();
  if (!comp) return true;
  const tab = readSelectedTab() ?? 'upcoming';
  return inject(Router).createUrlTree(['/predict', comp, tab]);
};
