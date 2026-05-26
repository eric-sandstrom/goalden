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
  template: `
    <mat-toolbar class="bottom-nav" aria-label="Main">
      @for (link of links; track link.path) {
        <a
          class="nav-item"
          matRipple
          [routerLink]="link.path"
          routerLinkActive="active"
          [routerLinkActiveOptions]="{ exact: link.exact ?? false }"
          [attr.aria-label]="link.label"
        >
          <mat-icon aria-hidden="true">{{ link.icon }}</mat-icon>
          <span class="label">{{ link.label }}</span>
        </a>
      }
    </mat-toolbar>
  `,
  styles: `
    .bottom-nav {
      flex: 0 0 auto;
      display: flex;
      justify-content: space-around;
      gap: 4px;
      padding: 6px 8px max(6px, env(safe-area-inset-bottom, 0px));
      background: var(--mat-sys-surface-container);
      border-top: 1px solid var(--mat-sys-outline-variant);
      z-index: 100;
      height: auto;
      min-height: 64px;
    }
    .nav-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      padding: 6px 10px;
      text-decoration: none;
      color: var(--mat-sys-on-surface-variant);
      flex: 1;
      max-width: 96px;
      border-radius: 16px;
      transition: color 120ms ease, background-color 120ms ease;
      position: relative;
      overflow: hidden;
    }
    .nav-item.active {
      color: var(--mat-sys-on-secondary-container);
      background: var(--mat-sys-secondary-container);
    }
    .label {
      font-size: 11px;
      line-height: 1;
      font-weight: 500;
    }
  `,
})
export class BottomNavComponent {
  protected readonly links: readonly NavLink[] = [
    { path: '/', icon: 'home', label: 'Home', exact: true },
    { path: '/predict', icon: 'sports_soccer', label: 'Predict' },
    { path: '/leaderboard', icon: 'leaderboard', label: 'Boards' },
    { path: '/leagues', icon: 'groups', label: 'Leagues' },
    { path: '/profile', icon: 'person', label: 'Profile' },
  ];
}
