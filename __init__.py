"""NanoGPT ComfyUI LLM node: independent integration inspired by gabe-init's UI."""

from .node import NanoGPTNode

NODE_CLASS_MAPPINGS = {
    "NanoGPTNode": NanoGPTNode,
    "nanogpt_llm_node": NanoGPTNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NanoGPTNode": "NanoGPT LLM Node (Text/Multi-Image/PDF/Chat)",
    "nanogpt_llm_node": "NanoGPT LLM Node (Text/Multi-Image/PDF/Chat)",
}
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
