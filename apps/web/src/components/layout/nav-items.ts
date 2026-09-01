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
  /** Shown in the phone tab bar. Five is the platform maximum before it crowds. */
  primary?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, primary: true },
  { href: '/expenses', label: 'Expenses', icon: Receipt, primary: true },
  { href: '/assistant', label: 'Eco AI', icon: Bot, primary: true },
  { href: '/budgets', label: 'Budgets', icon: Wallet, primary: true },
  { href: '/debts', label: 'Debts', icon: CreditCard, primary: true },
  { href: '/income', label: 'Income', icon: TrendingUp },
  { href: '/goals', label: 'Goals', icon: Target },
  { href: '/reports', label: 'Reports', icon: PiggyBank },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export const PRIMARY_NAV = NAV_ITEMS.filter((item) => item.primary);
