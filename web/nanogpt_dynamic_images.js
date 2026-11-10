/** Minimal dynamic IMAGE inputs, matching the familiar OpenRouter node UX. */
import { app } from "../../../scripts/app.js";

const NODE_NAMES = new Set(["NanoGPTNode", "nanogpt_llm_node"]);
const isImage = (name) => /^image(?:_\d+)?$/.test(name || "");
const MAX_IMAGES = 10;

app.registerExtension({
  name: "NanoGPT.DynamicImageInputs",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_NAMES.has(nodeData.name)) return;

    const origCreate = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = origCreate?.apply(this, arguments);
      const keyWidget = this.widgets?.find(w => w.name === "api_key");
      if (keyWidget) keyWidget.label = "api_key (Leave blank for secure loading)";
      if (!this.inputs?.some(s => isImage(s.name))) {
        this.addInput("image", "IMAGE");
      }
      return result;
    };

    const originalConnectionChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (slotType, slotIndex, connected, link, slot) {
      const result = originalConnectionChange?.apply(this, arguments);
      if (slotType !== 1 || this._nanogptRebuildingImages) return result;
      const modifiedSlot = slot || this.inputs?.[slotIndex];
      if (!modifiedSlot || !isImage(modifiedSlot.name)) return result;
      this._nanogptRebuildingImages = true;
      try {
        // Connected images are sequentially numbered image_1, image_2, etc.
        let count = 0;
        for (const input of this.inputs || []) {
          if (isImage(input.name) && input.link != null) {
            input.name = `image_${++count}`;
            input.type = "IMAGE";
          }
        }
        // Remove old unconnected slots; add one empty slot if room is available.
        for (let i = (this.inputs?.length || 0) - 1; i >= 0; i--) {
          if (isImage(this.inputs[i].name) && this.inputs[i].link == null) {
            this.removeInput(i);
          }
        }
        if (count < MAX_IMAGES) {
          this.addInput("image", "IMAGE");
          const empty = this.inputs[this.inputs.length - 1];
          if (empty) empty.color_off = "#666666";
        }
        this.setSize?.([Math.max(this.size[0], 330), this.computeSize?.()[1] ?? this.size[1]]);
        this.graph?.setDirtyCanvas?.(true, true);
      } finally {
        this._nanogptRebuildingImages = false;
      }
      return result;
    };
  },
});
