/**
 * Persistence + restore for the Matches view's location (which competition
 * and which filter tab). The URL query string is the source of truth while
 * you're on the page; these localStorage values let a *bare* `/matches` (the
 * bottom-nav link, the home "matches" link) restore where you last were —
 * MatchesComponent reads them when no `?comp`/`?tab` query params are present
 * and canonicalises the URL.
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
