"""Offline tests. Deliberately do NOT make paid NanoGPT requests."""

import base64
import importlib.util
import io
import pathlib
import sys
import unittest
from unittest.mock import patch

import torch
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]

spec = importlib.util.spec_from_file_location(
    "nanogpt_test_package", str(ROOT / "__init__.py"),
    submodule_search_locations=[str(ROOT)]
)
package = importlib.util.module_from_spec(spec)
sys.modules["nanogpt_test_package"] = package
spec.loader.exec_module(package)
from nanogpt_test_package import node  # noqa: E402


class MockResponse:
    def __init__(self, data, status=200):
        self.data = data
        self.status_code = status
        self.text = "fake test response"

    def json(self):
        return self.data

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests
            raise requests.HTTPError(f"HTTP {self.status_code}")


def as_b64_image():
    im = Image.new("RGB", (4, 4), color=(200, 50, 150))
    data = io.BytesIO()
    im.save(data, format="PNG")
    return base64.b64encode(data.getvalue()).decode("ascii")


class NanoGPTNodeTests(unittest.TestCase):
    def setUp(self):
        self.node = node.NanoGPTNode()
        self.base = dict(
            api_key="FAKE_NANOGPT_TEST_KEY", system_prompt="You are an assistant.",
            user_message_box="Describe the moon", model="z-ai/glm-5.3",
            web_search=False, cheapest=False, fastest=False,
            temperature=0.8, pdf_engine="auto", chat_mode=False,
            request_timeout=120, on_error="raise",
        )

    def _fake_post(self, url, **kwargs):
        self.last_url = url
        if url.endswith("check-balance"):
            self.assertEqual(kwargs["headers"]["x-api-key"], "FAKE_NANOGPT_TEST_KEY")
            return MockResponse({"usd_balance": "4.1257"})
        self.last_payload = kwargs["json"]
        if url.endswith("/chat/completions"):
            return MockResponse({
                "choices": [{"message": {"role": "assistant", "content": "The moon glows."}}],
                "usage": {"prompt_tokens": 20, "completion_tokens": 4, "cost": 0.0012}
            })
        if url.endswith("/images/generations"):
            return MockResponse({"data": [{"b64_json": as_b64_image()}]})
        raise AssertionError(url)

    def test_text_chat_and_credit(self):
        with patch.object(node.requests, "post", side_effect=self._fake_post):
            output, image, stats, credits = self.node.generate_response(**self.base)
        self.assertEqual(output, "The moon glows.")
        self.assertEqual(tuple(image.shape), (1, 1, 1, 3))
        self.assertEqual(credits, "Remaining: $4.126")
        self.assertIn("Cost: $0.001200", stats)
        self.assertEqual(self.last_payload["messages"][0]["role"], "system")

    def test_vision_and_reasoning(self):
        args = {**self.base, "reasoning_effort": "high", "web_search": True, "cheapest": True,
                "image_1": torch.zeros((1, 10, 10, 3)), "seed": 10}
        with patch.object(node.requests, "post", side_effect=self._fake_post):
            self.node.generate_response(**args)
        self.assertIn(":online", self.last_payload["model"])
        self.assertIn(":floor", self.last_payload["model"])
        self.assertEqual(self.last_payload["reasoning_effort"], "high")
        self.assertEqual(self.last_payload["seed"], 10)
        parts = self.last_payload["messages"][-1]["content"]
        self.assertEqual(parts[1]["type"], "image_url")
        self.assertTrue(parts[1]["image_url"]["url"].startswith("data:image/"))

    def test_fastest_modifier(self):
        args = {**self.base, "fastest": True}
        with patch.object(node.requests, "post", side_effect=self._fake_post):
            self.node.generate_response(**args)
        self.assertEqual(self.last_payload["model"], "z-ai/glm-5.3:nitro")

    def test_image_generation(self):
        args = {**self.base, "model_override": "hidream", "request_type": "image", "aspect_ratio": "1:1 (1024x1024)"}
        with patch.object(node.requests, "post", side_effect=self._fake_post):
            output, image, stats, credits = self.node.generate_response(**args)
        self.assertEqual(output, "")
        self.assertEqual(tuple(image.shape), (1, 4, 4, 3))
        self.assertEqual(self.last_payload["model"], "hidream")
        self.assertEqual(self.last_payload["size"], "1024x1024")

    def test_error_policy(self):
        def fake_post(url, **kw):
            return MockResponse({"error": {"message": "Invalid model"}}, 400)
        with patch.object(node.requests, "post", side_effect=fake_post):
            with self.assertRaisesRegex(RuntimeError, "HTTP 400"):
                self.node.generate_response(**self.base)
            output, image, stats, _ = self.node.generate_response(**{**self.base, "on_error": "return_error"})
        self.assertIn("Invalid model", output)
        self.assertIn("FAILED", stats)

    def test_pdf_extract(self):
        import fitz
        doc = fitz.open()
        page = doc.new_page()
        page.insert_text((72, 80), "This is a test PDF to describe.")
        pdf_bytes = doc.tobytes()
        doc.close()
        content, imgs, note = node._pdf_contents({"bytes": pdf_bytes, "filename": "test.pdf"}, "auto")
        self.assertIn("test PDF", content)
        self.assertEqual(imgs, [])
        self.assertEqual(note, "PDF: local text")

    def test_dynamic_slot_names_not_embedded_in_required_inputs(self):
        with patch.object(node.catalog, "fetch_models", return_value=["z-ai/glm-5.3"]):
            inputs = self.node.INPUT_TYPES()
        self.assertEqual(inputs["required"]["model"][0][0], "z-ai/glm-5.3")
        self.assertEqual(self.node.RETURN_NAMES, ("Output", "image", "Stats", "Credits"))
        self.assertIn("pdf_data", inputs["optional"])


if __name__ == "__main__":
    unittest.main()
