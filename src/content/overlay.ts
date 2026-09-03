// Draws the finished verdict over its image: an animated glowing edge tracing
// the outside of the food.
//
// Everything is derived from the one PNG the worker sends — a cutout of the
// food's own pixels, transparent everywhere else — so its alpha channel is the
// food silhouette. From that we cache two stencils and paint three layers:
//
//   3. the glowing edge, strictly OUTSIDE the silhouette, tinted by a gradient
//      that travels across the image
//   2. the food cutout itself
//   1. a flat white fill in the shape of the food, underneath the cutout
//
// Layer 1 is invisible today — the opaque cutout covers it exactly — and exists
// for the dissolve animation that will fade layer 2 away and reveal it.
//
// The layers are composited in one pass with no scratch canvas: the edge is
// painted first and tinted through `source-in`, then the lower layers are slid
// underneath it with `destination-over`.
//
// The same layer also carries the EAT button (./eat.ts), which is the only part
// of an overlay that takes pointer input.

import { AnchoredLayer, mountAnchorRoot, scheduleReposition } from './anchor';
import { EatButton } from './eat';
import { addFrameTask, removeFrameTask, type FrameTask } from './loop';

const EDGE_PX = 2.5; // crisp band hugging the silhouette, in CSS px
const EDGE_DIRS = 16; // directions the silhouette is nudged in to build that band
const GLOW_PX = 4; // soft falloff outside the band
const GLOW_PASSES = 2; // redraws of the blurred copy; more = denser glow

const CYCLE_MS = 2600; // one full revolution of the gradient
const BANDS = 2; // colour cycles spaced around the wheel
const GRADIENT_STOPS = 24; // sampling resolution of the spinning gradient

// The edge palette, cycled through in order and wrapped. Blue is rare in food,
// so the edge stays legible against whatever it is tracing.
const PALETTE: [number, number, number][] = [
  [8, 185, 255], // sky
  [0, 58, 232], // deep
];

const MAX_EDGE = 2048; // cap the backing store on very large images

// Outlines animate only while their image is on screen. Without this, every food
// image on a long page would repaint forever, however far it has scrolled away.
const byTarget = new WeakMap<Element, Outline>();
const visibilityIO = new IntersectionObserver(
  (entries) => {
    for (const e of entries) byTarget.get(e.target)?.setVisible(e.isIntersecting);
  },
  { rootMargin: '150px' },
);

function mix(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** The palette as a continuous, wrapping colour ramp. */
function colourAt(u: number): string {
  const n = PALETTE.length;
  const x = (((u % 1) + 1) % 1) * n;
  const i = Math.floor(x);
  const f = x - i;
  const a = PALETTE[i % n];
  const b = PALETTE[(i + 1) % n];
  return `rgb(${mix(a[0], b[0], f)}, ${mix(a[1], b[1], f)}, ${mix(a[2], b[2], f)})`;
}

class Outline {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private layer: AnchoredLayer;
  private target: HTMLImageElement;
  private task: FrameTask;
  private eat: EatButton;

  private food: HTMLImageElement | null = null; // the decoded cutout
  private silhouette: HTMLCanvasElement | null = null; // white fill, layer 1
  private ring: HTMLCanvasElement | null = null; // edge stencil, layer 3

  private cssW = 0;
  private cssH = 0;
  private scale = 1; // device px per CSS px, after the MAX_EDGE cap
  private dpr = 0;
  private running = false;
  private destroyed = false;
  private phase = performance.now();

  constructor(
    target: HTMLImageElement,
    pngDataUrl: string,
    onDetach: () => void,
    onEat: () => void,
  ) {
    this.target = target;
    this.task = (now) => this.draw(now);

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'display:block;width:100%;height:100%;margin:0;padding:0;border:0;background:transparent';
    this.ctx = this.canvas.getContext('2d');

    // Created last: it calls back into resize() during construction.
    this.layer = new AnchoredLayer(target, {
      onDetach: () => {
        this.destroy();
        onDetach();
      },
      onResize: (w, h) => this.resize(w, h),
    });
    this.layer.shadow.appendChild(this.canvas);
    this.eat = new EatButton(target, this.layer.shadow, onEat);

    byTarget.set(target, this);
    visibilityIO.observe(target);

    void this.load(pngDataUrl);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.setVisible(false);
    this.eat.destroy();
    visibilityIO.unobserve(this.target);
    if (byTarget.get(this.target) === this) byTarget.delete(this.target);
    this.layer.destroy();
  }

  /** True when `target` is the image this overlay is drawn over. */
  eats(target: HTMLImageElement | null): boolean {
    return target !== null && target === this.target;
  }

  /** Latch this overlay's button on while its food is the one being eaten. */
  setEating(eating: boolean) {
    this.eat.setEating(eating);
  }

  /** Called by the shared IntersectionObserver. */
  setVisible(visible: boolean) {
    const want = visible && !this.destroyed;
    if (want === this.running) return;
    this.running = want;
    if (want) addFrameTask(this.task);
    else removeFrameTask(this.task);
  }

  private async load(pngDataUrl: string) {
    const img = new Image();
    img.decoding = 'async';
    img.src = pngDataUrl;
    try {
      await img.decode();
    } catch {
      return; // a cutout we cannot decode simply renders nothing
    }
    if (this.destroyed) return;
    this.food = img;
    this.buildStencils();
  }

  private resize(cssW: number, cssH: number) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = window.devicePixelRatio || 1;
    const longest = Math.max(cssW, cssH);
    this.scale = longest * this.dpr > MAX_EDGE ? MAX_EDGE / longest : this.dpr;

    const w = Math.max(1, Math.round(cssW * this.scale));
    const h = Math.max(1, Math.round(cssH * this.scale));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.buildStencils(); // stencils are sized to the backing store
  }

  // Both stencils are rebuilt only on load and on resize — the per-frame work is
  // three drawImages and a gradient fill.
  private buildStencils() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!this.food || w <= 1 || h <= 1) return;

    // Layer 1: the cutout's alpha, flooded with white.
    const sil = document.createElement('canvas');
    sil.width = w;
    sil.height = h;
    const sctx = sil.getContext('2d');
    if (!sctx) return;
    sctx.drawImage(this.food, 0, 0, w, h);
    sctx.globalCompositeOperation = 'source-in';
    sctx.fillStyle = '#fff';
    sctx.fillRect(0, 0, w, h);
    this.silhouette = sil;

    // Layer 3: the silhouette grown outward, with the silhouette itself punched
    // back out — so the edge sits strictly outside the food, never over it.
    const ring = document.createElement('canvas');
    ring.width = w;
    ring.height = h;
    const rctx = ring.getContext('2d');
    if (!rctx) return;

    // The soft outer falloff.
    rctx.filter = `blur(${GLOW_PX * this.scale}px)`;
    for (let i = 0; i < GLOW_PASSES; i++) rctx.drawImage(sil, 0, 0);
    rctx.filter = 'none';

    // The crisp band: copies of the silhouette nudged out in a ring of
    // directions, which unions into an even dilation of its border.
    const edge = EDGE_PX * this.scale;
    for (let i = 0; i < EDGE_DIRS; i++) {
      const a = (2 * Math.PI * i) / EDGE_DIRS;
      rctx.drawImage(sil, Math.cos(a) * edge, Math.sin(a) * edge);
    }

    rctx.globalCompositeOperation = 'destination-out';
    rctx.drawImage(sil, 0, 0);
    this.ring = ring;
  }

  private draw(now: number) {
    const ctx = this.ctx;
    if (!ctx || !this.food || !this.silhouette || !this.ring) return;

    // Page zoom changes devicePixelRatio without necessarily changing our CSS
    // box, so re-derive the backing store when it drifts.
    if (this.dpr !== (window.devicePixelRatio || 1)) this.resize(this.cssW, this.cssH);

    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // 3. the edge stencil, tinted by the travelling gradient
    ctx.drawImage(this.ring, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = this.gradient(ctx, now, w, h);
    ctx.fillRect(0, 0, w, h);

    // 2 and 1: slid underneath, in that order
    ctx.globalCompositeOperation = 'destination-over';
    ctx.drawImage(this.food, 0, 0, w, h);
    ctx.drawImage(this.silhouette, 0, 0);

    ctx.globalCompositeOperation = 'source-over';
  }

  // A conic ramp centred on the image, turned a little further each frame: the
  // colour sweeps around the outline like a spinning wheel. Whole-number BANDS
  // keeps the ramp continuous where it meets itself at the start angle.
  private gradient(
    ctx: CanvasRenderingContext2D,
    now: number,
    w: number,
    h: number,
  ): CanvasGradient {
    const turn = (((now - this.phase) % CYCLE_MS) / CYCLE_MS) * 2 * Math.PI;
    const g = ctx.createConicGradient(turn, w / 2, h / 2);
    for (let i = 0; i <= GRADIENT_STOPS; i++) {
      const t = i / GRADIENT_STOPS;
      g.addColorStop(t, colourAt(t * BANDS));
    }
    return g;
  }
}

export class OverlayManager {
  private outlines = new Map<string, Outline>();

  mount() {
    mountAnchorRoot();
  }

  has(imgId: string): boolean {
    return this.outlines.has(imgId);
  }

  /** Recompute every overlay's box. Cheap, and safe to call at any time. */
  refresh() {
    scheduleReposition();
  }

  show(
    imgId: string,
    target: HTMLImageElement,
    pngDataUrl: string,
    onEat: (target: HTMLImageElement) => void,
  ) {
    this.remove(imgId);

    const outline = new Outline(
      target,
      pngDataUrl,
      () => {
        if (this.outlines.get(imgId) === outline) this.outlines.delete(imgId);
      },
      () => onEat(target),
    );
    this.outlines.set(imgId, outline);
  }

  /** Exactly one overlay at a time wears the "being eaten" state. */
  markEating(target: HTMLImageElement | null) {
    for (const outline of this.outlines.values()) outline.setEating(outline.eats(target));
  }

  remove(imgId: string) {
    this.outlines.get(imgId)?.destroy();
    this.outlines.delete(imgId);
  }

  clear() {
    for (const id of [...this.outlines.keys()]) this.remove(id);
  }
}
