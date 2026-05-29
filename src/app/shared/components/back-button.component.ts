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
  templateUrl: './back-button.component.html',
  styleUrl: './back-button.component.scss',
  host: {
    // Collapse the host entirely when there's no back button to show, so its
    // padding doesn't reserve space (which read as a stray top margin on the
    // bottom-nav root pages).
    '[class.visible]': 'visible()',
  },
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
