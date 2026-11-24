/** @type {import('next').NextConfig} */
// Two ways to run:
//  - BACKEND_URL set (local mode, start.bat): every /api call is proxied to the Python
//    backend on your PC, which matches songs against your own music library.
//  - BACKEND_URL empty (Vercel-only mode): the site's own /api routes handle the login
//    and search openly licensed music; downloads happen in the browser.
const backend = (process.env.BACKEND_URL || "").trim().replace(/\/+$/, "");
const dev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.scdn.co https://*.spotifycdn.com",
  "font-src 'self' data:",
  // archive.org: open-licence audio is downloaded by the browser straight from the Internet Archive.
  "connect-src 'self' https://archive.org https://*.archive.org",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    // beforeFiles: in local mode the proxy wins over the built-in /api routes.
    return { beforeFiles: backend ? [{ source: "/api/:path*", destination: `${backend}/api/:path*` }] : [] };
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
