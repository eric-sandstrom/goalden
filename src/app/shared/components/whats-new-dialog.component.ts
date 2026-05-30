import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';

/**
 * One deployed release: a version label plus the bullet list of what changed
 * in it. Carried inside the service-worker version's `appData.releases` array
 * (set in `ngsw-config.json`).
 */
export interface AppRelease {
  /** Human-facing version label, e.g. "1.3.0". */
  version?: string;
  /** Short bullet list of what changed in this release. */
  changes: string[];
}

/**
 * The change-log payload handed to the dialog: the releases to show, newest
 * first. When the user is several versions behind, this holds every release
 * between their current build and the latest — not just the newest one. May be
 * empty (a deploy that didn't bump the change log), and the dialog degrades
 * gracefully to a generic "reload" message.
 */
export interface AppUpdateData {
  releases: AppRelease[];
}

/**
 * "What's new" dialog shown when a new app version is ready. Lists the change
 * log — one section per release the user skipped — carried on the service-worker
 * version manifest, and offers a Reload now / Later choice. Resolves (via
 * `MatDialogRef`) to `true` when the user chooses to reload, `undefined`/`false`
 * otherwise.
 */
@Component({
  selector: 'app-whats-new-dialog',
  imports: [MatButtonModule, MatDialogModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './whats-new-dialog.component.html',
  styleUrl: './whats-new-dialog.component.scss',
})
export class WhatsNewDialogComponent {
  private readonly ref = inject(MatDialogRef<WhatsNewDialogComponent, boolean>);
  protected readonly data = inject<AppUpdateData>(MAT_DIALOG_DATA);

  protected get releases(): AppRelease[] {
    return this.data.releases;
  }

  /** Title suffix — the latest version, shown only when it's labelled. The
   *  newest release is first in the array. */
  protected get versionLabel(): string {
    const latest = this.data.releases[0]?.version;
    return latest ? ` in ${latest}` : '';
  }

  /** Only label each section with its version when there's more than one —
   *  a single release reads cleaner as a plain bullet list under the title. */
  protected get showVersionHeadings(): boolean {
    return this.data.releases.length > 1;
  }

  protected later(): void {
    this.ref.close(false);
  }

  protected reload(): void {
    this.ref.close(true);
  }
}
