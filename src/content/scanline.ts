// The "scanning" affordance: a blue vertical line sweeping left-to-right across
// an image while its verdict is still in flight.
//
// It is a transparent <canvas> pinned over the image with the same AnchoredLayer
// the finished outline uses, so it lands in the image's containing block and
// tracks it through scrolls and reflows. The manager only mounts and unmounts;
// the frames come from the page-wide loop in ./loop.

import { AnchoredLayer } from './anchor';
import { addFrameTask, removeFrameTask, type FrameTask } from './loop';

const SWEEP_MS = 1150; // one full left-to-right pass
const GAP_MS = 260; // dark beat before the next pass, so passes read as distinct
const CYCLE_MS = SWEEP_MS + GAP_MS;

const EDGE_FADE = 0.14; // fraction of the sweep spent fading in / out at the ends
const TRAIL_RATIO = 0.3; // motion trail length, as a fraction of image width
const MAX_TRAIL_PX = 160; // ...but never longer than this, in CSS px
const HALO_PX = 14; // soft glow either side of the line
const CORE_PX = 1.75; // the bright line itself

const TINT = '86, 164, 255'; // scanner blue
const CORE = '214, 234, 255'; // near-white core, so the line reads on any image

const MAX_EDGE = 2048; // cap the backing store on very large images

class Scanner {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private layer: AnchoredLayer;
  private task: FrameTask;
  private startedAt = performance.now();

  private cssW = 0;
  private cssH = 0;
  private scale = 1; // device px per CSS px, after the MAX_EDGE cap
  private dpr = 0;

  constructor(target: HTMLImageElement, onDetach: () => void) {
    this.task = (now) => this.draw(now);
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'display:block;width:100%;height:100%;margin:0;padding:0;border:0;background:transparent';
    this.ctx = this.canvas.getContext('2d');

    // Created last: it calls back into resize() during construction.
    this.layer = new AnchoredLayer(target, {
      onDetach,
      onResize: (w, h) => this.resize(w, h),
    });
    this.layer.shadow.appendChild(this.canvas);
    addFrameTask(this.task);
  }

  destroy() {
    removeFrameTask(this.task);
    this.layer.destroy();
  }

  private resize(cssW: number, cssH: number) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = window.devicePixelRatio || 1;

    const longest = Math.max(cssW, cssH) * this.dpr;
    this.scale = longest > MAX_EDGE ? MAX_EDGE / Math.max(cssW, cssH) : this.dpr;

    const w = Math.max(1, Math.round(cssW * this.scale));
    const h = Math.max(1, Math.round(cssH * this.scale));
    if (this.canvas.width !== w) this.canvas.width = w; // assignment clears the canvas
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  private draw(now: number) {
    const ctx = this.ctx;
    if (!ctx) return;

    // Page zoom changes devicePixelRatio without necessarily changing our CSS
    // box, so re-derive the backing store when it drifts.
    if (this.dpr !== (window.devicePixelRatio || 1)) this.resize(this.cssW, this.cssH);

    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const t = (now - this.startedAt) % CYCLE_MS;
    if (t > SWEEP_MS) return; // the beat between passes: nothing drawn

    const p = t / SWEEP_MS;
    // Ease in and out so the line settles at the edges instead of snapping.
    const x = (0.5 - 0.5 * Math.cos(Math.PI * p)) * w;
    const alpha = Math.max(0, Math.min(1, p / EDGE_FADE, (1 - p) / EDGE_FADE));
    const trail = Math.min(w * TRAIL_RATIO, MAX_TRAIL_PX * this.scale);

    ctx.save();
    ctx.globalAlpha = alpha;

    // The trail: a wedge of tint dragged behind the line, brightest at the line.
    if (trail > 0) {
      const grad = ctx.createLinearGradient(x - trail, 0, x, 0);
      grad.addColorStop(0, `rgba(${TINT}, 0)`);
      grad.addColorStop(0.65, `rgba(${TINT}, 0.1)`);
      grad.addColorStop(1, `rgba(${TINT}, 0.32)`);
      ctx.fillStyle = grad;
      ctx.fillRect(x - trail, 0, trail, h);
    }

    // A symmetric halo, so the head of the line glows rather than cuts.
    const halo = HALO_PX * this.scale;
    const glow = ctx.createLinearGradient(x - halo, 0, x + halo, 0);
    glow.addColorStop(0, `rgba(${TINT}, 0)`);
    glow.addColorStop(0.5, `rgba(${TINT}, 0.45)`);
    glow.addColorStop(1, `rgba(${TINT}, 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(x - halo, 0, halo * 2, h);

    // The line itself.
    const core = Math.max(1, CORE_PX * this.scale);
    ctx.shadowColor = `rgba(${TINT}, 0.9)`;
    ctx.shadowBlur = halo;
    ctx.fillStyle = `rgba(${CORE}, 0.92)`;
    ctx.fillRect(x - core / 2, 0, core, h);

    ctx.restore();
  }
}

/** Mounts and unmounts scan animations, keyed by imgId. */
export class ScanlineManager {
  private scanners = new Map<string, Scanner>();

  /** Begin animating over `target`. A second call for the same id is a no-op. */
  start(imgId: string, target: HTMLImageElement) {
    if (this.scanners.has(imgId)) return;

    const scanner = new Scanner(target, () => {
      // The image left the DOM; the layer already tore itself down.
      if (this.scanners.get(imgId) === scanner) this.stop(imgId);
    });

    this.scanners.set(imgId, scanner);
  }

  /** Stop and remove the animation for `imgId`, if any. */
  stop(imgId: string) {
    const scanner = this.scanners.get(imgId);
    if (!scanner) return;
    this.scanners.delete(imgId);
    scanner.destroy();
  }

  clear() {
    for (const imgId of [...this.scanners.keys()]) this.stop(imgId);
  }
}
