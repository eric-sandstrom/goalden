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
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent {}
