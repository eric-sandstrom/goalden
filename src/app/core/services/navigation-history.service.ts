import { Injectable, computed, inject, signal } from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';

export interface NavEntry {
  /** Absolute URL including any query string. */
  readonly url: string;
  /** Human-readable label shown in the back button. Derived from the
   *  URL path; static mapping for now. */
  readonly label: string;
}

/**
 * Tracks the user's in-app navigation history so the back button knows
 * (a) where it would land and (b) what to call that destination.
 *
 * Why a parallel stack instead of just reading `history.length`:
 *   - `history` is shared with the browser and includes pre-app entries
 *     (the page the user was on before they typed our URL). We can't tell
 *     which entries belong to our app.
 *   - We need a *label* for the previous page, which `history` doesn't
 *     store. So we maintain a parallel `NavEntry[]` keyed by URL.
 *
 * Stack semantics:
 *   - Imperative navigations (`router.navigate`, `routerLink` clicks, etc.)
 *     PUSH a new entry onto the stack.
 *   - Browser back / `history.back()` fires a `popstate` navigation; we
 *     POP the top entry off the stack to stay in sync.
 *   - Visiting one of the bottom-nav root paths RESETS the stack. From a
 *     tab-bar root, "back" has no semantic meaning — the user can switch
 *     tabs freely, so we don't want to show "Back to Profile" when they
 *     tap Home from Profile.
 */
@Injectable({ providedIn: 'root' })
export class NavigationHistoryService {
  private readonly router = inject(Router);

  /** The root paths reachable from the bottom nav. Visiting any of these
   *  clears the back-stack — they're considered "fresh starts". */
  private readonly bottomNavPaths = new Set<string>([
    '/',
    '/predict',
    '/leagues',
    '/profile',
  ]);

  /** Internal stack of visited URLs in order. Top of the stack is the
   *  current page. */
  private readonly _stack = signal<readonly NavEntry[]>([]);

  /** Trigger captured from the latest NavigationStart so the matching
   *  NavigationEnd can choose push vs. pop. Reset to 'imperative' each
   *  time so we don't carry a stale popstate flag across navigations. */
  private lastTrigger: 'imperative' | 'popstate' | 'hashchange' = 'imperative';

  /** Read-only view of the current stack — exposed for diagnostics. */
  readonly stack = this._stack.asReadonly();

  /** The entry the back button would navigate to, or null if there's
   *  nothing on the stack to go back to. */
  readonly previous = computed<NavEntry | null>(() => {
    const s = this._stack();
    return s.length >= 2 ? s[s.length - 2] : null;
  });

  /** Whether the back button should be visible:
   *   - There must BE a previous entry.
   *   - The current page must NOT be a bottom-nav root (those use the
   *     bottom nav itself to switch sections; no back button needed). */
  readonly canGoBack = computed<boolean>(() => {
    const s = this._stack();
    if (s.length < 2) return false;
    const current = s[s.length - 1];
    return !this.bottomNavPaths.has(this.pathOf(current.url));
  });

  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        // navigationTrigger is typed as optional but Angular always sets
        // it in practice. Default to 'imperative' if missing.
        this.lastTrigger = event.navigationTrigger ?? 'imperative';
      } else if (event instanceof NavigationEnd) {
        this.record(event.urlAfterRedirects, this.lastTrigger);
        // Reset for the next navigation so a missed NavigationStart
        // (shouldn't happen, but defensive) defaults to 'imperative'.
        this.lastTrigger = 'imperative';
      }
    });
  }

  /**
   * Pop the top of the browser history. Because browser-back ALSO emits
   * a popstate-triggered NavigationEnd, our own stack will be kept in
   * sync via `record()` — no need to mutate `_stack` here.
   *
   * If there's no app-internal history yet (deep link visit), navigate
   * to a sensible parent based on the current route.
   */
  goBack(): void {
    if (this.previous()) {
      history.back();
      return;
    }
    void this.router.navigate([this.fallbackParent(this.router.url)]);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private record(
    url: string,
    trigger: 'imperative' | 'popstate' | 'hashchange',
  ): void {
    const stack = this._stack();
    const top = stack[stack.length - 1];

    // Same URL fired twice — typically a router redirect resolving. No-op
    // so we don't double-push.
    if (top?.url === url) return;

    if (trigger === 'popstate' || trigger === 'hashchange') {
      // Browser back/forward. If the new URL matches the second-from-top,
      // it's a back step: drop the top entry. Otherwise the user went
      // forward or jumped sideways — reset to just the current entry.
      const second = stack[stack.length - 2];
      if (second?.url === url) {
        this._stack.set(stack.slice(0, -1));
      } else {
        this._stack.set([{ url, label: this.labelFor(url) }]);
      }
      return;
    }

    // Imperative navigation. If we just landed on a bottom-nav root,
    // reset the stack — those are fresh starts.
    if (this.bottomNavPaths.has(this.pathOf(url))) {
      this._stack.set([{ url, label: this.labelFor(url) }]);
      return;
    }

    this._stack.set([...stack, { url, label: this.labelFor(url) }]);
  }

  /** Strip query/fragment so route matching ignores them. */
  private pathOf(url: string): string {
    const q = url.indexOf('?');
    const h = url.indexOf('#');
    const cut = Math.min(
      q === -1 ? url.length : q,
      h === -1 ? url.length : h,
    );
    return url.slice(0, cut);
  }

  /**
   * Static URL → label map. Kept deliberately simple — looking up the
   * actual league name / player name to use in the label would require
   * cross-service calls and we don't need that level of polish for v1.
   * "Back to League" is good enough; the page header tells you which one.
   */
  private labelFor(url: string): string {
    const path = this.pathOf(url);
    if (path === '/') return 'Home';
    if (path === '/predict') return 'Predict';
    if (path === '/leagues') return 'Leagues';
    if (path === '/profile') return 'Profile';
    if (path === '/teams') return 'Teams';
    if (path === '/comp/WC/podium') return 'Podium picks';
    if (path === '/admin') return 'Admin';
    if (path === '/dev') return 'Dev tools';
    if (path.startsWith('/leagues/')) return 'League';
    if (path.startsWith('/teams/')) return 'Team';
    if (path.startsWith('/users/')) return 'Player';
    return 'Back';
  }

  /** When goBack() is called with no history (deep-link landing), guess
   *  a reasonable parent route based on the current URL. */
  private fallbackParent(url: string): string {
    const path = this.pathOf(url);
    if (path.startsWith('/leagues/')) return '/leagues';
    if (path.startsWith('/teams/')) return '/teams';
    if (path.startsWith('/users/')) return '/leagues';
    if (path === '/comp/WC/podium') return '/';
    if (path === '/admin' || path === '/dev') return '/profile';
    return '/';
  }
}
