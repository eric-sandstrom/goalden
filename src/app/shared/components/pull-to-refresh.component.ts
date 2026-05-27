import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

/**
 * Pull-to-refresh gesture for the PWA.
 *
 * Installed PWAs don't get the browser's native pull-to-refresh — the
 * gesture is swallowed by the standalone display mode. This component
 * adds it back: drag down from the top of any scrollable container,
 * release past the threshold, and the page reloads.
 *
 * Mechanics:
 *   - Host catches bubbling touchstart/move/end so the gesture works
 *     anywhere inside the projected content.
 *   - On touchstart we walk up from the touch target to find the
 *     nearest scrollable ancestor (overflow-y auto/scroll with content
 *     to scroll). If it's already scrolled, we ignore — the gesture is
 *     normal scrolling, not a refresh intent.
 *   - On touchmove with deltaY > 0 and scrollable ancestor at top, we
 *     enter `pulling`. A sqrt resistance curve means the indicator
 *     slows the further you pull, matching native feel.
 *   - At `threshold` px the state flips to `armed` — icon flips
 *     direction to telegraph "release to refresh".
 *   - touchend in `armed` state → `refreshing` → location.reload().
 *
 * Mouse / pointer events are intentionally NOT handled — the gesture
 * has no meaning on desktop (the browser's reload button is right
 * there) and supporting it would conflict with text selection / drag.
 */
@Component({
  selector: 'app-pull-to-refresh',
  imports: [MatIconModule, MatProgressSpinnerModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pull-to-refresh.component.html',
  styleUrl: './pull-to-refresh.component.scss',
  host: {
    '(touchstart)': 'onTouchStart($event)',
    '(touchmove)': 'onTouchMove($event)',
    '(touchend)': 'onTouchEnd()',
    '(touchcancel)': 'onTouchEnd()',
  },
})
export class PullToRefreshComponent {
  /** Pixels you have to pull past for the gesture to commit. Tuned to
   *  feel like Material's standard refresh indicator on Android. */
  private readonly threshold = 80;

  protected readonly state = signal<'idle' | 'pulling' | 'armed' | 'refreshing'>('idle');
  private readonly _offset = signal(0);
  /** Normalised raw pull progress, 0..1+ as a ratio of threshold.
   *  Tracked separately from _offset (which is damped for visual
   *  smoothness) so the icon rotation reflects the actual pull. */
  private readonly _progress = signal(0);

  private startY = 0;
  private startTime = 0;

  /** Damped pull offset: visual movement < raw finger movement so a
   *  long pull doesn't yank the indicator down endlessly. Square-root
   *  curve matches what Material does on Android. */
  protected readonly indicatorTransform = computed(() => {
    const o = this._offset();
    return `translateY(${o - 40}px)`;
  });

  /** Refresh-icon rotation: 0deg at idle, ~360deg at threshold, locks
   *  at 360deg past that so over-pulling doesn't keep spinning. */
  protected readonly iconRotation = computed(() => {
    const p = Math.min(this._progress(), 1);
    return `rotate(${p * 360}deg)`;
  });

  protected readonly visible = computed(() => this.state() !== 'idle');

  protected onTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) return; // multi-touch (pinch) — not us
    if (this.state() === 'refreshing') return; // ignore while reloading

    const target = event.target as HTMLElement | null;
    const scrollable = this.findScrollableAncestor(target);
    if (scrollable && scrollable.scrollTop > 0) {
      // The element under the finger is scrolled — user is in normal
      // scrolling territory, not pulling. Stay idle.
      return;
    }

    this.startY = event.touches[0].clientY;
    this.startTime = Date.now();
    this.state.set('pulling');
    this._offset.set(0);
  }

  protected onTouchMove(event: TouchEvent): void {
    if (this.state() !== 'pulling' && this.state() !== 'armed') return;

    const currentY = event.touches[0].clientY;
    const rawDelta = currentY - this.startY;

    if (rawDelta <= 0) {
      // User started pulling down but reversed direction — cancel.
      // Doing this rather than just clamping to 0 lets a normal up-scroll
      // pass through cleanly instead of being stuck in 'pulling'.
      this.cancel();
      return;
    }

    // Square-root damping: at delta=80 the visual offset is ~28.
    // Multiply by 4 to bring it back to a sensible visual range.
    const damped = Math.sqrt(rawDelta) * 4;
    this._offset.set(damped);
    // Raw (un-damped) progress drives the icon rotation. It can exceed
    // 1 — the rotation getter clamps so over-pull doesn't keep spinning.
    this._progress.set(rawDelta / this.threshold);

    // Flip armed/pulling based on the RAW pull distance, not the damped
    // visual. That makes the threshold feel consistent across screen
    // sizes without needing per-device tuning.
    if (rawDelta >= this.threshold) {
      if (this.state() !== 'armed') this.state.set('armed');
    } else if (this.state() === 'armed') {
      this.state.set('pulling');
    }
  }

  protected onTouchEnd(): void {
    const s = this.state();
    if (s === 'armed') {
      this.state.set('refreshing');
      // Hold the indicator at threshold position while reload kicks off.
      this._offset.set(this.threshold);
      // location.reload() blocks the JS thread momentarily, then the
      // page navigates away — no need to clean up our state, the new
      // page starts fresh.
      window.location.reload();
      return;
    }
    if (s === 'pulling') {
      this.cancel();
    }
  }

  private cancel(): void {
    this.state.set('idle');
    this._offset.set(0);
    this._progress.set(0);
  }

  /** Walk up from the touch target until we find an element that is
   *  scrollable AND has overflowing content. Stops at <body>. */
  private findScrollableAncestor(el: HTMLElement | null): HTMLElement | null {
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      const canScroll = overflowY === 'auto' || overflowY === 'scroll';
      if (canScroll && el.scrollHeight > el.clientHeight) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }
}
