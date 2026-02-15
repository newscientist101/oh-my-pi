"""RLM functions injected into IPython kernel when RLM mode is active.

Security Model:
--------------
The RLM prelude communicates with a local HTTP server (LMHandler) for sub-LLM queries.
Security is enforced through multiple layers:

1. **Token Authentication**: Every request requires a Bearer token in the
   Authorization header. The token is generated per-session, stored only in
   memory, and invalidated when the session ends.

2. **Loopback-Only**: The _configure() function validates that the handler URL
   hostname is a loopback address (127.0.0.1, localhost, or ::1). This prevents
   accidentally connecting to external servers.

3. **Timeout**: All requests have a configurable timeout (default 300s) to
   prevent indefinite hangs.

Token Lifecycle:
- Token is passed via _configure() when RLM mode starts
- Token is valid only for the current session
- Token is invalidated when LMHandler.stop() is called (session end, /new, cleanup)
- No token rotation within a session; relies on short session lifetime
"""

import json as _json
import urllib.error as _urllib_error
import urllib.request as _urllib_request
from typing import Any as _Any

_HANDLER_URL: str | None = None
_SESSION_TOKEN: str | None = None
_DEPTH: int = 0
_TIMEOUT: int = 300  # seconds; configurable via _configure()


def _configure(url: str, token: str, depth: int = 0, timeout: int = 300) -> None:
    """Called by the TypeScript side to set up the handler connection.

    This function is called automatically when RLM mode starts. It validates
    the handler URL is loopback-only for security before accepting it.

    Security:
        - URL hostname must be 127.0.0.1, localhost, or ::1 (raises ValueError otherwise)
        - Token is per-session, memory-only, invalidated when session ends
        - See module docstring for full security model

    Args:
        url: The LM handler URL (must be loopback: 127.0.0.1 or localhost)
        token: Session token for authorization (per-session, memory-only)
        depth: Current recursion depth (incremented for nested llm_query calls)
        timeout: Request timeout in seconds (default 300)

    Raises:
        ValueError: If URL hostname is not a loopback address
    """
    global _HANDLER_URL, _SESSION_TOKEN, _DEPTH, _TIMEOUT

    # Security: validate that URL is loopback-only
    from urllib.parse import urlparse

    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    if hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError(
            f"LM handler URL must be loopback (127.0.0.1/localhost), got: {hostname}"
        )

    _HANDLER_URL = url
    _SESSION_TOKEN = token
    _DEPTH = depth
    _TIMEOUT = timeout


def _lm_request(payload: dict[str, _Any]) -> dict[str, _Any]:
    """POST JSON to the LM handler, return parsed response.

    Args:
        payload: JSON-serializable dict with request data

    Returns:
        Parsed JSON response from the handler

    Raises:
        RuntimeError: If handler is not configured, request fails, or response contains error
    """
    if _HANDLER_URL is None or _SESSION_TOKEN is None:
        raise RuntimeError("LM handler not configured - call _configure() first")

    body = _json.dumps(payload).encode("utf-8")
    req = _urllib_request.Request(
        _HANDLER_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_SESSION_TOKEN}",
        },
    )

    try:
        with _urllib_request.urlopen(req, timeout=_TIMEOUT) as resp:
            result = _json.loads(resp.read().decode("utf-8"))
    except KeyboardInterrupt:
        # Convert interrupt to clean error - lets agent see the cancellation
        raise RuntimeError("LLM query cancelled")
    except _urllib_error.HTTPError as e:
        # Parse structured error response from LM handler
        response_body = e.read().decode("utf-8", errors="replace")
        try:
            err = _json.loads(response_body)
            msg = err.get("error", response_body)
            retryable = err.get("retryable", False)
        except _json.JSONDecodeError:
            msg = response_body
            retryable = False
        raise RuntimeError(
            f"LLM query failed (HTTP {e.code}, retryable={retryable}): {msg}"
        )
    except _urllib_error.URLError as e:
        raise RuntimeError(f"LLM handler unreachable: {e.reason}")
    except TimeoutError:
        # Socket timeout - urlopen timed out waiting for response
        raise RuntimeError(f"LLM query timed out after {_TIMEOUT} seconds")

    # Check for error in successful response (shouldn't happen, but defensive)
    if "error" in result:
        raise RuntimeError(result["error"])

    return result


def llm_query(prompt: str, model: str | None = None) -> str:
    """Query a sub-LLM. Returns the response text.

    Use this to analyze chunks of data that are too large for a single context,
    or to delegate sub-tasks to another LLM call.

    Args:
        prompt: The prompt to send to the sub-LLM
        model: Optional model override (default: uses configured sub-model)

    Returns:
        The LLM's response text

    Example:
        summary = llm_query(f"Summarize this text: {chunk}")
    """
    result = _lm_request(
        {
            "prompt": prompt,
            "model": model,
            "depth": _DEPTH,
        }
    )
    return result["content"]


def llm_query_batched(prompts: list[str], model: str | None = None) -> list[str]:
    """Query a sub-LLM with multiple prompts in parallel.

    More efficient than multiple sequential llm_query() calls when you have
    independent prompts that don't depend on each other's results.

    Note: Server may apply concurrency limits to prevent rate limiting.

    Args:
        prompts: List of prompts to send
        model: Optional model override (default: uses configured sub-model)

    Returns:
        List of response texts, in the same order as the input prompts

    Example:
        chunks = [data[i:i+1000] for i in range(0, len(data), 1000)]
        summaries = llm_query_batched([f"Summarize: {c}" for c in chunks])
    """
    result = _lm_request(
        {
            "prompts": prompts,
            "model": model,
            "depth": _DEPTH,
            "batched": True,
        }
    )
    return result["contents"]


def SHOW_VARS() -> dict[str, str]:
    """Show all user-defined variables in the current REPL session.

    Use this to check what variables exist before using FINAL_VAR().
    Returns a dict mapping variable names to their type names.

    Returns:
        Dict of {variable_name: type_name} for user-defined variables

    Example:
        >>> SHOW_VARS()
        {'results': 'list', 'summary': 'str', 'data': 'dict'}
    """
    try:
        from IPython import get_ipython
    except ImportError:
        return {}  # Not in IPython environment

    ip = get_ipython()
    if ip is None:
        return {}

    user_ns = ip.user_ns

    # Filter out IPython internals and RLM prelude functions
    skip = {
        # IPython built-ins
        "In",
        "Out",
        "get_ipython",
        "exit",
        "quit",
        "open",
        # RLM prelude functions
        "llm_query",
        "llm_query_batched",
        "SHOW_VARS",
        "context",
        "_configure",
        "_lm_request",
        # IPython history variables
        "_",
        "__",
        "___",
        "_i",
        "_ii",
        "_iii",
        # RLM module internals
        "_HANDLER_URL",
        "_SESSION_TOKEN",
        "_DEPTH",
        "_TIMEOUT",
        "_json",
        "_urllib_error",
        "_urllib_request",
        "_Any",
    }

    return {
        k: type(v).__name__
        for k, v in user_ns.items()
        if not k.startswith("_")
        and k not in skip
        and not callable(v)
        and not k.startswith("_i")  # Skip _i1, _i2, etc.
    }
