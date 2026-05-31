import { Injectable, signal } from '@angular/core';

/**
 * Coordinates the shared-element view transition between the match list
 * (`/matches`) and the match detail (`/matches/:id`).
 *
 * `view-transition-name` must be UNIQUE across the document while a transition
 * runs, so we can't stamp the same name onto every row's score/crest/name — the
 * browser would refuse to animate. Instead exactly one fixture is "active" at a
 * time, and only that row paints the shared names. The detail view always paints
 * them (there's only ever one detail on screen), so the pair lines up:
 *
 *   forward (list → detail): the clicked row sets `activeFdid`, so the OLD
 *     snapshot (the list) carries the names; the detail provides their match.
 *   back (detail → list): the detail re-affirms `activeFdid` on init, so the
 *     row we return to still carries the names for the NEW snapshot.
 *
 * Stored as the bare football-data id (the `:id` route segment), not the
 * `fd-`-prefixed doc id, so both sides compare the same value.
 */
@Injectable({ providedIn: 'root' })
export class MatchTransitionService {
  private readonly _activeFdid = signal<string | null>(null);

  /** The fixture currently eligible to paint shared view-transition names. */
  readonly activeFdid = this._activeFdid.asReadonly();

  /** Mark a fixture (by bare fd id) as the shared-transition participant. */
  activate(fdid: string): void {
    this._activeFdid.set(fdid);
  }
}
