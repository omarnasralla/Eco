'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { useAuth } from '@/lib/auth-provider';
import { cn, initials } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { NAV_ITEMS } from './nav-items';
import { EcoMark } from './eco-mark';

/** Desktop navigation. Hidden below `lg`, where the tab bar takes over. */
export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r bg-card lg:flex">
      <div className="flex h-16 items-center gap-2 border-b px-5">
        <EcoMark className="size-7" />
        <span className="text-lg font-semibold tracking-tight">Eco</span>
      </div>

      <nav aria-label="Primary" className="flex-1 space-y-0.5 overflow-y-auto p-3">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t p-3">
        <div className="mb-2 flex items-center gap-3 rounded-lg px-3 py-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {user ? initials(user.name) : '—'}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user?.name ?? 'Loading…'}</p>
            <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground"
          onClick={() => void logout()}
        >
          <LogOut className="size-4" aria-hidden />
          Sign out
        </Button>
      </div>
    </aside>
  );
}
