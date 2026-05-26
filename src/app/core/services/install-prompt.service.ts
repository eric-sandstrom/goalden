import { Injectable, computed, inject, signal, DestroyRef } from '@angular/core';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

interface NavigatorWithStandalone extends Navigator {
  readonly standalone?: boolean;
}

const STORAGE_DISMISSED = 'goalden:install-dismissed';
const STORAGE_SESSIONS = 'goalden:session-count';

@Injectable({ providedIn: 'root' })
export class InstallPromptService {
  private deferred: BeforeInstallPromptEvent | null = null;

  private readonly _canInstall = signal(false);
  private readonly _dismissed = signal(this.readDismissed());
  private readonly _sessionCount = signal(this.bumpSessionCount());

  readonly canInstall = this._canInstall.asReadonly();
  readonly dismissed = this._dismissed.asReadonly();
  readonly sessionCount = this._sessionCount.asReadonly();

  readonly isIOS = computed(() => {
    if (typeof navigator === 'undefined') return false;
    return /iPhone|iPad|iPod/.test(navigator.userAgent);
  });

  readonly isStandalone = computed(() => {
    if (typeof window === 'undefined') return false;
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    return (navigator as NavigatorWithStandalone).standalone === true;
  });

  constructor() {
    const destroyRef = inject(DestroyRef);

    const handler = (e: Event) => {
      e.preventDefault();
      this.deferred = e as BeforeInstallPromptEvent;
      this._canInstall.set(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    destroyRef.onDestroy(() => window.removeEventListener('beforeinstallprompt', handler));
  }

  async install(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    if (!this.deferred) return 'unavailable';
    await this.deferred.prompt();
    const result = await this.deferred.userChoice;
    this.deferred = null;
    this._canInstall.set(false);
    return result.outcome;
  }

  dismiss(): void {
    try {
      localStorage.setItem(STORAGE_DISMISSED, '1');
    } catch {
      // localStorage might be unavailable in private modes — ignore.
    }
    this._dismissed.set(true);
  }

  private readDismissed(): boolean {
    try {
      return localStorage.getItem(STORAGE_DISMISSED) === '1';
    } catch {
      return false;
    }
  }

  private bumpSessionCount(): number {
    try {
      const current = Number(localStorage.getItem(STORAGE_SESSIONS) ?? '0') || 0;
      const next = current + 1;
      localStorage.setItem(STORAGE_SESSIONS, String(next));
      return next;
    } catch {
      return 1;
    }
  }
}
