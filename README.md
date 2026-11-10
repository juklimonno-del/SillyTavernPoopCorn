# ComfyUI NanoGPT LLM Node

A standalone NanoGPT custom node for ComfyUI, modeled on the layout of
[gabe-init's OpenRouter integration](https://github.com/gabe-init/ComfyUI-Openrouter_node).
It uses NanoGPT, not OpenRouter, and can live beside the OpenRouter plugin.

**ComfyUI node:** NanoGPT LLM Node (Text/Multi-Image/PDF/Chat)

**Inputs:** API key, system prompt, user prompt, NanoGPT model list, web search,
cheapest/fastest routing, image aspect/resolution, reasoning effort, seed,
temperature, PDF engine, chat mode, timeout, optional image/PDF connections,
model override, request type (chat/image), and error mode.

**Outputs:** Output (STRING), image (IMAGE), Stats (STRING), Credits (STRING).

## Installation on RunPod

This node is hosted on the **comfyui-nanogpt-node** branch, not the default branch.
Use RunPod's terminal to install it into ComfyUI's `custom_nodes` folder:

```bash
git clone --depth 1 --single-branch --branch comfyui-nanogpt-node \
  https://github.com/juklimonno-del/SillyTavernPoopCorn.git \
  /workspace/ComfyUI/custom_nodes/ComfyUI-NanoGPT-LLM

cd /workspace/ComfyUI/custom_nodes/ComfyUI-NanoGPT-LLM
python -m pip install -r requirements.txt
```

Restart ComfyUI afterwards. If your ComfyUI installation lives in a different
folder, adjust the installation destination accordingly. ComfyUI Manager's generic
"Install via Git URL" often clones only the default branch and therefore does
not work for this branch-hosted node. The terminal command explicitly selects it.

## API key

Use a real NanoGPT API key (not an OpenRouter key):

- **Preferred:** `NANOGPT_API_KEY` in the ComfyUI process environment.
- Or create a file called `nanogpt_api_key.json` in the installed node folder:
  `{"api_key":"YOUR_NANOGPT_API_KEY"}` and use `chmod 600 nanogpt_api_key.json`.
- Or paste your key into the node's `api_key` box, but that can expose the key
  inside saved/shared workflows.

Never commit a real key to GitHub or paste it into chat.

## Source code

The branch contains normal readable source code:
`node.py`, `catalog.py`, `chat_storage.py`, `__init__.py`,
`web/nanogpt_dynamic_images.js`, and offline tests.
The NanoGPT API key is **not** included.

## Capabilities and limitations

- OpenAI-compatible NanoGPT chat completions, vision input, image API generation.
- Multi-image inputs via connected `IMAGE` slots.
- PDF text extraction and up to 4 rendered pages for scanned PDFs.
  The `mistral-ocr` dropdown item is a compatibility label; it uses rendered PDF
  pages with NanoGPT vision, **not** OpenRouter's Mistral OCR service.
- Model discovery is cached. Use the `model_override` box for a custom model ID.
- Chat mode stores a local per-node conversation cache.
- Credits checks NanoGPT balance separately from LLM call.
- Does **not** implement NanoGPT video generation or all OpenRouter-specific
  image/video provider controls.

Only local mock tests have been run, not live calls to NanoGPT or RunPod.
