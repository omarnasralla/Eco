'use client';

import { api } from './api-client';

/**
 * Web push subscription, from the browser's side.
 *
 * The one thing worth knowing before reading this: on iOS, push works only for
 * a site added to the Home Screen. Apple does not permit it from a Safari tab,
 * and there is no API to ask for it — `Notification` simply does not exist
 * there. So the check below is not defensive coding, it is the actual rule,
 * and `unsupported` is the common answer on an iPhone rather than a rare one.
 */
export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'granted' | 'default';

/** Whether this looks like a Home Screen web app rather than a browser tab. */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari's own flag, which predates the standard one and is still what
    // iOS sets for a Home Screen app.
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

export function pushState(): PushState {
  if (typeof window === 'undefined') return 'unsupported';
  const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // On an iPhone this is almost always "you are in a Safari tab", which is
    // fixable, rather than "your browser cannot do this", which is not.
    return isApple ? 'needs-install' : 'unsupported';
  }
  if (isApple && !isInstalled()) return 'needs-install';
  return Notification.permission as PushState;
}

/**
 * Ask permission, subscribe, and register the subscription with the API.
 *
 * Returns the resulting state rather than throwing on refusal: a person saying
 * no to notifications is an ordinary outcome, not an error.
 */
export async function subscribeToPush(): Promise<PushState> {
  const state = pushState();
  if (state === 'unsupported' || state === 'needs-install' || state === 'denied') return state;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission as PushState;

  const { publicKey } = await api.get<{ publicKey: string | null }>('/notifications/push-key');
  if (!publicKey) throw new Error('Push is not configured on the server');

  const registration = await navigator.serviceWorker.register('/eco/app/push-sw.js', {
    scope: '/eco/app/',
  });
  await navigator.serviceWorker.ready;

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      // Required by every browser: a push that cannot be shown to the user is
      // not allowed to be delivered silently.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = subscription.toJSON() as { endpoint?: string; keys?: Record<string, string> };
  await api.post('/notifications/push-tokens', {
    token: json.endpoint,
    platform: 'WEB',
    deviceName: deviceName(),
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth,
  });
  return 'granted';
}

/** A name the user will recognise in a list of their own devices. */
function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'This device';
}

/**
 * The VAPID key travels as base64url and the browser wants raw bytes.
 * `atob` needs standard base64 and correct padding, hence both fixes.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const standard = padded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(standard);
  // Backed by a plain ArrayBuffer explicitly: `Uint8Array.from` yields
  // Uint8Array<ArrayBufferLike>, which could be a SharedArrayBuffer, and
  // `applicationServerKey` will not take one.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
