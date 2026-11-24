"""Forget the stored access code so it can be created again on the website.

This is the only way to replace the code, and it only works on the PC that runs the
backend. Stop the backend first, run this, then start it and open the website.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.config import Settings  # noqa: E402
from app.db import Database  # noqa: E402


def main() -> None:
    settings = Settings.from_env()
    db_path = settings.data_dir / "glyph.db"
    if not db_path.exists():
        print("\n  No access code is stored yet. Open the website to create one.")
        return
    if sys.stdin.isatty():
        answer = input("\n  Remove the stored access code and sign out every device? Type YES to continue: ")
        if answer.strip() != "YES":
            print("  Nothing was changed.")
            return
    db = Database(db_path)
    db.execute("DELETE FROM settings WHERE key=?", ("access_code_hash",))
    db.close()
    print("\n  The access code was removed. Open the website to create a new one.")
    print("  Every device that was signed in has been signed out.")
    if settings.access_code:
        print("  Note: ADMIN_ACCESS_CODE is set in .env and is still the active code.")


if __name__ == "__main__":
    main()
