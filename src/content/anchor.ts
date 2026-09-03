// Shared machinery for pinning an element onto an image.
//
// An anchored layer is an absolutely positioned element inserted INTO the
// image's own containing block, offset by the image's distance from that block's
// padding edge. Once placed it is part of the page's layout, so scrolling,
// sticky headers, transformed ancestors, and clipping containers all move and
// clip it together with the image, with zero JavaScript per frame. We only
// recompute when something actually resizes.
//
// The layer's content lives in a closed shadow root so page CSS
// (`.card img {...}`, `!important` and all) cannot restyle it, and every
// layout-critical property on the host is set with `important` priority for the
// same reason.

type Anchor =
  | { mode: 'element'; host: HTMLElement } // inside the image's containing block
  | { mode: 'document' }; // no containing block anywhere: page coordinates

// The stacking ladder, top down: HUD, then the food masks, then the head stage.
// The head sits directly under the masks so a food image always paints over the
// mouth reaching for it.
export const LAYER_Z = '2147483646'; // one below the HUD
export const HEAD_Z = '2147483645'; // one below the masks — see ./head.ts

// Properties that decide where a layer lands. Page rules must not win.
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

export function applyImportant(el: HTMLElement, styles: Record<string, string>) {
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
// it too, and missing those would leave the layer behind on hover-zoom cards.
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

function anchorFor(target: HTMLElement): Anchor {
  const block = findContainingBlock(target);
  return block ? { mode: 'element', host: block } : { mode: 'document' };
}

// --- page-level plumbing, shared by every layer ------------------------------

// Mount point for images with no positioned ancestor. Absolute at the origin of
// the initial containing block, so its children take plain page coords.
let docLayer: HTMLDivElement | null = null;
let pageRo: ResizeObserver | null = null;
const layers = new Set<AnchoredLayer>();
let rafPending = false;

/** Create the fallback layer and start watching the page for reflows. */
export function mountAnchorRoot(): HTMLDivElement {
  if (!docLayer) {
    docLayer = document.createElement('div');
    docLayer.id = 'foodmask-overlay-layer';
    applyImportant(docLayer, {
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
  }
  if (!docLayer.isConnected) {
    (document.body ?? document.documentElement).appendChild(docLayer);
  }
  if (!pageRo) {
    // Reflows that move an image without resizing it or its host still change
    // the document's own size in almost every case, so one observer on the root
    // is a cheap net for the layout shifts the per-layer observers miss.
    pageRo = new ResizeObserver(() => scheduleReposition());
    pageRo.observe(document.documentElement);
    window.addEventListener('resize', () => scheduleReposition(), { passive: true });
  }
  return docLayer;
}

/** Recompute every layer's box on the next frame. Safe to call at any time. */
export function scheduleReposition() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    for (const layer of [...layers]) layer.position();
  });
}

export type AnchoredLayerOptions = {
  /** The target left the DOM; the layer has already torn itself down. */
  onDetach?: () => void;
  /** The layer's CSS box changed size. Fires on the first placement too. */
  onResize?: (width: number, height: number) => void;
};

/** One element pinned to the box of one image. */
export class AnchoredLayer {
  readonly host: HTMLDivElement;
  readonly shadow: ShadowRoot;

  private target: HTMLElement;
  private anchor: Anchor;
  private ro: ResizeObserver;
  private opts: AnchoredLayerOptions;
  private width = -1;
  private height = -1;
  private destroyed = false;

  constructor(target: HTMLElement, opts: AnchoredLayerOptions = {}) {
    this.target = target;
    this.opts = opts;

    this.host = document.createElement('div');
    this.host.setAttribute('aria-hidden', 'true');
    applyImportant(this.host, BASE_STYLE);
    // Closed shadow root: the page cannot select, restyle, or read the content.
    this.shadow = this.host.attachShadow({ mode: 'closed' });

    mountAnchorRoot();
    this.anchor = anchorFor(target);
    this.attach();

    // Re-align when the image or its containing block changes size. Neither
    // fires on scroll, which is the whole point of anchoring in the first place.
    this.ro = new ResizeObserver(() => scheduleReposition());
    this.ro.observe(target);
    if (this.anchor.mode === 'element') this.ro.observe(this.anchor.host);

    layers.add(this);
    this.position();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    layers.delete(this);
    this.ro.disconnect();
    this.host.remove();
  }

  private attach() {
    if (this.anchor.mode === 'element') this.anchor.host.appendChild(this.host);
    else mountAnchorRoot().appendChild(this.host);
  }

  /** Recompute this layer's box against its target. Cheap; called per reflow. */
  position() {
    if (this.destroyed) return;
    const { target, host } = this;

    if (!target.isConnected) {
      this.destroy(); // target gone from the DOM
      this.opts.onDetach?.();
      return;
    }

    // The image may have been moved into a different subtree (SPA re-parenting),
    // so re-anchor before measuring if our block no longer contains it.
    if (this.anchor.mode === 'element' && !this.anchor.host.contains(target)) {
      this.ro.disconnect();
      this.anchor = anchorFor(target);
      host.remove();
      this.ro.observe(target);
      if (this.anchor.mode === 'element') this.ro.observe(this.anchor.host);
    }
    if (!host.isConnected) this.attach();

    const r = target.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      host.style.setProperty('display', 'none', 'important'); // hidden or degenerate
      return;
    }

    let left: number;
    let top: number;
    let width = r.width;
    let height = r.height;

    if (this.anchor.mode === 'element') {
      const block = this.anchor.host;
      const br = block.getBoundingClientRect();
      const cs = getComputedStyle(block);

      // Rects are post-transform; absolute offsets are layout px. When the block
      // itself is scaled, the layer scales with it, so divide the visual delta
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

    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.opts.onResize?.(width, height);
    }
  }
}
