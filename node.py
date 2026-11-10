"""NanoGPT LLM for ComfyUI.

Standalone implementation matching the four-output UI of gabe-init's
OpenRouter node, with NanoGPT-specific request and account endpoints.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import math
import re
import socket
import time
import ipaddress
from urllib.parse import urlsplit

import numpy as np
import requests
import torch
from PIL import Image

from . import catalog
from . import chat_storage

LOGGER = logging.getLogger(__name__)
PDF_DATA_TYPE = "*"
PLACEHOLDER_SHAPE = (1, 1, 1, 3)
CHAT_URL = catalog.API_VERSION + "/chat/completions"
IMAGE_URL = catalog.API_BASE + "/v1/images/generations"
BALANCE_URL = catalog.API_BASE + "/api/check-balance"
MAX_IMAGES = 10
MAX_PDF_PAGES = 4
MAX_PDF_CHARS = 55000
ASPECT_OPTIONS = [
    "auto", "1:1 (1024x1024)", "2:3 (832x1248)", "3:2 (1248x832)",
    "3:4 (864x1184)", "4:3 (1184x864)", "4:5 (896x1152)",
    "5:4 (1152x896)", "9:16 (768x1344)", "16:9 (1344x768)",
    "21:9 (1536x672)", "1:4 (512x2048)", "4:1 (2048x512)",
    "1:8 (512x4096)", "8:1 (4096x512)",
]
REASONING_OPTIONS = ("auto", "none", "minimal", "low", "medium", "high", "xhigh", "max")


def _placeholder():
    return torch.zeros(PLACEHOLDER_SHAPE, dtype=torch.float32)


def _json_response(res, api_key=""):
    """Only include short sanitized diagnostics, never print full bodies/keys/media."""
    try:
        res.raise_for_status()
    except requests.HTTPError as exc:
        try:
            data = res.json()
            error = data.get("error", data) if isinstance(data, dict) else data
            detail = error.get("message", str(error)) if isinstance(error, dict) else str(error)
        except (ValueError, TypeError):
            detail = (res.text or "")[:350]
        detail = re.sub(r"data:[^\s\"']+", "[media omitted]", str(detail))
        if api_key:
            detail = detail.replace(api_key, "[redacted]")
        raise RuntimeError(f"NanoGPT HTTP {res.status_code}: {detail[:500]}") from exc
    try:
        return res.json()
    except ValueError as exc:
        raise RuntimeError("NanoGPT returned a non-JSON API response") from exc


def _img_url_from_tensor(tensor):
    """Convert the first ComfyUI IMAGE batch frame into a compact inline data URL."""
    if not isinstance(tensor, torch.Tensor):
        raise ValueError("IMAGE input must be a ComfyUI image tensor")
    data = tensor.detach().to("cpu", dtype=torch.float32).numpy()
    if data.ndim == 4:
        data = data[0]
    if data.ndim != 3 or data.shape[2] not in (1, 3, 4):
        raise ValueError("Expected IMAGE tensor with shape [B,H,W,C]")
    data = np.uint8(np.clip(data, 0, 1) * 255 + 0.5)
    mode = {1: "L", 3: "RGB", 4: "RGBA"}[data.shape[2]]
    pil = Image.fromarray(data.squeeze(-1) if mode == "L" else data, mode=mode)
    if max(pil.size) > 1536:
        pil.thumbnail((1536, 1536), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    if mode == "RGBA":
        pil.save(buf, format="PNG", optimize=True)
        mime = "image/png"
    else:
        pil.convert("RGB").save(buf, format="JPEG", quality=88)
        mime = "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(buf.getvalue()).decode('ascii')}"


def _image_tensor_from_bytes(data):
    if not data or len(data) > 75 * 1024 * 1024:
        raise ValueError("Generated image data is missing or too large")
    with Image.open(io.BytesIO(data)) as im:
        im.load()
        mode = "RGBA" if "A" in im.getbands() or "transparency" in im.info else "RGB"
        arr = np.asarray(im.convert(mode), dtype=np.float32) / 255.0
    return torch.from_numpy(arr.copy()).unsqueeze(0)


def _read_url_data(url, timeout):
    """Support temporary public image links, without fetching local network resources."""
    if not isinstance(url, str):
        raise ValueError("Invalid generated image URL")
    if url.startswith("data:image/") and ";base64," in url:
        return base64.b64decode(url.split(",", 1)[1], validate=True)
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Generated image URL must be public HTTPS")
    try:
        addrs = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
        if not addrs or any(not ipaddress.ip_address(info[4][0]).is_global for info in addrs):
            raise ValueError("Generated image URL resolves to an unsafe address")
    except socket.gaierror as exc:
        raise ValueError("Could not resolve generated image URL") from exc
    # Requests does not follow redirects to other origins here; URL in response is temporary.
    response = requests.get(url, timeout=(10, min(60, timeout)), stream=True, allow_redirects=False)
    try:
        response.raise_for_status()
        if response.is_redirect:
            raise ValueError("Redirecting image URLs are not accepted")
        chunks = []
        size = 0
        for chunk in response.iter_content(chunk_size=65536):
            size += len(chunk)
            if size > 75 * 1024 * 1024:
                raise ValueError("Generated image exceeds 75 MB")
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        response.close()


def _decode_images(links, timeout):
    tensors = []
    for item in links:
        try:
            if isinstance(item, dict):
                if isinstance(item.get("image_url"), dict):
                    item = item["image_url"].get("url")
                else:
                    item = item.get("b64_json") or item.get("url") or item.get("data")
            if not item or not isinstance(item, str):
                continue
            if item.startswith("data:image/"):
                raw = _read_url_data(item, timeout)
            elif item.startswith("https://"):
                raw = _read_url_data(item, timeout)
            else:
                # OpenAI images endpoint emits raw base64 in b64_json.
                raw = base64.b64decode(item, validate=True)
            tensors.append(_image_tensor_from_bytes(raw))
        except (ValueError, requests.RequestException, OSError) as exc:
            LOGGER.warning("NanoGPT: could not decode one generated image: %s", str(exc)[:150])
    if not tensors:
        return _placeholder()
    if len(tensors) == 1:
        return tensors[0]
    # ComfyUI image batches must all have the same shape and channel count.
    first = tensors[0]
    if all(t.shape == first.shape for t in tensors):
        return torch.cat(tensors, dim=0)
    LOGGER.info("NanoGPT: generated images have different dimensions; using first image")
    return first


def _parse_reply(body, timeout):
    choices = body.get("choices") if isinstance(body, dict) else None
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("NanoGPT returned no chat completion choices")
    message = (choices[0] or {}).get("message") or {}
    content = message.get("content")
    texts = []
    imgs = []
    if isinstance(content, str):
        texts.append(content)
    elif isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") in ("text", "output_text"):
                texts.append(str(item.get("text") or ""))
            elif item.get("type") in ("image_url", "image", "output_image"):
                imgs.append(item.get("image_url") or item.get("image") or item.get("b64_json"))
    if isinstance(message.get("images"), list):
        imgs.extend(message["images"])
    return "\n".join(t for t in texts if t), _decode_images(imgs, timeout)


def _pdf_contents(pdf_data, engine):
    """Use local PDF text extraction; for scanned pages, send page images to vision LLM."""
    if not isinstance(pdf_data, dict) or not isinstance(pdf_data.get("bytes"), (bytes, bytearray)):
        raise ValueError("pdf_data must be a dict with {'filename': ..., 'bytes': <PDF bytes>}")
    pdf_bytes = bytes(pdf_data["bytes"])
    if not pdf_bytes.startswith(b"%PDF-"):
        raise ValueError("pdf_data does not contain PDF bytes")
    if len(pdf_bytes) > 40 * 1024 * 1024:
        raise ValueError("PDF exceeds 40 MB; split it before sending")
    filename = str(pdf_data.get("filename") or "document.pdf")[:120]
    text = ""
    if engine != "mistral-ocr":
        try:
            from pypdf import PdfReader
            pdf = PdfReader(io.BytesIO(pdf_bytes), strict=False)
            segments = []
            total = 0
            for idx, page in enumerate(pdf.pages):
                if idx >= 45 or total >= MAX_PDF_CHARS:
                    break
                extracted = page.extract_text() or ""
                if extracted.strip():
                    segments.append(f"[Page {idx + 1}]\n{extracted}")
                    total += len(extracted)
            text = "\n\n".join(segments)[:MAX_PDF_CHARS]
        except Exception as exc:
            LOGGER.debug("NanoGPT PDF text extraction failed: %s", exc)
    if engine == "pdf-text":
        if not text.strip():
            raise ValueError("No extractable PDF text. Use pdf_engine=auto for scanned PDFs")
        return f"\n\n[Attached PDF: {filename}]\n{text}\n[End PDF]", [], "PDF: local text"
    if text.strip() and engine == "auto":
        return f"\n\n[Attached PDF: {filename}]\n{text}\n[End PDF]", [], "PDF: local text"
    # 'mistral-ocr' widget value is legacy-compatible but we DO NOT use Mistral's OCR.
    # Instead, render a few PDF pages locally and let the selected NanoGPT vision LLM read them.
    try:
        import fitz
    except ImportError as exc:
        raise RuntimeError("Scanned PDF support requires PyMuPDF (pip install -r requirements.txt)") from exc
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    if len(doc) == 0:
        raise ValueError("Empty PDF")
    urls = []
    try:
        for page_i in range(min(MAX_PDF_PAGES, len(doc))):
            page = doc.load_page(page_i)
            zoom = min(1.5, 1400.0 / max(page.rect.width, page.rect.height))
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            im = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=83)
            urls.append("data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii"))
    finally:
        doc.close()
    note = f"PDF: rendered {len(urls)} page(s) for NanoGPT vision (not Mistral OCR)"
    return f"\n\n[Attached PDF: {filename}, first {len(urls)} pages attached as images. Read the pages directly.]", urls, note


def _float_or_none(val):
    try:
        n = float(val)
        return n if math.isfinite(n) else None
    except (ValueError, TypeError):
        return None


def _stats(body, model, seconds, temperature, pdf_note=""):
    usage = body.get("usage", {}) if isinstance(body, dict) else {}
    usage = usage if isinstance(usage, dict) else {}
    p = usage.get("prompt_tokens", usage.get("input_tokens"))
    c = usage.get("completion_tokens", usage.get("output_tokens"))
    cost = _float_or_none(usage.get("cost", body.get("cost")))
    parts = [f"Model: {model}", f"Time: {seconds:.2f}s", f"Temperature: {temperature:.2f}"]
    if p is not None:
        parts.append(f"Input: {p} tokens")
    if c is not None:
        parts.append(f"Output: {c} tokens")
        try:
            parts.append(f"Speed: {float(c) / max(seconds, 0.01):.2f} tokens/s")
        except (ValueError, TypeError):
            pass
    if cost is not None:
        parts.append(f"Cost: ${cost:.6f}")
    if pdf_note:
        parts.append(pdf_note)
    return " | ".join(parts)


class NanoGPTNode:
    """NanoGPT chat node with original-style in/out ports and optional image generation."""

    RETURN_TYPES = ("STRING", "IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("Output", "image", "Stats", "Credits")
    FUNCTION = "generate_response"
    CATEGORY = "LLM"
    DESCRIPTION = "NanoGPT text/vision/PDF/chat API. Choose request_type=image for its image API."

    @classmethod
    def INPUT_TYPES(cls):
        models = catalog.fetch_models()
        # Guarantee a reasonable default for a new workflow, even with a huge catalog.
        preferred = "z-ai/glm-5.3"
        models = ([preferred] if preferred in models else []) + [m for m in models if m != preferred]
        return {
            "required": {
                "api_key": ("STRING", {"default": "", "multiline": False}),
                "system_prompt": ("STRING", {"multiline": True, "default": "You are a helpful assistant."}),
                "user_message_box": ("STRING", {"multiline": True, "default": "Hello, how are you?"}),
                "model": (models,),
                "web_search": ("BOOLEAN", {"default": False}),
                "cheapest": ("BOOLEAN", {"default": False}),
                "fastest": ("BOOLEAN", {"default": False}),
                "aspect_ratio": (ASPECT_OPTIONS, {"default": "1:1 (1024x1024)"}),
                "image_resolution": (["auto", "1K", "2K", "4K"], {"default": "1K"}),
                "reasoning_effort": (list(REASONING_OPTIONS), {"default": "auto"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0x7FFFFFFFFFFFFFFF, "control_after_generate": "fixed"}),
                "temperature": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.01, "round": 0.01, "display": "slider"}),
                "pdf_engine": (["auto", "mistral-ocr", "pdf-text"], {"default": "auto"}),
                "chat_mode": ("BOOLEAN", {"default": False}),
                "request_timeout": ("INT", {"default": 120, "min": 1, "max": 3600, "step": 1}),
            },
            "optional": {
                "pdf_data": (PDF_DATA_TYPE,),
                "user_message_input": ("STRING", {"forceInput": True}),
                "model_override": ("STRING", {"default": "", "multiline": False}),
                "request_type": (["chat", "image"], {"default": "chat"}),
                "on_error": (["raise", "return_error"], {"default": "raise"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # Cached model menus can lag new NanoGPT releases; allow workflow IDs / overrides.
        return True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # LLM calls are intentional operations. Re-run on each Queue, even if prompts match.
        return float("nan")

    @staticmethod
    def _balance(api_key, timeout):
        try:
            response = requests.post(BALANCE_URL, headers={"x-api-key": api_key}, timeout=(5, min(15, timeout)))
            info = _json_response(response, api_key)
            balance = _float_or_none(info.get("usd_balance")) if isinstance(info, dict) else None
            return f"Remaining: ${balance:.3f}" if balance is not None else "Balance unavailable"
        except (requests.RequestException, RuntimeError, ValueError):
            # Balance lookup must never fail a successful completion.
            return "Balance unavailable"

    @staticmethod
    def _image_size(aspect_ratio, image_resolution):
        # The public image endpoint accepts model-specific sizes. Suppress size in auto mode.
        if str(aspect_ratio).startswith("auto"):
            return None
        match = re.search(r"\((\d+)x(\d+)\)", str(aspect_ratio))
        if not match:
            return None
        width, height = (int(match.group(1)), int(match.group(2)))
        multiplier = {"auto": 1, "1K": 1, "2K": 2, "4K": 4}.get(image_resolution, 1)
        return f"{width * multiplier}x{height * multiplier}"

    @staticmethod
    def _model_with_routing(model, web_search, cheapest, fastest):
        # NanoGPT supports :floor and :nitro aliases, though their exact routing
        # semantics differ slightly from OpenRouter (see docs).
        if not isinstance(model, str) or not model.strip():
            raise ValueError("Select a model or enter an exact NanoGPT model_override")
        result = model.strip()
        if web_search and ":online" not in result:
            result += ":online"
        if cheapest and not any(s in result for s in (":floor", ":price", ":cheap", ":nitro", ":throughput")):
            result += ":floor"
        elif fastest and not cheapest and not any(s in result for s in (":nitro", ":throughput", ":floor", ":price", ":cheap")):
            result += ":nitro"
        return result

    def generate_response(
        self, api_key, system_prompt, user_message_box, model, web_search=False,
        cheapest=False, fastest=False, aspect_ratio="auto", image_resolution="1K",
        reasoning_effort="auto", seed=0, temperature=1.0, pdf_engine="auto",
        chat_mode=False, request_timeout=120, pdf_data=None, user_message_input=None,
        model_override="", request_type="chat", on_error="raise", unique_id=None, **kwargs,
    ):
        key = (api_key or "").strip() or catalog.api_key_from_config()
        try:
            if not key:
                raise ValueError("NanoGPT API key missing. Set NANOGPT_API_KEY or nanogpt_api_key.json, or use api_key widget")
            selected_model = (model_override or "").strip() or model
            if not isinstance(selected_model, str) or not selected_model:
                raise ValueError("NanoGPT model ID is empty")
            timeout = max(1, min(int(request_timeout), 3600))
            temp = max(0.0, min(2.0, float(temperature)))
            prompt = str(user_message_input if user_message_input is not None else user_message_box or "")
            supplied_images = []
            # Original dynamic front-end emits image_1 through image_10 when wired.
            image_names = sorted((k for k in kwargs if re.fullmatch(r"image(?:_\d+)?", k)),
                                 key=lambda n: int(n.split("_")[1]) if "_" in n else 0)
            for name in image_names:
                if kwargs[name] is not None:
                    supplied_images.append(_img_url_from_tensor(kwargs[name]))
                if len(supplied_images) >= MAX_IMAGES:
                    break
            headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
            t0 = time.monotonic()
            if request_type == "image":
                if pdf_data is not None:
                    raise ValueError("PDF input is supported in chat mode only")
                if not prompt.strip():
                    raise ValueError("Enter an image prompt")
                data = {"model": selected_model, "prompt": prompt, "n": 1, "response_format": "b64_json"}
                size = self._image_size(aspect_ratio, image_resolution)
                if size:
                    data["size"] = size
                if seed:
                    data["seed"] = int(seed)
                if supplied_images:
                    data["imageDataUrls"] = supplied_images
                result = _json_response(requests.post(IMAGE_URL, headers=headers, json=data, timeout=(15, timeout)), key)
                image_data = (result.get("data") or []) if isinstance(result, dict) else []
                tensor = _decode_images(image_data, timeout)
                if not image_data or tuple(tensor.shape) == PLACEHOLDER_SHAPE:
                    raise RuntimeError("NanoGPT image API returned no decoded images")
                elapsed = time.monotonic() - t0
                info = _stats(result, selected_model, elapsed, temp)
                return ("", tensor, info, self._balance(key, timeout))
            if request_type != "chat":
                raise ValueError("request_type must be chat or image")
            pdf_note = ""
            if pdf_data is not None:
                pdf_text, page_images, pdf_note = _pdf_contents(pdf_data, pdf_engine)
                prompt += pdf_text
                supplied_images.extend(page_images)
            parts = [{"type": "text", "text": prompt}]
            for data_url in supplied_images:
                parts.append({"type": "image_url", "image_url": {"url": data_url}})
            user_entry = {"role": "user", "content": prompt if len(parts) == 1 else parts}
            system = str(system_prompt or "")
            if chat_mode:
                messages = chat_storage.load(unique_id, system)
            else:
                messages = [{"role": "system", "content": system}] if system.strip() else []
            messages.append(user_entry)
            routed_model = self._model_with_routing(selected_model, web_search, cheapest, fastest)
            data = {
                "model": routed_model,
                "messages": messages,
                "temperature": temp,
                "stream": False,
                "include_usage": True,
            }
            if reasoning_effort != "auto":
                if reasoning_effort not in REASONING_OPTIONS:
                    raise ValueError("Unsupported reasoning_effort")
                data["reasoning_effort"] = reasoning_effort
            if seed:
                data["seed"] = int(seed)
            result = _json_response(requests.post(CHAT_URL, headers=headers, json=data, timeout=(15, timeout)), key)
            answer, tensor = _parse_reply(result, timeout)
            elapsed = time.monotonic() - t0
            if chat_mode:
                try:
                    # Only keep plain text, never base64 image bytes or PDF payloads.
                    chat_storage.save(unique_id, messages[:-1], str(user_message_input if user_message_input is not None else user_message_box or ""), answer)
                except OSError as exc:
                    LOGGER.warning("NanoGPT: could not save chat history: %s", exc)
            return (answer, tensor, _stats(result, routed_model, elapsed, temp, pdf_note), self._balance(key, timeout))
        except Exception as exc:
            message = str(exc)
            if key:
                message = message.replace(key, "[redacted]")
            message = re.sub(r"data:[^\s\"']+", "[media omitted]", message)[:750]
            if on_error == "return_error":
                return (f"Error: {message}", _placeholder(), f"FAILED: {message}", "Balance unavailable")
            raise RuntimeError(f"NanoGPT node: {message}") from exc
