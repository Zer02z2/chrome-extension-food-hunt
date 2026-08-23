// Positions finished mask overlays over their target images.
//
// Each mask is a PNG painted into an AnchoredLayer, so it tracks the image
// through scrolling, reflows and re-parenting without per-frame work. See
// ./anchor for how the placement itself is done.

import { AnchoredLayer, mountAnchorRoot, scheduleReposition } from './anchor';

export class OverlayManager {
  private layers = new Map<string, AnchoredLayer>();

  mount() {
    mountAnchorRoot();
  }

  has(imgId: string): boolean {
    return this.layers.has(imgId);
  }

  /** Recompute every overlay's box. Cheap, and safe to call at any time. */
  refresh() {
    scheduleReposition();
  }

  show(imgId: string, target: HTMLImageElement, pngDataUrl: string) {
    this.remove(imgId);

    const layer = new AnchoredLayer(target, {
      onDetach: () => this.layers.delete(imgId),
    });

    const img = document.createElement('img');
    img.decoding = 'async';
    img.draggable = false;
    img.src = pngDataUrl;
    img.style.cssText =
      'display:block;width:100%;height:100%;object-fit:fill;margin:0;padding:0;border:0';
    layer.shadow.appendChild(img);

    this.layers.set(imgId, layer);
  }

  remove(imgId: string) {
    this.layers.get(imgId)?.destroy();
    this.layers.delete(imgId);
  }

  clear() {
    for (const id of [...this.layers.keys()]) this.remove(id);
  }
}
