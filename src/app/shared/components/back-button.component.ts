import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { NavigationHistoryService } from '../../core/services/navigation-history.service';

/**
 * Slim "back to {previous}" pill that sits at the top of any non-tab-root
 * page. Reads its visibility + label from `NavigationHistoryService`:
 *
 *   - Hidden on bottom-nav root paths (Home / Predict / Leagues / Profile)
 *     even if there's app history — those pages use the tab bar to switch.
 *   - Hidden when there's no previous entry to go back to (e.g. the user
 *     deep-linked into the app and we have no in-app history yet).
 *
 * Click handler delegates to `history.back()` via the service, so:
 *   1. The browser's URL bar and the back-button stay in lockstep
 *      (no extra forward entry pushed onto the stack).
 *   2. The user's next press of the browser back button does what they
 *      expect — go one more step back, not redo our navigation.
 */
@Component({
  selector: 'app-back-button',
  imports: [MatButtonModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <button
        type="button"
        mat-button
        class="back-btn"
        (click)="goBack()"
        [attr.aria-label]="ariaLabel()"
      >
        <mat-icon>chevron_left</mat-icon>
        Back to {{ previousLabel() }}
      </button>
    }
  `,
  styles: `
    :host {
      /* Mirror .page's centered column so the back button sits in the
         same horizontal band as the content cards below it: max 720px
         wide, centered, with 1rem horizontal padding. */
      display: block;
      flex: 0 0 auto;
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
      box-sizing: border-box;
      padding: 0.5rem 1rem 0;
    }
    .back-btn {
      /* Cancel mat-button's default leading padding so the chevron lines
         up with the content's left edge, not 8px inside it. */
      padding-left: 0;
      padding-right: 0.75rem;
      min-width: 0;
    }
  `,
})
export class BackButtonComponent {
  private readonly history = inject(NavigationHistoryService);

  protected readonly visible = this.history.canGoBack;
  protected readonly previousLabel = computed(() => this.history.previous()?.label ?? '');
  protected readonly ariaLabel = computed(() => {
    const label = this.previousLabel();
    return label ? `Back to ${label}` : 'Back';
  });

  protected goBack(): void {
    this.history.goBack();
  }
}
