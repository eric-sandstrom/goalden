import { ActivatedRouteSnapshot, ViewTransitionInfo } from '@angular/router';

/**
 * Directional route transitions.
 *
 * `withViewTransitions()` fires this on every routed navigation. We compare the
 * URL we're leaving with the one we're entering and stamp a direction onto
 * `<html data-route-direction>`, which `styles.scss` reads to pick a slide:
 *
 *   - navigating to a *child* of the current route  → 'forward' (slide left)
 *   - navigating to an *ancestor* of the current one → 'back'    (slide right)
 *   - siblings / unrelated routes (e.g. bottom-nav tab switches) → no attribute,
 *     so the default cross-fade applies.
 *
 * Direction is decided purely by path-segment containment, so it needs no
 * navigation history and stays correct on deep links and browser back/forward.
 */

/** Primary-outlet URL segments from the root of the tree down to the leaf. */
function segmentsOf(snapshot: ActivatedRouteSnapshot | null | undefined): string[] {
  if (!snapshot) return [];
  // The handler may be handed any node in the tree; normalise to the root...
  let root: ActivatedRouteSnapshot = snapshot;
  while (root.parent) root = root.parent;
  // ...then walk back down the primary-outlet chain collecting every segment.
  const segments: string[] = [];
  for (let node: ActivatedRouteSnapshot | null = root; node; node = node.firstChild) {
    for (const seg of node.url) segments.push(seg.path);
  }
  return segments;
}

/** True when `prefix` is a strict ancestor path of `path` (shorter + matching). */
function isAncestorOf(prefix: string[], path: string[]): boolean {
  if (prefix.length >= path.length) return false;
  return prefix.every((seg, i) => seg === path[i]);
}

type RouteDirection = 'forward' | 'back';

function directionFor(from: string[], to: string[]): RouteDirection | null {
  // Into a sub-route of where we are → forward. The `from.length` guard keeps
  // the empty root path ('') from being treated as everyone's parent, so plain
  // top-level tab switches stay undirected (a fade).
  if (from.length >= 1 && isAncestorOf(from, to)) return 'forward';
  // Up to an ancestor of where we are → back.
  if (to.length >= 1 && isAncestorOf(to, from)) return 'back';
  return null;
}

export function onRouteViewTransition({ transition, from, to }: ViewTransitionInfo): void {
  const root = document.documentElement;
  const direction = directionFor(segmentsOf(from), segmentsOf(to));

  if (direction) {
    root.setAttribute('data-route-direction', direction);
  } else {
    root.removeAttribute('data-route-direction');
  }

  // Clear once the animation settles so a stale direction can't leak into the
  // next (possibly undirected) navigation.
  void transition.finished.finally(() => {
    root.removeAttribute('data-route-direction');
  });
}
