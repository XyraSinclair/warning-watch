"""Shared request headers and refusal classing for ADS-B Exchange fetches.

Since ~2026-07/08 the globe.adsbexchange.com CDN returns 403 for requests
without a globe Referer (a bare User-Agent is no longer enough). With the
Referer present, semantics are unchanged: existing slots return 200 and
missing/future slots return 404, which callers already handle.
"""

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
)

GLOBE_HEADERS = {
    "User-Agent": USER_AGENT,
    "Referer": "https://globe.adsbexchange.com/",
    "Accept": "*/*",
}

DOWNLOAD_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
}


class ArchiveUnavailable(Exception):
    """The archive did not answer a read, or has published nothing in the window asked.

    The archive is a third party's: nothing on the box ends this and the next pass asks
    again, so every reader records it as a poll failure (EX_TEMPFAIL; the poller's
    lastPollError in refresh-state.json, the repair's skipped action) and not as a failed
    stage of the box's own. On 23 Oct 2026 four reads timed out in eight minutes, each
    failed the ingest stage, and that paged at high.
    """


def raise_if_archive_unavailable(error, url):
    """Raise ArchiveUnavailable for the answers that are the archive's own; return for the rest.

    The server's own failures are the archive's, and so is the one refusal that names its
    reason: since 14:08 UTC on 28 Oct 2026 the archive answers every scripted read, from
    any vantage and with the globe headers, 403 "Historical data requires a verified
    session", a gate the globe page's own scripts open through reCAPTCHA and nothing on
    the box does. Any other refusal means our request is wrong, and the caller decides.
    """
    if error.code == 429 or error.code >= 500:
        raise ArchiveUnavailable(f"HTTP {error.code} from {url}") from error
    if error.code == 403:
        reason = error.read(300).decode("utf-8", "replace").strip()
        if "verified session" in reason:
            raise ArchiveUnavailable(f"{reason} (HTTP 403, {url})") from error
