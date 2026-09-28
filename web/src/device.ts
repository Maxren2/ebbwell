// Per-device conveniences kept in localStorage (may be unavailable: private mode, blocked storage).

const BIOMETRIC_KEY = 'ebbwell:biometric';

export function hasDeviceBiometric(): boolean {
  try {
    return localStorage.getItem(BIOMETRIC_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDeviceBiometric(on: boolean) {
  try {
    if (on) localStorage.setItem(BIOMETRIC_KEY, '1');
    else localStorage.removeItem(BIOMETRIC_KEY);
  } catch {
    /* storage unavailable: the biometric button simply stays hidden */
  }
}

/** Installed to the home screen (required for Web Push on iOS). */
export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Service workers, push and biometrics need HTTPS (not available on plain-HTTP LAN access). */
export const secureContext = () => window.isSecureContext;

export function pushSupported(): boolean {
  return secureContext() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
