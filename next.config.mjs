/** @type {import('next').NextConfig} */
const privateHeaders = [
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
  { key: "Cache-Control", value: "no-store, max-age=0" },
];

const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  compress: true,
  typedRoutes: true,
  experimental:
    process.platform === "win32" ? { webpackBuildWorker: false } : {},
  async headers() {
    return [
      {
        source: "/n/:path*",
        headers: privateHeaders,
      },
      {
        source: "/api/:path*",
        headers: privateHeaders,
      },
      {
        source: "/health/:path*",
        headers: privateHeaders,
      },
      {
        source: "/(.*)",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
