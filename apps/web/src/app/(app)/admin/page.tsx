'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  LockOpen,
  LogOut,
  RotateCcw,
  Search,
  ShieldAlert,
  Trash2,
  Users,
} from 'lucide-react';
import {
  USER_ROLES,
  type AdminPasswordResetDto,
  type AdminUserRow,
  type UserRole,
} from '@eco/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-provider';
import { fetchers, queryKeys } from '@/lib/queries';

const STATUS_FILTERS = [
  { value: 'all', label: 'All accounts' },
  { value: 'active', label: 'Active' },
  { value: 'locked', label: 'Locked out' },
  { value: 'unverified', label: 'Unverified' },
  { value: 'deleted', label: 'Deleted' },
] as const;

export default function AdminPage() {
  const { user, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Held in component state and nowhere else. The link is a working credential
  // until it is used, so it is shown once, on the row it belongs to, and is
  // gone on the next navigation.
  const [resetLink, setResetLink] = useState<{ id: string; reset: AdminPasswordResetDto } | null>(
    null,
  );

  const isAdmin = user?.role === 'ADMIN';

  const stats = useQuery({
    queryKey: queryKeys.adminStats,
    queryFn: fetchers.adminStats,
    enabled: isAdmin,
  });

  const users = useQuery({
    queryKey: queryKeys.adminUsers(search, status),
    queryFn: () => fetchers.adminUsers(search, status === 'all' ? undefined : status),
    enabled: isAdmin,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin'] });
  };

  // Every mutation reports its refusal rather than failing silently: the
  // interesting responses here are the deliberate ones — the last-administrator
  // rule, and the block on acting on your own account.
  const act = useMutation({
    mutationFn: async (input: { id: string; action: string; body?: unknown }) => {
      setError(null);
      if (input.action === 'delete') return api.delete(`/admin/users/${input.id}`);
      if (input.action === 'patch') return api.patch(`/admin/users/${input.id}`, input.body);
      return api.post(`/admin/users/${input.id}/${input.action}`, {});
    },
    onSuccess: (data, input) => {
      if (input.action === 'reset-password') {
        setResetLink({ id: input.id, reset: data as AdminPasswordResetDto });
      }
      refresh();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'That did not work.'),
  });

  const rows = users.data?.items ?? [];
  const counts = useMemo(() => stats.data?.users, [stats.data]);

  if (authLoading) return <PageSkeleton />;

  // The API refuses these routes regardless, so this is only about not showing
  // a broken screen — it is not the access control.
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Administrators only</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page manages every account on the deployment. Your account does not have
          administrator access.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Administration</h1>
        <p className="text-sm text-muted-foreground">
          Every account on this deployment, and what it holds.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Accounts" value={counts?.total} icon={Users} />
        <Stat label="Active" value={counts?.active} />
        <Stat label="Admins" value={counts?.admins} />
        <Stat label="Locked out" value={counts?.locked} tone={counts?.locked ? 'warn' : undefined} />
        <Stat label="Unverified" value={counts?.unverified} />
        <Stat label="Deleted" value={counts?.deleted} />
      </section>

      {stats.data ? (
        <p className="text-xs text-muted-foreground">
          Holding {stats.data.data.expenses.toLocaleString()} expenses,{' '}
          {stats.data.data.incomeSources} income sources, {stats.data.data.debts} debts,{' '}
          {stats.data.data.goals} goals and {stats.data.data.aiConversations} AI conversations.{' '}
          {counts?.activeLast30Days} signed in and {counts?.newLast30Days} joined in the last 30 days.
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search accounts"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="sm:w-48" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>{error}</span>
        </div>
      ) : null}

      {users.isLoading ? (
        <PageSkeleton />
      ) : rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No accounts match that search.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <UserRow
              key={row.id}
              row={row}
              isSelf={row.id === user?.id}
              busy={act.isPending}
              confirmingDelete={confirmDelete === row.id}
              resetLink={resetLink?.id === row.id ? resetLink.reset : null}
              onDismissReset={() => setResetLink(null)}
              onConfirmDelete={() => setConfirmDelete(row.id)}
              onCancelDelete={() => setConfirmDelete(null)}
              onAct={(action, body) => {
                setConfirmDelete(null);
                setResetLink(null);
                act.mutate({ id: row.id, action, body });
              }}
            />
          ))}
        </ul>
      )}

      {users.data?.total !== undefined ? (
        <p className="text-xs text-muted-foreground">
          Showing {rows.length} of {users.data.total}.
        </p>
      ) : null}
    </div>
  );
}

function UserRow({
  row,
  isSelf,
  busy,
  confirmingDelete,
  resetLink,
  onDismissReset,
  onConfirmDelete,
  onCancelDelete,
  onAct,
}: {
  row: AdminUserRow;
  isSelf: boolean;
  busy: boolean;
  confirmingDelete: boolean;
  resetLink: AdminPasswordResetDto | null;
  onDismissReset: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onAct: (action: string, body?: unknown) => void;
}) {
  const deleted = row.deletedAt !== null;
  const locked = row.lockedUntil !== null && new Date(row.lockedUntil) > new Date();
  const total =
    row.counts.expenses + row.counts.incomeSources + row.counts.debts + row.counts.goals;

  return (
    <li
      className={`rounded-lg border p-3 ${deleted ? 'bg-muted/40 opacity-70' : 'bg-card'}`}
      data-testid="admin-user-row"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{row.name}</span>
            {isSelf ? <Badge variant="outline">You</Badge> : null}
            {row.role !== 'USER' ? <Badge>{row.role}</Badge> : null}
            {deleted ? <Badge variant="destructive">Deleted</Badge> : null}
            {locked ? <Badge variant="destructive">Locked</Badge> : null}
            {!row.emailVerified && !deleted ? <Badge variant="outline">Unverified</Badge> : null}
            {row.twoFactorEnabled ? <Badge variant="outline">2FA</Badge> : null}
          </div>
          <p className="truncate text-sm text-muted-foreground">{row.email}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {total.toLocaleString()} records · joined{' '}
            {new Date(row.createdAt).toLocaleDateString()} ·{' '}
            {row.lastLoginAt
              ? `last seen ${new Date(row.lastLoginAt).toLocaleDateString()}`
              : 'never signed in'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={row.role}
            disabled={busy || deleted || isSelf}
            onValueChange={(role: UserRole) => onAct('patch', { role })}
          >
            {/* Disabled on your own row: the API refuses self-demotion, since
                it is the one edit that can strand the console. */}
            <SelectTrigger className="h-8 w-32 text-xs" aria-label={`Role for ${row.email}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {USER_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {locked ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct('unlock')}>
              <LockOpen className="mr-1 h-3.5 w-3.5" /> Unlock
            </Button>
          ) : null}

          {!deleted ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAct('reset-password')}
              title="Issue a one-hour link that lets them set a new password"
            >
              <KeyRound className="mr-1 h-3.5 w-3.5" /> Reset password
            </Button>
          ) : null}

          {!deleted ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAct('force-logout')}
              title="Sign this account out of every device"
            >
              <LogOut className="mr-1 h-3.5 w-3.5" /> Sign out
            </Button>
          ) : null}

          {deleted ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct('restore')}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Restore
            </Button>
          ) : confirmingDelete ? (
            // Two-step rather than a dialog: the row itself states what is
            // about to happen, and how much data it concerns.
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Delete {row.email} and its {total.toLocaleString()} records?
              </span>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => onAct('delete')}>
                Confirm
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onCancelDelete}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || isSelf}
              onClick={onConfirmDelete}
              title={isSelf ? 'You cannot delete your own account here' : 'Soft-delete, reversible'}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {resetLink ? <ResetLinkPanel reset={resetLink} onDismiss={onDismissReset} /> : null}
    </li>
  );
}

/**
 * The issued link, shown once.
 *
 * Anyone holding this URL can set the account's password, so it is never
 * written to a query cache or the address bar — it lives in component state
 * until the administrator dismisses it or leaves the page.
 */
function ResetLinkPanel({
  reset,
  onDismiss,
}: {
  reset: AdminPasswordResetDto;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reset.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is refused without HTTPS in some browsers, and this
      // deployment is plain HTTP — the URL is on screen to select by hand.
      setCopied(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-primary/40 bg-primary/5 p-3">
      <p className="text-sm font-medium">Password reset link</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {reset.emailSent
          ? 'Emailed to the address on the account. '
          : 'The email could not be sent, so this link is the only copy. '}
        It works once, expires {new Date(reset.expiresAt).toLocaleTimeString()}, and lets them
        choose their own password — you never see it.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1.5 text-xs">
          {reset.url}
        </code>
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? (
            <>
              <Check className="mr-1 h-3.5 w-3.5" /> Copied
            </>
          ) : (
            <>
              <Copy className="mr-1 h-3.5 w-3.5" /> Copy
            </>
          )}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value?: number;
  icon?: typeof Users;
  tone?: 'warn';
}) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className={`tabular text-2xl font-semibold ${tone === 'warn' ? 'text-destructive' : ''}`}>
          {value === undefined ? '—' : value.toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}
