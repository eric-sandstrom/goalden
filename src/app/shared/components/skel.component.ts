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
  templateUrl: './skel.component.html',
  styleUrl: './skel.component.scss',
  host: {
    '[style.width]': 'width()',
    '[style.height]': 'height()',
    '[style.borderRadius]': "rounded() ? '50%' : null",
    '[style.display]': "block() ? 'block' : 'inline-block'",
    'aria-hidden': 'true',
  },
})
export class SkelComponent {
  readonly width = input<string>('100%');
  readonly height = input<string>('1em');
  readonly rounded = input(false, { transform: booleanAttribute });
  readonly block = input(false, { transform: booleanAttribute });
}
