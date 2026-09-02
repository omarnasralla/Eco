/**
 * The path prefix the whole app is served under. Declared here rather than
 * inline so the manifest route can read the same value.
 */
const BASE_PATH = '/eco/app';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The app is served under a path prefix rather than at the domain root, so
  // it can sit alongside anything else on this host. Next prepends this to
  // every route, asset URL and `next/link` or `router.push` target, so nothing
  // in the app code hardcodes it. It does NOT affect the API, which is a
  // separate origin configured through NEXT_PUBLIC_API_URL.
  //
  // Changing this invalidates every bookmark, and the bare origin stops
  // serving the app entirely — `/` 404s, which is why the redirect below
  // exists.
  basePath: BASE_PATH,

  // Exposed to the app so anything that must build an absolute path — the web
  // manifest above all, whose JSON Next does not rewrite — derives it from the
  // same constant instead of hardcoding a copy that silently rots when the
  // prefix moves.
  env: { NEXT_PUBLIC_BASE_PATH: BASE_PATH },

  // The workspace packages ship TypeScript-built CommonJS; Next transpiles
  // them alongside app code so a change in @eco/core hot-reloads here.
  transpilePackages: ['@eco/shared', '@eco/core'],

  // Emits a minimal standalone server bundle, which is what the production
  // Docker image runs. Cuts the image from ~1.2GB to ~180MB.
  output: 'standalone',

  poweredByHeader: false,

  // basePath leaves the origin root unserved. A visitor typing the bare
  // host:port would get a 404 with nothing to suggest where the app went, so
  // send them on. `basePath: false` is required — without it Next would
  // prefix the destination and point the redirect at itself.
  async redirects() {
    return [{ source: '/', destination: BASE_PATH, permanent: false, basePath: false }];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
