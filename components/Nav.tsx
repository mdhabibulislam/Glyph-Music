"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Download, History, Home, LogOut, Music2, Settings } from "lucide-react";
import { api } from "@/lib/api";
import { useMusic } from "@/lib/music";

const LINKS = [
  { href: "/", label: "Home", icon: Home },
  { href: "/downloads", label: "Downloads", icon: Download },
  { href: "/history", label: "History", icon: History },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default function Nav() {
  const pathname = usePathname();
  const { job } = useMusic();

  const logout = async () => {
    try {
      await api("/auth/logout", { method: "POST", allow401: true });
    } finally {
      window.location.href = "/login";
    }
  };

  return (
    <header className="fixed inset-x-0 top-3 z-30 flex justify-center px-3 sm:top-5">
      <nav className="glass glass-refract flex max-w-full items-center gap-0.5 !rounded-full p-1.5" aria-label="Main">
        <Link href="/" className="mr-1 flex items-center gap-2 pl-2 pr-2 sm:pr-3" aria-label="Glyph Music home">
          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-gradient-to-b from-white/15 to-accent/15">
            <Music2 className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <span className="hidden text-sm font-semibold tracking-tight md:inline">Glyph Music</span>
        </Link>
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              aria-label={label}
              className={`relative flex items-center gap-2 rounded-full px-3 py-2 text-sm transition duration-200 sm:px-3.5 ${
                active ? "bg-white/[.13] text-ink shadow-[inset_0_1px_0_rgba(255,255,255,.2)]" : "text-ink/60 hover:bg-white/[.06] hover:text-ink"
              }`}
            >
              <Icon className="h-4 w-4" strokeWidth={1.8} />
              <span className="hidden sm:inline">{label}</span>
              {href === "/downloads" && job?.running && (
                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-ok shadow-[0_0_8px_#1DB954]" />
              )}
            </Link>
          );
        })}
        <span className="mx-1 h-5 w-px bg-white/10" />
        <button
          onClick={logout}
          aria-label="Logout"
          className="flex items-center gap-2 rounded-full px-3 py-2 text-sm text-ink/60 transition duration-200 hover:bg-err/10 hover:text-err sm:px-3.5"
        >
          <LogOut className="h-4 w-4" strokeWidth={1.8} />
          <span className="hidden sm:inline">Logout</span>
        </button>
      </nav>
    </header>
  );
}
