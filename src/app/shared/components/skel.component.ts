import { ChangeDetectionStrategy, Component, booleanAttribute, input } from '@angular/core';

/**
 * Shimmer skeleton placeholder. Pure visual primitive — use for loading states
 * instead of mat-progress-spinner where the layout is known ahead of time.
 *
 * Usage:
 *   <app-skel width="60%" height="1.2em" />
 *   <app-skel width="40px" height="40px" rounded />
 *   <app-skel block height="48px" />   // full-width block
 */
@Component({
  selector: 'app-skel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: {
    '[style.width]': 'width()',
    '[style.height]': 'height()',
    '[style.borderRadius]': "rounded() ? '50%' : null",
    '[style.display]': "block() ? 'block' : 'inline-block'",
    'aria-hidden': 'true',
  },
  styles: `
    :host {
      background: linear-gradient(
        100deg,
        var(--mat-sys-surface-container) 30%,
        var(--mat-sys-surface-container-high) 50%,
        var(--mat-sys-surface-container) 70%
      );
      background-size: 200% 100%;
      animation: skel-shimmer 1.4s linear infinite;
      border-radius: 6px;
      vertical-align: middle;
    }
    @keyframes skel-shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      :host {
        animation: none;
        background: var(--mat-sys-surface-container-high);
      }
    }
  `,
})
export class SkelComponent {
  readonly width = input<string>('100%');
  readonly height = input<string>('1em');
  readonly rounded = input(false, { transform: booleanAttribute });
  readonly block = input(false, { transform: booleanAttribute });
}
