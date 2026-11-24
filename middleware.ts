import { NextResponse, type NextRequest } from "next/server";

// Server-side gate for every page. The session cookie is HttpOnly and is verified by
// the backend (signature, expiry and revocation) - nothing here trusts the browser.
const BACKEND = (process.env.BACKEND_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const COOKIE = "glyph_session";

async function sessionState(req: NextRequest): Promise<"ok" | "none" | "offline"> {
  const cookie = req.cookies.get(COOKIE)?.value;
  if (!cookie) return "none";
  try {
    const res = await fetch(`${BACKEND}/api/auth/session`, {
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
  // Everything except the API proxy (the backend authenticates that itself) and static assets.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
