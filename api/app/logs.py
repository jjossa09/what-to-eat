"""Logging setup, applied once when the app is imported (uvicorn locally, Vercel in production).

INFO goes to stderr so Vercel Runtime Logs show round latency and Muse usage. The HTTP client
loggers stay at WARNING: httpx2 logs each request URL at INFO, and the Geoapify URL carries the
API key as a query param.
"""

import logging

QUIET_LOGGERS = ("httpx2", "httpcore2")


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
