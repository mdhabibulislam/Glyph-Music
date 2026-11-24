import { NextResponse, type NextRequest } from "next/server";
import { backendUrl, COOKIE, verifySession } from "@/lib/server/session";

// Server-side gate for every page. The session cookie is HttpOnly; it is verified here
// (Vercel-only mode) or by the PC backend (local mode) - nothing trusts the browser.
async function sessionState(req: NextRequest): Promise<"ok" | "none" | "offline"> {
  const cookie = req.cookies.get(COOKIE)?.value;
  if (!cookie) return "none";
  const backend = backendUrl();
  if (!backend) return (await verifySession(cookie)) ? "ok" : "none";
  try {
    const res = await fetch(`${backend}/api/auth/session`, {
      headers: { cookie: `${COOKIE}=${cookie}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? "ok" : "none";
  } catch {
    return "offline";
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const state = await sessionState(req);

  if (pathname === "/login") {
    if (state === "ok") return NextResponse.redirect(new URL("/", req.url));
    return NextResponse.next();
  }
  if (state !== "ok") {
    const url = new URL("/login", req.url);
    if (state === "offline") url.searchParams.set("offline", "1");
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except the API (which authenticates every request itself) and static assets.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
