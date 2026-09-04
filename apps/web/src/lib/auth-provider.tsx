'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { LoginInput, LoginResponseDto, RegisterInput, UserDto } from '@eco/shared';
import { api, ApiError, setSessionExpiredHandler } from './api-client';
import {
  clearTokens,
  getAccessToken,
  getCachedProfile,
  getRefreshToken,
  storeProfile,
  storeTokens,
} from './tokens';

interface AuthContextValue {
  user: UserDto | null;
  /** True until the initial session check completes. */
  isLoading: boolean;
  /**
   * Whether a session exists — derived from the presence of tokens, not from
   * whether the profile happened to load. A rate-limited or briefly failing
   * `/users/me` must not read as "signed out"; the tokens are still valid and
   * the next request will work.
   */
  isAuthenticated: boolean;
  login: (input: LoginInput) => Promise<LoginResponseDto>;
  completeTwoFactor: (challengeToken: string, totpCode: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<UserDto | null>(null);
  const [hasSession, setHasSession] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const applyUser = useCallback((next: UserDto) => {
    setUser(next);
    storeProfile(next);
    setHasSession(true);
  }, []);

  const signOutLocally = useCallback(() => {
    clearTokens();
    setUser(null);
    setHasSession(false);
  }, []);

  // The API client calls this when a refresh fails, so a revoked session
  // lands on the login page instead of silently failing every request.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      signOutLocally();
      router.replace('/login');
    });
  }, [router, signOutLocally]);

  const loadUser = useCallback(async () => {
    // Token presence is the source of truth for "is there a session". The
    // profile fetch only fills in the details.
    if (!getAccessToken() && !getRefreshToken()) {
      setUser(null);
      setHasSession(false);
      setIsLoading(false);
      return;
    }

    setHasSession(true);

    // Render immediately from the cached profile so money is formatted in the
    // user's own currency from the first paint, then revalidate underneath.
    const cached = getCachedProfile<UserDto>();
    if (cached) setUser(cached);

    try {
      applyUser(await api.get<UserDto>('/users/me'));
    } catch (error) {
      // Only a rejected credential ends the session. A 429 from the rate
      // limiter or a 5xx from a restarting API is transient — signing the user
      // out there loses their place over a hiccup.
      if (error instanceof ApiError && error.status === 401) signOutLocally();
    } finally {
      setIsLoading(false);
    }
  }, [applyUser, signOutLocally]);

  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  const login = useCallback(async (input: LoginInput): Promise<LoginResponseDto> => {
    const result = await api.post<LoginResponseDto>('/auth/login', input, { anonymous: true });

    // A 2FA challenge is not a completed sign-in: return it so the form can
    // collect a code, and store nothing yet.
    if (result.twoFactorRequired) return result;

    if (result.tokens && result.user) {
      storeTokens(result.tokens);
      applyUser(result.user);
    }
    return result;
  }, [applyUser]);

  const completeTwoFactor = useCallback(async (challengeToken: string, totpCode: string) => {
    const result = await api.post<LoginResponseDto>(
      '/auth/login/2fa',
      { challengeToken, totpCode },
      { anonymous: true },
    );
    if (result.tokens && result.user) {
      storeTokens(result.tokens);
      applyUser(result.user);
    }
  }, [applyUser]);

  const register = useCallback(async (input: RegisterInput) => {
    const result = await api.post<LoginResponseDto>('/auth/register', input, { anonymous: true });
    if (result.tokens && result.user) {
      storeTokens(result.tokens);
      applyUser(result.user);
    }
  }, [applyUser]);

  const logout = useCallback(async () => {
    try {
      // Best effort: revoke server-side, but always clear locally. A failed
      // network call must not leave the user apparently still signed in.
      const { getRefreshToken } = await import('./tokens');
      await api.post('/auth/logout', { refreshToken: getRefreshToken() });
    } catch {
      /* ignore */
    } finally {
      signOutLocally();
      router.replace('/login');
    }
  }, [router, signOutLocally]);

  const value = useMemo(
    () => ({
      user,
      isLoading,
      isAuthenticated: hasSession,
      login,
      completeTwoFactor,
      register,
      logout,
      refreshUser: loadUser,
    }),
    [user, hasSession, isLoading, login, completeTwoFactor, register, logout, loadUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/**
 * The user's own currency and locale, with safe defaults before the profile
 * has loaded. Every money formatter in the UI reads from here rather than
 * hardcoding a currency.
 */
