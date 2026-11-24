"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Eye, EyeOff, KeyRound, Loader2, Lock, LockKeyhole, Music2, ServerOff } from "lucide-react";
import GlassFilter from "@/components/GlassFilter";
import GlyphBackground from "@/components/GlyphBackground";
import { TweaksProvider } from "@/lib/tweaks";
import { api, ApiError } from "@/lib/api";

type Mode = "checking" | "login" | "setup" | "env";
const MIN_LENGTH = 8;

function LoginCard() {
  const [mode, setMode] = useState<Mode>("checking");
  const [code, setCode] = useState("");
  const [repeat, setRepeat] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [shake, setShake] = useState(0);
  const [wait, setWait] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // Ask the backend whether an access code exists yet. The very first visit after
  // deployment creates it; from then on this page can only unlock.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("offline")) setOffline(true);
    api<{ configured: boolean; mode?: string }>("/auth/status", { allow401: true })
      .then((s) => {
        // On Vercel the code comes from an environment variable and cannot be created here.
        setMode(s.configured ? "login" : s.mode === "cloud" ? "env" : "setup");
        setOffline(false);
      })
      .catch(() => {
        setMode("login");
        setOffline(true);
      });
  }, []);

  useEffect(() => {
    if (mode !== "checking") input.current?.focus();
  }, [mode, shake]);

  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(id);
  }, [wait]);

  const reject = (text: string) => {
    setMessage(text);
    setShake((n) => n + 1);
    setBusy(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code || busy || wait > 0 || mode === "checking") return;
    setMessage(null);

    if (mode === "setup") {
      if (code.length < MIN_LENGTH) return reject(`Use at least ${MIN_LENGTH} characters.`);
      if (code !== repeat) return reject("Those two codes don't match.");
    }
    setBusy(true);
    try {
      await api(mode === "setup" ? "/auth/setup" : "/auth/login", { method: "POST", body: { code }, allow401: true });
      window.location.href = "/";
    } catch (err) {
      setCode("");
      setRepeat("");
      if (err instanceof ApiError && err.status === 409) {
        // The code was created (or not yet created) since this page loaded: switch screens.
        if (err.data.code === "env_required") {
          setMode("env");
          setBusy(false);
          return;
        }
        const next = err.data.code === "setup_required" ? "setup" : "login";
        setMode(next);
        reject(next === "login" ? "An access code has already been set. Enter it to unlock." : "Create your access code first.");
      } else if (err instanceof ApiError && err.status === 429) {
        setWait(Number(err.data.retry_after) || 60);
        reject("Too many incorrect attempts.");
      } else if (err instanceof ApiError && err.status === 401) {
        const left = Number(err.data.attempts_left);
        reject(left > 0 && left <= 2 ? `Incorrect access code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Incorrect access code.");
      } else if (err instanceof ApiError && err.status === 422) {
        reject(typeof err.data.error === "string" ? err.data.error : `Use at least ${MIN_LENGTH} characters.`);
      } else {
        setOffline(true);
        reject(err instanceof Error ? err.message : "Couldn't sign in.");
      }
    }
  };

  const setup = mode === "setup";
  const ready = setup ? code.length > 0 && repeat.length > 0 : code.length > 0;

  return (
    <main className="relative z-10 flex min-h-[100dvh] items-center justify-center px-5 py-10">
      <form
        key={shake}
        onSubmit={submit}
        className={`glass glass-refract rise w-full max-w-[400px] px-7 py-9 text-center sm:px-9 ${shake ? "shake" : ""}`}
        aria-label={setup ? "Create your Glyph Music access code" : "Unlock Glyph Music"}
      >
        <div className="mx-auto mb-6 flex h-[76px] w-[76px] items-center justify-center rounded-full border border-white/20 bg-gradient-to-b from-white/15 to-accent/10 shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_18px_40px_-14px_rgba(122,162,255,.7)]">
          <Music2 className="h-8 w-8 text-ink" strokeWidth={1.6} />
        </div>
        <h1 className="text-[28px] font-semibold tracking-tight">Glyph Music</h1>
        <p className="mt-1.5 text-sm text-ink/55">Your private music sanctuary.</p>

        {setup && (
          <p className="mt-6 text-sm leading-relaxed text-ink/70">
            Create your access code. It can only be set once, so choose one you&apos;ll remember.
          </p>
        )}

        {mode === "env" && (
          <div className="mt-6 rounded-2xl border border-white/10 bg-black/25 p-4 text-left text-sm leading-relaxed text-ink/70">
            <p className="font-medium text-ink/90">No access code has been set yet.</p>
            <p className="mt-2">
              In Vercel, open your project, go to <span className="text-ink/90">Settings &rarr; Environment Variables</span>, add{" "}
              <span className="font-mono text-[13px] text-accent">ADMIN_ACCESS_CODE</span> with a code of at least 8 characters, then redeploy.
            </p>
          </div>
        )}

        {mode !== "env" && <>
        <div className={`relative ${setup ? "mt-5" : "mt-8"}`}>
          <LockKeyhole className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40" />
          <input
            ref={input}
            type={show ? "text" : "password"}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={setup ? "New access code" : "Access code"}
            aria-label={setup ? "New access code" : "Access code"}
            autoComplete={setup ? "new-password" : "current-password"}
            maxLength={256}
            spellCheck={false}
            disabled={mode === "checking"}
            className="field !py-3.5 !pl-10 !pr-11 font-mono tracking-wider"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="btn-icon absolute right-1.5 top-1/2 -translate-y-1/2"
            aria-label={show ? "Hide access code" : "Show access code"}
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>

        {setup && (
          <div className="relative mt-3">
            <LockKeyhole className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40" />
            <input
              type={show ? "text" : "password"}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              placeholder="Repeat access code"
              aria-label="Repeat access code"
              autoComplete="new-password"
              maxLength={256}
              spellCheck={false}
              className="field !py-3.5 !pl-10 font-mono tracking-wider"
            />
          </div>
        )}

        <button type="submit" disabled={!ready || busy || wait > 0 || mode === "checking"} className="btn btn-primary mt-4 w-full !py-3.5">
          {busy || mode === "checking" ? <Loader2 className="spin h-4 w-4" /> : setup ? <KeyRound className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
          {wait > 0 ? `Try again in ${wait}s` : setup ? (busy ? "Saving" : "Set access code") : busy ? "Unlocking" : "Unlock"}
        </button>

        </>}

        <div className="mt-4 min-h-[20px] text-sm" role="alert" aria-live="polite">
          {message && <span className="text-err">{message}</span>}
          {!message && offline && (
            <span className="inline-flex items-center gap-1.5 text-ink/55">
              <ServerOff className="h-3.5 w-3.5" /> The backend on your PC isn&apos;t reachable.
            </span>
          )}
          {!message && !offline && setup && <span className="text-ink/45">At least {MIN_LENGTH} characters.</span>}
        </div>

        <p className="label mt-5 inline-flex items-center gap-2">
          <Lock className="h-3 w-3" /> Private access only
        </p>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <TweaksProvider>
      <GlassFilter />
      <GlyphBackground />
      <LoginCard />
    </TweaksProvider>
  );
}
