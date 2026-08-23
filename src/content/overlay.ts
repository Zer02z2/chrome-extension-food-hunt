// Positions finished mask overlays over their target images.
//
// Each mask is an absolutely positioned element inserted INTO the image's own
// containing block, offset by the image's distance from that block's padding
// edge. Once placed it is part of the page's layout, so scrolling, sticky
// headers, transformed ancestors, and clipping containers all move and clip it
// together with the image, with zero JavaScript per frame. We only recompute
// when something actually resizes.
//
// The mask itself lives in a closed shadow root so page CSS (`.card img {...}`,
// `!important` and all) cannot restyle it, and every layout-critical property on
// the host is set with `important` priority for the same reason.

type Anchor =
  | { mode: 'element'; host: HTMLElement } // inside the image's containing block
  | { mode: 'document' }; // no containing block anywhere: page coordinates

type OverlayEntry = {
  target: HTMLImageElement;
  host: HTMLDivElement; // the element we insert into the page
  anchor: Anchor;
  ro: ResizeObserver;
};

const LAYER_Z = '2147483646'; // one below the HUD

// Properties that decide where the overlay lands. Page rules must not win.
const BASE_STYLE: Record<string, string> = {
  position: 'absolute',
  display: 'block',
  overflow: 'hidden',
  margin: '0',
  padding: '0',
  border: '0',
  'max-width': 'none',
  'max-height': 'none',
  'min-width': '0',
  'min-height': '0',
  transform: 'none',
  float: 'none',
  'clip-path': 'none',
  filter: 'none',
  opacity: '1',
  'pointer-events': 'none',
  'z-index': LAYER_Z,
};

function applyImportant(el: HTMLElement, styles: Record<string, string>) {
  for (const [prop, value] of Object.entries(styles)) {
    el.style.setProperty(prop, value, 'important');
  }
}

function num(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

// True when `el` is a containing block for absolutely positioned descendants.
// Being positioned is the usual reason; transform/filter/contain and friends do
// it too, and missing those would leave the overlay behind on hover-zoom cards.
function establishesContainingBlock(cs: CSSStyleDeclaration): boolean {
  if (cs.position !== 'static') return true;
  if (cs.transform !== 'none') return true;
  if (cs.perspective !== 'none') return true;
  if (cs.filter !== 'none') return true;
  if (cs.backdropFilter && cs.backdropFilter !== 'none') return true;
  if (/\b(transform|filter|perspective)\b/.test(cs.willChange)) return true;
  if (/\b(layout|paint|strict|content)\b/.test(cs.contain)) return true;
  return false;
}

// Walk up from the image to the block its `position:absolute` coordinates would
// resolve against. Null means there is none, i.e. the initial containing block —
// the document — which we handle separately.
function findContainingBlock(target: HTMLElement): HTMLElement | null {
  for (let el = target.parentElement; el; el = el.parentElement) {
    if (establishesContainingBlock(getComputedStyle(el))) return el;
  }
  return null;
}

export class OverlayManager {
  // Mount point for images with no positioned ancestor. Absolute at the origin
  // of the initial containing block, so its children take plain page coords.
  private docLayer: HTMLDivElement;
  private entries = new Map<string, OverlayEntry>();
  private rafPending = false;
  private pageRo: ResizeObserver;

  constructor() {
    this.docLayer = document.createElement('div');
    this.docLayer.id = 'foodmask-overlay-layer';
    applyImportant(this.docLayer, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      margin: '0',
      padding: '0',
      border: '0',
      'pointer-events': 'none',
      'z-index': LAYER_Z,
    });

    // Reflows that move an image without resizing it or its host still change
    // the document's own size in almost every case, so one observer on the root
    // is a cheap net for the layout shifts the per-entry observers miss.
    this.pageRo = new ResizeObserver(() => this.scheduleReposition());
    window.addEventListener('resize', () => this.scheduleReposition(), { passive: true });
  }

  mount() {
    if (!this.docLayer.isConnected) {
      (document.body ?? document.documentElement).appendChild(this.docLayer);
      this.pageRo.observe(document.documentElement);
    }
  }

  has(imgId: string): boolean {
    return this.entries.has(imgId);
  }

  /** Recompute every overlay's box. Cheap, and safe to call at any time. */
  refresh() {
    this.scheduleReposition();
  }

  show(imgId: string, target: HTMLImageElement, pngDataUrl: string) {
    this.remove(imgId);
    this.mount();

    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    applyImportant(host, BASE_STYLE);

    // Closed shadow root: the page cannot select, restyle, or read the mask.
    const shadow = host.attachShadow({ mode: 'closed' });
    const img = document.createElement('img');
    img.decoding = 'async';
    img.draggable = false;
    img.src = pngDataUrl;
    img.style.cssText =
      'display:block;width:100%;height:100%;object-fit:fill;margin:0;padding:0;border:0';
    shadow.appendChild(img);

    const anchor = this.anchorFor(target);
    this.attach(host, anchor);

    // Re-align when the image or its containing block changes size. Neither
    // fires on scroll, which is the whole point of anchoring in the first place.
    const ro = new ResizeObserver(() => this.scheduleReposition());
    ro.observe(target);
    if (anchor.mode === 'element') ro.observe(anchor.host);

    this.entries.set(imgId, { target, host, anchor, ro });
    this.position(imgId);
  }

  remove(imgId: string) {
    const entry = this.entries.get(imgId);
    if (!entry) return;
    entry.ro.disconnect();
    entry.host.remove();
    this.entries.delete(imgId);
  }

  clear() {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  private anchorFor(target: HTMLImageElement): Anchor {
    const block = findContainingBlock(target);
    return block ? { mode: 'element', host: block } : { mode: 'document' };
  }

  private attach(host: HTMLDivElement, anchor: Anchor) {
    if (anchor.mode === 'element') anchor.host.appendChild(host);
    else this.docLayer.appendChild(host);
  }

  private scheduleReposition() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      for (const id of [...this.entries.keys()]) this.position(id);
    });
  }

  private position(imgId: string) {
    const entry = this.entries.get(imgId);
    if (!entry) return;
    const { target, host } = entry;

    if (!target.isConnected) {
      this.remove(imgId); // target gone from the DOM
      return;
    }

    // The image may have been moved into a different subtree (SPA re-parenting),
    // so re-anchor before measuring if our block no longer contains it.
    if (entry.anchor.mode === 'element' && !entry.anchor.host.contains(target)) {
      entry.ro.disconnect();
      entry.anchor = this.anchorFor(target);
      host.remove();
      entry.ro.observe(target);
      if (entry.anchor.mode === 'element') entry.ro.observe(entry.anchor.host);
    }
    if (!host.isConnected) this.attach(host, entry.anchor);

    const r = target.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      host.style.setProperty('display', 'none', 'important'); // hidden or degenerate
      return;
    }

    let left: number;
    let top: number;
    let width = r.width;
    let height = r.height;

    if (entry.anchor.mode === 'element') {
      const block = entry.anchor.host;
      const br = block.getBoundingClientRect();
      const cs = getComputedStyle(block);

      // Rects are post-transform; absolute offsets are layout px. When the block
      // itself is scaled, the overlay scales with it, so divide the visual delta
      // back down into layout units.
      const ratio = block.offsetWidth > 0 ? br.width / block.offsetWidth : 1;
      const k = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;

      // Absolute coordinates start at the padding edge and live in the scrolled
      // content, hence the border subtraction and the scroll offsets.
      left = (r.left - br.left) / k - num(cs.borderLeftWidth) + block.scrollLeft;
      top = (r.top - br.top) / k - num(cs.borderTopWidth) + block.scrollTop;
      width = r.width / k;
      height = r.height / k;
    } else {
      // Initial containing block: page coordinates.
      left = r.left + window.scrollX;
      top = r.top + window.scrollY;
    }

    applyImportant(host, {
      display: 'block',
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  }
}
