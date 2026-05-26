import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './core/services/theme.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  // Eagerly instantiate ThemeService so the persisted theme is applied to
  // `:root` before any child component paints with Material colors.
  private readonly theme = inject(ThemeService);
}
