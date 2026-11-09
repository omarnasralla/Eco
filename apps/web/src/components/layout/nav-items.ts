import {
  Bot,
  Landmark,
  ShieldCheck,
  Sunrise,
  CreditCard,
  Hourglass,
  LayoutDashboard,
  PiggyBank,
  Receipt,
  Settings,
  Target,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * Shown directly in the phone tab bar. Five slots is the platform maximum
   * before a tap target becomes a guess, and the fifth is spent on **More** —
   * so four destinations are primary and the rest open from the More sheet.
   */
  primary?: boolean;
  /**
   * Hidden from the navigation unless the signed-in account is an ADMIN. This
   * is presentation only — the API refuses the routes regardless, so a user who
   * types the URL gets a refusal from the server, not from this flag.
   */
  adminOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, primary: true },
  { href: '/expenses', label: 'Expenses', icon: Receipt, primary: true },
  { href: '/assistant', label: 'Eco AI', icon: Bot, primary: true },
  { href: '/budgets', label: 'Budgets', icon: Wallet, primary: true },
  // Where the morning briefing lands: weather, tasks and birthdays. First in
  // the More sheet because it is the one screen opened every day.
  { href: '/today', label: 'Today', icon: Sunrise },
  // Debts is a planning screen visited occasionally, not a daily-entry one, so
  // it yields its tab slot to More — which is what makes Settings, Income,
  // Goals and Reports reachable on a phone at all.
  { href: '/debts', label: 'Debts', icon: CreditCard },
  // Where an impulse waits out its 48 hours before it can be bought.
  { href: '/wants', label: 'Cooling off', icon: Hourglass },
  { href: '/income', label: 'Income', icon: TrendingUp },
  { href: '/accounts', label: 'Accounts', icon: Landmark },
  { href: '/goals', label: 'Goals', icon: Target },
  { href: '/reports', label: 'Reports', icon: PiggyBank },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/admin', label: 'Admin', icon: ShieldCheck, adminOnly: true },
];

/** The navigation for a given role. */
export function navItemsFor(role: string | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.adminOnly || role === 'ADMIN');
}

export const PRIMARY_NAV = NAV_ITEMS.filter((item) => item.primary);

/** Everything the phone tab bar cannot hold. Listed in the More sheet. */
export const SECONDARY_NAV = NAV_ITEMS.filter((item) => !item.primary);

/** As above, but for a role — Admin appears in the More sheet for admins. */
export function secondaryNavFor(role: string | undefined): NavItem[] {
  return navItemsFor(role).filter((item) => !item.primary);
}
