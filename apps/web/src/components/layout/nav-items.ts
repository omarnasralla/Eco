import {
  Bot,
  CreditCard,
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
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, primary: true },
  { href: '/expenses', label: 'Expenses', icon: Receipt, primary: true },
  { href: '/assistant', label: 'Eco AI', icon: Bot, primary: true },
  { href: '/budgets', label: 'Budgets', icon: Wallet, primary: true },
  // Debts is a planning screen visited occasionally, not a daily-entry one, so
  // it yields its tab slot to More — which is what makes Settings, Income,
  // Goals and Reports reachable on a phone at all.
  { href: '/debts', label: 'Debts', icon: CreditCard },
  { href: '/income', label: 'Income', icon: TrendingUp },
  { href: '/goals', label: 'Goals', icon: Target },
  { href: '/reports', label: 'Reports', icon: PiggyBank },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export const PRIMARY_NAV = NAV_ITEMS.filter((item) => item.primary);

/** Everything the phone tab bar cannot hold. Listed in the More sheet. */
export const SECONDARY_NAV = NAV_ITEMS.filter((item) => !item.primary);
