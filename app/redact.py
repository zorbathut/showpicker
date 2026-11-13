"""Error text that is safe to log or show: httpx exception messages embed request URLs, which can carry API keys."""

import httpx


def describe(e: BaseException, secrets: list[str]) -> str:
    if isinstance(e, httpx.HTTPStatusError):
        msg = f"HTTP {e.response.status_code}"
    else:
        msg = str(e) or type(e).__name__
    for secret in secrets:
        msg = msg.replace(secret, "***")
    return msg
