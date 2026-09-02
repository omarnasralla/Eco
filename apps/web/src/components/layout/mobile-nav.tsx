'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChevronRight, LogOut, MoreHorizontal } from 'lucide-react';
import { cn, initials } from '@/lib/utils';
import { useAuth } from '@/lib/auth-provider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PRIMARY_NAV, secondaryNavFor, type NavItem } from './nav-items';

const TAB_CLASS =
  'flex min-h-[56px] w-full flex-col items-center justify-center gap-0.5 px-1 py-2 text-[11px] font-medium transition-colors';

/**
 * The phone tab bar.
 *
 * Fixed to the bottom because that is where thumbs are, padded for the iOS home
 * indicator, and capped at five slots — a sixth turns a tap target into a
 * guess. Four of those are destinations; the fifth is **More**, which opens
 * every remaining page. Without it Settings, Income, Goals and Reports had no
 * tap path at all below `lg`, because that is where the sidebar disappears.
 */
export function MobileNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const { user, logout } = useAuth();

  // A tab tap and a More-sheet tap both change the route; the sheet must not
  // survive the navigation it caused.
  useEffect(() => setMoreOpen(false), [pathname]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const secondary = secondaryNavFor(user?.role);
  const moreActive = secondary.some((item) => isActive(item.href));

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul className="flex items-stretch justify-around">
          {PRIMARY_NAV.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(TAB_CLASS, active ? 'text-primary' : 'text-muted-foreground')}
                >
                  <Icon className="size-5" aria-hidden />
                  <span className="truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}

          <li className="flex-1">
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              // Lit while you are on one of the pages it holds, so the tab bar
              // never claims you are nowhere.
              className={cn(TAB_CLASS, moreActive ? 'text-primary' : 'text-muted-foreground')}
            >
              <MoreHorizontal className="size-5" aria-hidden />
              <span className="truncate">More</span>
            </button>
          </li>
        </ul>
      </nav>

      <MoreSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        items={secondary}
        isActive={isActive}
        user={user}
        onSignOut={() => void logout()}
      />
    </>
  );
}

function MoreSheet({
  open,
  onOpenChange,
  items,
  isActive,
  user,
  onSignOut,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Passed in rather than derived here: the list depends on the signed-in
   *  role, and this component does not read auth. */
  items: NavItem[];
  isActive: (href: string) => boolean;
  user: { name: string; email: string } | null;
  onSignOut: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* DialogContent is already a bottom sheet below `sm`, which is the right
          idiom here — it rises from the tab bar that opened it. */}
      <DialogContent className="lg:hidden">
        <DialogHeader>
          <DialogTitle>More</DialogTitle>
          <DialogDescription>Everything the tab bar has no room for.</DialogDescription>
        </DialogHeader>

        <nav aria-label="More destinations">
          <ul className="-mx-2 divide-y">
            {items.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onOpenChange(false)}
                    className={cn(
                      'flex min-h-[52px] items-center gap-3 rounded-lg px-2 text-sm font-medium transition-colors',
                      active ? 'text-primary' : 'text-foreground',
                    )}
                  >
                    <Icon className="size-5 shrink-0" aria-hidden />
                    <span className="flex-1">{item.label}</span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-t pt-4">
          <div className="mb-2 flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
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
            onClick={onSignOut}
          >
            <LogOut className="size-4" aria-hidden />
            Sign out
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
