import { getPushConfig, registerPushSubscription } from './api.js';

/**
 * The push client. Everything here is feature-detected and permission is
 * requested ON TAP ONLY — a permission prompt on load from an app whose whole
 * pitch is calm would be a betrayal, and browsers punish it anyway.
 *
 * iOS Safari has no pushManager unless the app is installed to the home
 * screen; some browsers have none at all. Unsupported platforms simply never
 * see the affordance — degrading silently is the design, not a shortcut.
 */

/** Whether this browser could deliver a push at all. */
export function pushSupported(): boolean {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    'showNotification' in (window.ServiceWorkerRegistration?.prototype ?? {})
  );
}

/**
 * Whether push can be OFFERED right now: supported here, and the deployment
 * holds a VAPID keypair (404 from the config endpoint means it does not).
 * Called before rendering the affordance, so an unusable button never shows.
 */
export async function pushAvailable(): Promise<{ available: boolean; vapidPublicKey: string }> {
  if (!pushSupported()) return { available: false, vapidPublicKey: '' };
  const config = await getPushConfig();
  if (!config.ok || typeof config.data.vapidPublicKey !== 'string' || config.data.vapidPublicKey === '') {
    return { available: false, vapidPublicKey: '' };
  }
  return { available: true, vapidPublicKey: config.data.vapidPublicKey };
}

export type PushOutcome = 'subscribed' | 'denied' | 'unavailable' | 'failed';

/** The base64url VAPID key, as the BufferSource subscribe() wants. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalised);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

/**
 * Subscribe this device and attach the subscription to a session. MUST be
 * called from a user gesture: the permission prompt is the first await, so
 * the browser still counts the tap as the trigger.
 */
export async function enablePushForSession(
  code: string,
  vapidPublicKey: string,
): Promise<PushOutcome> {
  if (!pushSupported()) return 'unavailable';

  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return 'failed';
  }
  if (permission !== 'granted') return 'denied';

  try {
    // getRegistration rather than .ready: .ready never resolves when no
    // worker is registered (dev builds), and a hung button helps no one.
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration === undefined) return 'unavailable';
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      }));
    const posted = await registerPushSubscription(code, subscription.toJSON());
    return posted.ok ? 'subscribed' : 'failed';
  } catch {
    return 'failed';
  }
}

const SUBSCRIBED_PREFIX = 'push.subscribed.';

/** Whether THIS session already got this device's subscription (local memory
    of a server-side fact — good enough to render the control truthfully). */
export function rememberedSubscription(code: string): boolean {
  try {
    return sessionStorage.getItem(`${SUBSCRIBED_PREFIX}${code}`) === '1';
  } catch {
    return false;
  }
}

export function rememberSubscription(code: string): void {
  try {
    sessionStorage.setItem(`${SUBSCRIBED_PREFIX}${code}`, '1');
  } catch {
    // Convenience only.
  }
}
