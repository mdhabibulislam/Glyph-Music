"""Create .env on first setup and generate the session secret.

The access code is not chosen here: you create it on the website the first time you
open it, and it is stored only as a salted hash in the local database.
"""
from __future__ import annotations

import re
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / ".env"
EXAMPLE = ROOT / ".env.example"


def current(text: str, key: str) -> str:
    m = re.search(rf"^{key}=(.*)$", text, re.M)
    return m.group(1).strip() if m else ""


def put(text: str, key: str, value: str) -> str:
    if re.search(rf"^{key}=.*$", text, re.M):
        return re.sub(rf"^{key}=.*$", lambda _: f"{key}={value}", text, count=1, flags=re.M)
    return text.rstrip("\n") + f"\n{key}={value}\n"


def main() -> None:
    text = ENV.read_text(encoding="utf-8") if ENV.exists() else EXAMPLE.read_text(encoding="utf-8")
    changed = not ENV.exists()
    if len(current(text, "SESSION_SECRET")) < 32:
        text, changed = put(text, "SESSION_SECRET", secrets.token_urlsafe(48)), True
    if changed:
        ENV.write_text(text, encoding="utf-8")
        print("\n  Saved your settings to .env (this file stays on your PC and is git-ignored).")
    else:
        print("\n  .env is already configured.")
    print("  You will create your access code on the website the first time you open it.")


if __name__ == "__main__":
    main()
