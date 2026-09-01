import { redirect } from 'next/navigation';

/**
 * The root is a router, not a landing page. A signed-out visitor is bounced to
 * /login by the app layout's guard; there is no marketing surface to show.
 */
export default function RootPage() {
  redirect('/dashboard');
}
