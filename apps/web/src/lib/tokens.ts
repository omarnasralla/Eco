'use client';

import type { AuthTokensDto } from '@eco/shared';

/**
 * Token storage.
 *
 * Deliberately isolated behind this module. On the web it is localStorage;
 * in React Native the same three functions are backed by expo-secure-store /
 * Keychain, and nothing else in the app changes.
 *
 * The honest trade-off: localStorage is readable by any script that achieves
 * XSS on this origin. The production answer is httpOnly refresh cookies, and
 * the API already supports that shape (cookie-parser is wired up, and the
 * refresh endpoint accepts either). This implementation keeps the token in JS
 * so the same client code runs unmodified on native, where cookies are not
 * available; the strict CSP and the short 15-minute access-token lifetime are
 * what bound the exposure until the cookie path is turned on for web.
 */

const ACCESS_KEY = 'eco.accessToken';
const REFRESH_KEY = 'eco.refreshToken';
const EXPIRES_KEY = 'eco.expiresAt';
const PROFILE_KEY = 'eco.profile';

const isBrowser = typeof window !== 'undefined';

export function getAccessToken(): string | null {
  if (!isBrowser) return null;
  try {
    return window.localStorage.getItem(ACCESS_KEY);
  } catch {
    // Private mode, or site data blocked. Treat as signed out.
    return null;
  }
}

export function getRefreshToken(): string | null {
  if (!isBrowser) return null;
  try {
    return window.localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

/** True when the access token is expired or within 30s of expiring. */
export function isAccessTokenStale(): boolean {
  if (!isBrowser) return true;
  try {
    const expiresAt = window.localStorage.getItem(EXPIRES_KEY);
    if (!expiresAt) return true;
    // A 30-second skew guard: refreshing slightly early is free, whereas
    // sending a token that expires mid-flight costs a round trip and a retry.
    return Date.now() > Number(expiresAt) - 30_000;
  } catch {
    return true;
  }
}

export function storeTokens(tokens: AuthTokensDto): void {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(ACCESS_KEY, tokens.accessToken);
    window.localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
    window.localStorage.setItem(EXPIRES_KEY, String(Date.now() + tokens.expiresIn * 1000));
  } catch {
    // Storage unavailable: the session lasts until the tab closes.
  }
}

export function clearTokens(): void {
  if (!isBrowser) return;
  try {
    window.localStorage.removeItem(ACCESS_KEY);
    window.localStorage.removeItem(REFRESH_KEY);
    window.localStorage.removeItem(EXPIRES_KEY);
    window.localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Last-known profile, cached beside the tokens.
 *
 * This is not an optimisation — it is a correctness fix. Currency and locale
 * live on the profile, and every amount in the UI is formatted with them. If
 * the profile fetch fails or is merely slow, falling back to a default renders
 * a GBP user's balances with a dollar sign, which is worse than showing
 * nothing. Caching the last-known values means the app always formats money the
 * way that user chose, and the background revalidation corrects it if it ever
 * changes.
 *
 * The exposure is the same class as the access token already stored here: a
 * name, an email and a currency, readable by script on this origin only.
 */
export function getCachedProfile<T>(): T | null {
  if (!isBrowser) return null;
  try {
    const raw = window.localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function storeProfile(profile: unknown): void {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* storage unavailable */
  }
}
