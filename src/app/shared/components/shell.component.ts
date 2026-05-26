import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { BottomNavComponent } from './bottom-nav.component';
import { InstallBannerComponent } from './install-banner.component';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, BottomNavComponent, InstallBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="content">
      <app-install-banner />
      <router-outlet />
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
