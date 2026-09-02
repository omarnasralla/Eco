import type { MetadataRoute } from 'next';

/**
 * The web manifest, generated rather than served as a static file.
 *
 * Next rewrites route and asset URLs for `basePath`, but it does not rewrite
 * the contents of a JSON file in `public/`. The previous static manifest still
 * pointed at `/dashboard` and `/icon.svg`, so once the app moved under
 * `/eco/app` an installed home-screen icon opened a 404 and showed no artwork.
 * Reading the prefix from the same constant the config sets means the two
 * cannot drift again.
 */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Eco — Personal Finance',
    short_name: 'Eco',
    description:
      'Track income, expenses, debts and goals with an AI that learns your patterns.',
    start_url: `${BASE}/dashboard`,
    scope: `${BASE}/`,
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#ffffff',
    theme_color: '#16a34a',
    icons: [
      { src: `${BASE}/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: `${BASE}/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
    // Long-pressing the installed icon jumps straight to the entry form, which
    // is the whole point of installing it: the common case is recording one
    // amount, not browsing a dashboard.
    shortcuts: [
      {
        name: 'Add an expense',
        short_name: 'Add expense',
        description: 'Record what you just spent',
        url: `${BASE}/expenses?new=1`,
        icons: [{ src: `${BASE}/icon.svg`, sizes: 'any', type: 'image/svg+xml' }],
      },
      {
        name: 'Add income',
        short_name: 'Add income',
        description: 'Record money coming in',
        url: `${BASE}/income?new=1`,
        icons: [{ src: `${BASE}/icon.svg`, sizes: 'any', type: 'image/svg+xml' }],
      },
    ],
  };
}
