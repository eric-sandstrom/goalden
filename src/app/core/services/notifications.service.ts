import { Injectable, computed, inject, signal } from '@angular/core';
import { FirebaseApp } from 'firebase/app';
import { Firestore, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { Messaging, getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { MatSnackBar } from '@angular/material/snack-bar';
import { environment } from '../../../environments/environment';
import { FIREBASE_APP, FIRESTORE } from '../firebase/firebase.providers';
import { AuthService } from './auth.service';

/** Notification permission state, plus an 'unsupported' sentinel for browsers
 *  without the Notification API (older iOS Safari, locked-down WebViews). */
export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

/** Scope for the FCM service worker. Kept off the root so it coexists with the
 *  Angular service worker (ngsw-worker.js, scope '/') instead of replacing it. */
const FCM_SW_SCOPE = '/firebase-cloud-messaging-push-scope';
const DEVICE_ID_KEY = 'goalden.deviceId';

/**
 * Browser/OS notifications.
 *
 * Two layers:
 *   1. **Local** — `showLocal()` pops an OS notification from the page (used by
 *      AppUpdateService for "new version available"). No server involved; works
 *      whenever the app is open and permission is granted.
 *   2. **Push (FCM)** — `enable()` requests permission and, if granted,
 *      registers this device's FCM token (stored at users/{uid}/devices/{id})
 *      so Cloud Functions can push even when the app is closed. Needs
 *      `environment.vapidKey` set; without it, push is skipped (local still
 *      works). Foreground messages are surfaced via `showLocal`.
 *
 * The FCM SW (public/firebase-messaging-sw.js) handles background push and is
 * registered at its own scope so it doesn't clash with the Angular SW.
 */
@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly app = inject(FIREBASE_APP);
  private readonly db = inject(FIRESTORE);
  private readonly auth = inject(AuthService);
  private readonly snackBar = inject(MatSnackBar);

  private readonly _permission = signal<NotificationPermissionState>(readPermission());
  /** Current OS permission state. */
  readonly permission = this._permission.asReadonly();
  /** Whether the browser can show notifications at all. */
  readonly supported =
    typeof Notification !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  /** True once the user has granted permission. */
  readonly enabled = computed(() => this._permission() === 'granted');

  private messaging: Messaging | null = null;
  private pushRegistered = false;

  /**
   * Request OS notification permission (call from a user gesture — a click).
   * On grant, registers this device for FCM push. Returns the final state.
   */
  async enable(): Promise<NotificationPermissionState> {
    if (!this.supported) {
      this._permission.set('unsupported');
      return 'unsupported';
    }
    let perm = Notification.permission as NotificationPermissionState;
    if (perm === 'default') {
      perm = (await Notification.requestPermission()) as NotificationPermissionState;
    }
    this._permission.set(perm);
    if (perm === 'granted') {
      await this.registerForPush();
    }
    return perm;
  }

  /**
   * Show a local OS notification. No-op unless permission is granted. Prefers
   * the service worker registration (required on mobile) and falls back to the
   * page `Notification` constructor on desktop browsers without an active SW.
   */
  async showLocal(title: string, body: string, tag?: string): Promise<void> {
    if (this._permission() !== 'granted') return;
    const options: NotificationOptions = {
      body,
      icon: 'icons/icon-192x192.png',
      // Monochrome silhouette for the Android status bar (alpha-masked to white);
      // the full-colour icon above is the large image in the notification body.
      badge: 'icons/badge-96x96.png',
      tag,
    };
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) {
        await reg.showNotification(title, options);
        return;
      }
    } catch {
      // fall through to the page-level constructor
    }
    try {
      new Notification(title, options);
    } catch {
      // Some browsers only allow notifications from a SW context — nothing to
      // do here; the in-app snackbar still covers the message.
    }
  }

  /** If permission was granted in a previous session, re-register the push
   *  token on startup (tokens rotate; keeping the stored one fresh). Safe to
   *  call unconditionally — it no-ops unless already granted. */
  async syncOnStartup(): Promise<void> {
    if (this.supported && Notification.permission === 'granted') {
      this._permission.set('granted');
      await this.registerForPush();
    }
  }

  // --- FCM push registration ------------------------------------------------

  private async registerForPush(): Promise<void> {
    if (this.pushRegistered) return;
    const vapidKey = environment.vapidKey;
    if (!vapidKey) {
      console.info(
        '[Notifications] environment.vapidKey not set — FCM push disabled (local notifications still work).',
      );
      return;
    }
    if (!(await isSupported().catch(() => false))) return;
    try {
      const swReg = await navigator.serviceWorker.register('firebase-messaging-sw.js', {
        scope: FCM_SW_SCOPE,
      });
      this.messaging = getMessaging(this.app);
      const token = await getToken(this.messaging, {
        vapidKey,
        serviceWorkerRegistration: swReg,
      });
      if (!token) return;
      await this.storeToken(token);
      this.pushRegistered = true;

      // Foreground: the browser won't auto-show a notification while the page
      // is focused, so surface it ourselves (OS notification + snackbar).
      onMessage(this.messaging, (payload) => {
        const title = payload.notification?.title ?? 'Goalden';
        const body = payload.notification?.body ?? '';
        void this.showLocal(title, body, 'fcm');
        if (body) this.snackBar.open(`${title} — ${body}`, 'Dismiss', { duration: 5000 });
      });
    } catch (e: unknown) {
      console.warn('[Notifications] FCM registration failed', e);
    }
  }

  private async storeToken(token: string): Promise<void> {
    const uid = this.auth.uid();
    if (!uid) return;
    await setDoc(
      doc(this.db, `users/${uid}/devices/${this.deviceId()}`),
      { fcmToken: token, platform: platform(), updatedAt: serverTimestamp() },
      { merge: true },
    );
  }

  /** Stable per-browser id so re-registering updates one device doc rather
   *  than spawning a new one each session. */
  private deviceId(): string {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = `web-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  }
}

function readPermission(): NotificationPermissionState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission as NotificationPermissionState;
}

function platform(): 'web-android' | 'web-ios' | 'web-desktop' {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/android/i.test(ua)) return 'web-android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'web-ios';
  return 'web-desktop';
}
