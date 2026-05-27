import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { BackButtonComponent } from './back-button.component';
import { BottomNavComponent } from './bottom-nav.component';
import { InstallBannerComponent } from './install-banner.component';
import { PullToRefreshComponent } from './pull-to-refresh.component';

@Component({
  selector: 'app-shell',
  imports: [
    RouterOutlet,
    BackButtonComponent,
    BottomNavComponent,
    InstallBannerComponent,
    PullToRefreshComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="content">
      <app-install-banner />
      <app-back-button />
      <!-- Wraps the routed view so the pull-to-refresh gesture can
           detect touchstart on whatever the user is actually scrolling.
           Routes that don't scroll just don't trigger the gesture. -->
      <app-pull-to-refresh>
        <router-outlet />
      </app-pull-to-refresh>
    </main>
    <app-bottom-nav />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }
    .content {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    app-install-banner {
      flex: 0 0 auto;
    }
  `,
})
export class ShellComponent {}
