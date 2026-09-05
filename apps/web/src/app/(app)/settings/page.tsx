'use client';

import { useQuery } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { LogOut, Moon, ShieldCheck, Sun } from 'lucide-react';
import { CURRENCIES } from '@eco/shared';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-provider';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Session {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export default function SettingsPage() {
  const { user, logout, refreshUser } = useAuth();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const sessions = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () => api.get<Session[]>('/auth/sessions'),
  });

  return (
    <>
      <PageHeader title="Settings" description="Your profile, appearance and security." />

      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">{user?.name}</p>
                <p className="truncate text-sm text-muted-foreground">{user?.email}</p>
              </div>
              {user?.emailVerified ? (
                <Badge variant="success">verified</Badge>
              ) : (
                <Badge variant="warning">unverified</Badge>
              )}
            </div>

            <Separator />

            <div className="space-y-2">
              <label htmlFor="currency" className="text-sm font-medium">
                Base currency
              </label>
              <Select
                value={user?.currency ?? 'USD'}
                onValueChange={async (value) => {
                  await api.patch('/users/me', { currency: value });
                  await refreshUser();
                }}
              >
                <SelectTrigger id="currency" className="sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((item) => (
                    <SelectItem key={item.code} value={item.code}>
                      {item.symbol} {item.code} — {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Totals and charts use this. Past transactions keep the rate from the day they
                happened, so your history stays consistent.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Appearance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {(['light', 'dark', 'system'] as const).map((option) => (
                <Button
                  key={option}
                  variant={mounted && theme === option ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setTheme(option)}
                  className="capitalize"
                >
                  {option === 'light' ? (
                    <Sun className="size-4" aria-hidden />
                  ) : option === 'dark' ? (
                    <Moon className="size-4" aria-hidden />
                  ) : null}
                  {option}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-primary" aria-hidden />
              Security
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Two-factor authentication</p>
                <p className="text-sm text-muted-foreground">
                  {user?.twoFactorEnabled
                    ? 'On — a code is required at every sign-in.'
                    : 'Off. Turning it on is the single biggest thing you can do here.'}
                </p>
              </div>
              <Badge variant={user?.twoFactorEnabled ? 'success' : 'secondary'}>
                {user?.twoFactorEnabled ? 'on' : 'off'}
              </Badge>
            </div>

            <Separator />

            <div>
              <p className="mb-2 text-sm font-medium">Active sessions</p>
              {sessions.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : (
                <ul className="space-y-2">
                  {(sessions.data ?? []).map((session) => (
                    <li key={session.id} className="text-sm text-muted-foreground">
                      <span className="block truncate">
                        {session.userAgent?.slice(0, 60) ?? 'Unknown device'}
                      </span>
                      <span className="text-xs">
                        {session.ipAddress ?? 'unknown IP'} ·{' '}
                        {new Date(session.createdAt).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await api.post('/auth/logout-all');
                await logout();
              }}
            >
              <LogOut className="size-4" aria-hidden />
              Sign out everywhere
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
