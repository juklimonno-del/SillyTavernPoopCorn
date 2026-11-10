"""Simple, node-scoped and expiring conversational history storage."""

import hashlib
import json
import re
import threading
import time
from pathlib import Path

FOLDER = Path(__file__).resolve().parent / "chats"
_LOCK = threading.RLock()
IDLE_SECONDS = 3600
MAX_TURNS = 24  # 24 user + assistant messages, excluding the system prompt


def _path(node_id):
    slug = hashlib.sha256(str(node_id or "default").encode("utf-8")).hexdigest()[:24]
    return FOLDER / f"session_{slug}.json"


def load(node_id, system_prompt):
    """Returns a new list, never a reference to persisted objects."""
    with _LOCK:
        path = _path(node_id)
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
            if time.time() - float(entry.get("last_updated", 0)) > IDLE_SECONDS:
                raise ValueError("expired")
            messages = entry.get("messages", [])
            if not isinstance(messages, list):
                raise ValueError("bad session")
            filtered = []
            for item in messages:
                if isinstance(item, dict) and item.get("role") in ("user", "assistant") and isinstance(item.get("content"), str):
                    filtered.append({"role": item["role"], "content": item["content"][:45000]})
        except (OSError, ValueError, TypeError):
            filtered = []
        return ([{"role": "system", "content": system_prompt}] if system_prompt.strip() else []) + filtered[-MAX_TURNS:]


def save(node_id, old_messages, prompt, reply):
    with _LOCK:
        history = [m for m in old_messages if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)]
        history.extend([{"role": "user", "content": prompt[:45000]}, {"role": "assistant", "content": reply[:45000]}])
        FOLDER.mkdir(parents=True, exist_ok=True)
        file_path = _path(node_id)
        temp_path = file_path.with_suffix(".tmp")
        temp_path.write_text(json.dumps({"last_updated": time.time(), "messages": history[-MAX_TURNS:]}, ensure_ascii=False), encoding="utf-8")
        temp_path.replace(file_path)
