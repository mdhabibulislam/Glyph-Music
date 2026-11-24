"""Start the Glyph Music backend:  python backend/run.py"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import uvicorn  # noqa: E402

from app.config import ConfigError, Settings  # noqa: E402
from app.main import create_app  # noqa: E402


def main() -> None:
    settings = Settings.from_env()
    try:
        app = create_app(settings)
    except ConfigError as e:
        print(f"\n[Glyph Music] Configuration problem: {e}\n")
        sys.exit(1)
    # Binds to localhost by default. Expose it only through an HTTPS tunnel (see README).
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info",
                proxy_headers=settings.trust_proxy, forwarded_allow_ips="127.0.0.1")


if __name__ == "__main__":
    main()
