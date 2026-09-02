'use client';

import type { ApiErrorBody, AuthTokensDto } from '@eco/shared';
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  isAccessTokenStale,
  storeTokens,
} from './tokens';

const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: ApiErrorBody,
    /** Correlates a user's bug report with the server logs. */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages from a 400, for rendering next to inputs. */
  get validationMessages(): string[] {
    const message = this.body?.message;
    if (Array.isArray(message)) return message;
    return message ? [message] : [];
  }
}

/**
 * A single in-flight refresh, shared by every caller.
 *
 * Without this, a dashboard that fires six parallel requests on mount would
 * trigger six concurrent refreshes. Five of them would present a token the
 * first has already rotated away — which the server correctly reads as token
 * reuse and punishes by revoking the entire family, logging the user out.
 * Funnelling every caller through one promise is what makes rotation safe on
 * a parallel-fetching client.
 */
let refreshInFlight: Promise<string | null> | null = null;

type SessionExpiredHandler = () => void;
let onSessionExpired: SessionExpiredHandler = () => {};

/** Lets the auth provider redirect to /login when the session dies. */
export function setSessionExpiredHandler(handler: SessionExpiredHandler): void {
  onSessionExpired = handler;
}

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return null;

    try {
      const response = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        // Only an authentication failure means the session is genuinely dead.
        // A 429 from the rate limiter, or a 5xx from a restarting API, is
        // transient — destroying the tokens there signs the user out over a
        // hiccup and loses whatever they were in the middle of.
        if (response.status === 401 || response.status === 403) {
          clearTokens();
          onSessionExpired();
        }
        return null;
      }

      const tokens = (await response.json()) as AuthTokensDto;
      storeTokens(tokens);
      return tokens.accessToken;
    } catch {
      // Network failure, not an auth failure — keep the tokens so the next
      // attempt can succeed rather than signing the user out over a blip.
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip the Authorization header (login, register, password reset). */
  anonymous?: boolean;
  query?: Record<string, string | number | boolean | undefined | null>;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  // NEXT_PUBLIC_API_URL may be relative ("/api/v1") when a reverse proxy serves
  // the app and the API from one origin — which is preferable, since it keeps
  // the deployment's host out of the bundle and lets one build serve an IP, a
  // domain and HTTPS alike. `new URL` rejects a relative string outright, so it
  // needs the page's own origin as the base. An absolute BASE_URL ignores the
  // base argument, so both forms work through this one path.
  const url = new URL(
    `${BASE_URL}${path}`,
    typeof window === 'undefined' ? undefined : window.location.origin,
  );
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, anonymous = false, query, headers, ...rest } = options;

  let accessToken: string | null = null;
  if (!anonymous) {
    // Refresh proactively when the token is about to expire, so the common
    // path is one request rather than a 401 followed by a retry.
    accessToken = isAccessTokenStale() ? await refreshAccessToken() : getAccessToken();
  }

  const send = (token: string | null): Promise<Response> =>
    fetch(buildUrl(path, query), {
      ...rest,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  let response = await send(accessToken);

  // A 401 despite a fresh-looking token: the server revoked it (password
  // change, sign-out-everywhere). Refresh once and retry exactly once.
  if (response.status === 401 && !anonymous) {
    const renewed = await refreshAccessToken();
    if (!renewed) {
      // refreshAccessToken has already signed out if the failure was an auth
      // one. If tokens survive, the refresh failed transiently and the right
      // answer is an error the caller can retry — not a forced logout.
      if (!getRefreshToken()) {
        throw new ApiError(401, 'Your session has expired. Please sign in again.');
      }
      throw new ApiError(
        response.status,
        'Could not reach the server. Please try again in a moment.',
      );
    }
    response = await send(renewed);
  }

  if (response.status === 204) return undefined as T;

  const requestId = response.headers.get('X-Request-Id') ?? undefined;

  if (!response.ok) {
    let errorBody: ApiErrorBody | undefined;
    try {
      errorBody = (await response.json()) as ApiErrorBody;
    } catch {
      /* a non-JSON error body, e.g. from a proxy */
    }

    const message = Array.isArray(errorBody?.message)
      ? errorBody.message.join(', ')
      : (errorBody?.message ?? response.statusText ?? 'Request failed');

    throw new ApiError(response.status, message, errorBody, requestId);
  }

  const contentType = response.headers.get('content-type') ?? '';

  // An empty body — no Content-Type, or an explicit zero length — is how the
  // API reports that an optional resource simply does not exist yet, such as a
  // month the user has never set a budget for. There is nothing to parse.
  //
  // This has to be caught *before* the blob fallback below. An empty Blob is a
  // truthy object, so it slips past every `if (!data)` guard in the UI and then
  // fails much later and much less legibly, as a "cannot read properties of
  // undefined" thrown from inside whichever component first reads a field.
  if (!contentType || response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  // Report exports (PDF/Excel/CSV) come back as files, not JSON.
  if (!contentType.includes('application/json')) {
    return (await response.blob()) as T;
  }

  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'DELETE' }),
};
