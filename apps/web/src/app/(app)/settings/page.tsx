'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import {
  Bell,
  Copy,
  Download,
  Loader2,
  LogOut,
  Moon,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
} from 'lucide-react';
import { CURRENCIES, type CreatedIngestTokenDto, type IngestTokenDto } from '@eco/shared';
import { api } from '@/lib/api-client';
import { isInstalled, pushState, subscribeToPush, type PushState } from '@/lib/push';
import { useAuth } from '@/lib/auth-provider';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

  const [backupError, setBackupError] = useState<string | null>(null);

  const backup = useMutation({
    mutationFn: async () => {
      // The export comes back as JSON rather than as an opaque file, so
      // api-client parses it and the download is assembled here. Serialising
      // again is cheap next to the round trip, and it keeps the endpoint
      // honestly typed as application/json for anything else that calls it.
      const data = await api.get<unknown>('/users/me/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `eco-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    },
    onMutate: () => setBackupError(null),
    onError: () =>
      setBackupError('Could not build your backup. Please try again in a moment.'),
  });

  return (
    <>
      <PageHeader title="Settings" description="Your profile, appearance, data and security." />

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

        <NotificationsCard />

        <AutomaticExpensesCard />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Your data</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium">Download a backup</p>
              <p className="text-sm text-muted-foreground">
                One JSON file with your accounts, income, expenses, categories, debts, goals
                and budgets — everything you have entered, including anything you have
                deleted in the last 30 days. Sign-in credentials are never included.
              </p>
            </div>

            {backupError ? (
              <p role="alert" className="text-sm text-destructive">
                {backupError}
              </p>
            ) : null}

            <Button
              variant="outline"
              size="sm"
              onClick={() => backup.mutate()}
              disabled={backup.isPending}
            >
              {backup.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Download className="size-4" aria-hidden />
              )}
              {backup.isPending ? 'Preparing…' : 'Download backup'}
            </Button>

            <p className="text-xs text-muted-foreground">
              The file is yours and is not encrypted — it lists what you earn, owe and spend.
              Keep it somewhere you would keep a bank statement.
            </p>
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

/**
 * Capture tokens for the iOS shortcut that posts an Apple Pay tap.
 *
 * The token is shown exactly once, at creation, because only its hash is
 * stored. That is worth the friction: this credential lives in a shortcut on a
 * phone, and a database read should not be able to spend as the user.
 */
function AutomaticExpensesCard() {
  const [label, setLabel] = useState('');
  const [minted, setMinted] = useState<CreatedIngestTokenDto | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokens = useQuery({
    queryKey: ['ingest', 'tokens'],
    queryFn: () => api.get<IngestTokenDto[]>('/ingest/tokens'),
  });

  const create = useMutation({
    mutationFn: (name: string) =>
      api.post<CreatedIngestTokenDto>('/ingest/tokens', { label: name }),
    onSuccess: (data) => {
      setMinted(data);
      setLabel('');
      setCopied(false);
      void tokens.refetch();
    },
    onError: () => setError('Could not create a token. Please try again.'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/ingest/tokens/${id}`),
    onSuccess: () => {
      setMinted(null);
      void tokens.refetch();
    },
    onError: () => setError('Could not revoke that token.'),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Smartphone className="size-4 text-primary" aria-hidden />
          Automatic expenses
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Record an Apple Pay tap the moment it happens. Create a token below, then build the
          iPhone shortcut described in the user guide — it posts each tap here, and the expense
          appears without you typing anything.
        </p>

        {minted ? (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <p className="text-sm font-medium">Copy this now — it is not shown again.</p>
            <code className="block break-all rounded bg-background px-2 py-1.5 font-mono text-xs">
              {minted.token}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(minted.token);
                  setCopied(true);
                } catch {
                  // Clipboard access is refused outside a secure context and in
                  // some in-app browsers. The token is on screen either way.
                  setError('Could not copy automatically — select the token and copy it.');
                }
              }}
            >
              <Copy className="size-4" aria-hidden />
              {copied ? 'Copied' : 'Copy token'}
            </Button>
          </div>
        ) : null}

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="token-label">Name this phone</Label>
            <Input
              id="token-label"
              placeholder="My iPhone"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setError(null);
              create.mutate(label.trim() || 'My iPhone');
            }}
            disabled={create.isPending}
          >
            {create.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Create token
          </Button>
        </div>

        {(tokens.data ?? []).length > 0 ? (
          <>
            <Separator />
            <ul className="space-y-2">
              {(tokens.data ?? []).map((token) => (
                <li key={token.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{token.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {token.lastUsedAt
                        ? `last used ${new Date(token.lastUsedAt).toLocaleString()}`
                        : 'never used'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Revoke ${token.label}`}
                    onClick={() => revoke.mutate(token.id)}
                    disabled={revoke.isPending}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <p className="text-xs text-muted-foreground">
          A token can only add expenses — it cannot read your balances, move money, or sign in.
          Revoke one if you lose the phone holding it.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Turning on push for this device.
 *
 * The awkward case is the common one: on an iPhone, push works only once the
 * site has been added to the Home Screen, and there is no way to ask for it
 * from a Safari tab. So rather than showing a button that cannot work, this
 * says what to do — an unexplained disabled control is how people conclude the
 * feature is broken.
 */
function NotificationsCard() {
  const [state, setState] = useState<PushState>('default');
  const [installed, setInstalled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState(pushState());
    setInstalled(isInstalled());
  }, []);

  const enable = useMutation({
    mutationFn: subscribeToPush,
    onSuccess: (next) => {
      setState(next);
      if (next === 'denied') {
        setError('Notifications are blocked for this site. Turn them back on in your settings.');
      }
    },
    onError: (e) =>
      setError(e instanceof Error ? e.message : 'Could not turn on notifications.'),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Bell className="size-4 text-primary" aria-hidden />
          Notifications
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Eco tells you when an expense could not be recorded, when captured expenses are waiting
          for a category, and when a bill or budget needs attention. It never notifies you about an
          expense that recorded correctly — your bank already does that.
        </p>

        {state === 'granted' ? (
          <div className="flex items-center gap-2">
            <Badge variant="success">on</Badge>
            <span className="text-sm text-muted-foreground">
              This device will receive notifications.
            </span>
          </div>
        ) : state === 'needs-install' ? (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">Add Eco to your Home Screen first</p>
            <p className="mt-1 text-muted-foreground">
              Apple only allows notifications for a web app on the Home Screen, not from a Safari
              tab. Tap <span className="font-medium">Share</span> →{' '}
              <span className="font-medium">Add to Home Screen</span>, open Eco from the new icon,
              then come back here.
            </p>
          </div>
        ) : state === 'unsupported' ? (
          <p className="text-sm text-muted-foreground">
            This browser cannot receive push notifications.
          </p>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null);
              enable.mutate();
            }}
            disabled={enable.isPending}
          >
            {enable.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Bell className="size-4" aria-hidden />
            )}
            Turn on notifications
          </Button>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {!installed && state !== 'needs-install' ? (
          <p className="text-xs text-muted-foreground">
            Adding Eco to your Home Screen makes notifications more reliable.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
