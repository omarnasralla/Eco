/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The workspace packages ship TypeScript-built CommonJS; Next transpiles
  // them alongside app code so a change in @eco/core hot-reloads here.
  transpilePackages: ['@eco/shared', '@eco/core'],

  // Emits a minimal standalone server bundle, which is what the production
  // Docker image runs. Cuts the image from ~1.2GB to ~180MB.
  output: 'standalone',

  poweredByHeader: false,

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
