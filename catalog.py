"""Low-impact NanoGPT model discovery with a local cache and offline fallback."""

import json
import logging
import os
import threading
import time
from pathlib import Path

import requests

API_BASE = "https://api.nano-gpt.com"
API_VERSION = API_BASE + "/api/v1"
NODE_DIR = Path(__file__).resolve().parent
CACHE_PATH = NODE_DIR / "nanogpt_models_cache.json"
MODEL_FALLBACK = ["z-ai/glm-5.3", "openai/gpt-6.1-sol", "hidream"]
CACHE_SECONDS = 3600
_lock = threading.RLock()
_cached = None
_last_attempt = 0
_logger = logging.getLogger(__name__)


def api_key_from_config():
    """Never return an OpenRouter key. The NanoGPT key is independent."""
    for env_name in ("NANOGPT_API_KEY", "NANO_GPT_API_KEY"):
        value = os.environ.get(env_name, "").strip()
        if value:
            return value
    path = NODE_DIR / "nanogpt_api_key.json"
    if path.is_file():
        try:
            value = json.loads(path.read_text(encoding="utf-8")).get("api_key", "")
            if isinstance(value, str):
                return value.strip()
        except (ValueError, OSError, TypeError) as exc:
            _logger.warning("NanoGPT: could not read key configuration: %s", exc)
    return ""


def _model_ids(value):
    if isinstance(value, dict):
        value = value.get("data", value.get("models", []))
    if not isinstance(value, list):
        return set()
    result = set()
    for item in value:
        candidate = item.get("id") if isinstance(item, dict) else item
        if isinstance(candidate, str) and 0 < len(candidate) < 256:
            result.add(candidate)
    return result


def _cache_read():
    try:
        obj = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        models = obj.get("models", [])
        if not isinstance(models, list):
            return None
        models = sorted(_model_ids(models))
        if not models:
            return None
        return {"models": models, "timestamp": float(obj.get("timestamp", 0))}
    except (OSError, ValueError, TypeError):
        return None


def fetch_models():
    """Called from INPUT_TYPES; timeout is bounded to avoid blocking Comfy startup."""
    global _cached, _last_attempt
    with _lock:
        now = time.time()
        if _cached and now - _last_attempt < CACHE_SECONDS:
            return _cached
        stored = _cache_read()
        if stored and now - stored["timestamp"] < CACHE_SECONDS:
            _cached = stored["models"]
            _last_attempt = now
            return _cached
        if now - _last_attempt < 60:
            return _cached or (stored or {}).get("models") or MODEL_FALLBACK
        _last_attempt = now
        api_key = api_key_from_config()
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        models = set()
        for route in ("/api/v1/models", "/api/v1/image-models"):
            try:
                response = requests.get(API_BASE + route, headers=headers, timeout=(3, 6))
                response.raise_for_status()
                models |= _model_ids(response.json())
            except (requests.RequestException, ValueError, TypeError) as exc:
                _logger.debug("NanoGPT model discovery %s: %s", route, exc)
        if models:
            _cached = sorted(models)
            try:
                CACHE_PATH.write_text(json.dumps({"timestamp": now, "models": _cached}), encoding="utf-8")
            except OSError:
                pass
        else:
            _cached = (stored or {}).get("models") or MODEL_FALLBACK
        return _cached
