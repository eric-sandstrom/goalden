import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { MatRippleModule } from '@angular/material/core';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';

interface NavLink {
  readonly path: string;
  readonly icon: string;
  readonly label: string;
  readonly exact?: boolean;
}

@Component({
  selector: 'app-bottom-nav',
  imports: [RouterLink, RouterLinkActive, MatIconModule, MatRippleModule, MatToolbarModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './bottom-nav.component.html',
  styleUrl: './bottom-nav.component.scss',
})
export class BottomNavComponent {
  protected readonly links: readonly NavLink[] = [
    { path: '/', icon: 'home', label: 'Home', exact: true },
    { path: '/predict', icon: 'sports_soccer', label: 'Predict' },
    // /leaderboard merged into /leagues — each league row shows the
    // caller's rank and points, so the standalone leaderboard tab is
    // redundant.
    { path: '/leagues', icon: 'leaderboard', label: 'Leagues' },
    { path: '/profile', icon: 'person', label: 'Profile' },
  ];
}
