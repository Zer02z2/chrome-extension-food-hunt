// Positions finished mask overlays over their target images and keeps them
// aligned through scroll, resize, and layout shifts. Overlays live in one fixed,
// click-through layer; each is sized to its target's viewport rect.

type OverlayEntry = {
  target: HTMLImageElement;
  el: HTMLImageElement;
  ro: ResizeObserver;
};

const LAYER_Z = 2147483646; // one below the HUD

export class OverlayManager {
  private layer: HTMLDivElement;
  private entries = new Map<string, OverlayEntry>();
  private rafPending = false;

  constructor() {
    this.layer = document.createElement('div');
    this.layer.id = 'foodmask-overlay-layer';
    this.layer.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'width:0',
      'height:0',
      'margin:0',
      'padding:0',
      'border:0',
      'pointer-events:none',
      `z-index:${LAYER_Z}`,
    ].join(';');

    const onViewportChange = () => this.scheduleReposition();
    window.addEventListener('scroll', onViewportChange, { passive: true, capture: true });
    window.addEventListener('resize', onViewportChange, { passive: true });
  }

  mount() {
    if (!this.layer.isConnected) {
      (document.body ?? document.documentElement).appendChild(this.layer);
    }
  }

  has(imgId: string): boolean {
    return this.entries.has(imgId);
  }

  show(imgId: string, target: HTMLImageElement, pngDataUrl: string) {
    this.remove(imgId);
    this.mount();

    const el = document.createElement('img');
    el.decoding = 'async';
    el.src = pngDataUrl;
    el.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'display:block',
      'margin:0',
      'padding:0',
      'border:0',
      'max-width:none',
      'max-height:none',
      'object-fit:fill',
      'will-change:transform',
    ].join(';');

    // Re-align whenever the target itself changes size.
    const ro = new ResizeObserver(() => this.scheduleReposition());
    ro.observe(target);

    this.layer.appendChild(el);
    this.entries.set(imgId, { target, el, ro });
    this.position(imgId);
  }

  remove(imgId: string) {
    const entry = this.entries.get(imgId);
    if (!entry) return;
    entry.ro.disconnect();
    entry.el.remove();
    this.entries.delete(imgId);
  }

  clear() {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  private scheduleReposition() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.repositionAll();
    });
  }

  private repositionAll() {
    for (const id of this.entries.keys()) this.position(id);
  }

  private position(imgId: string) {
    const entry = this.entries.get(imgId);
    if (!entry) return;
    const { target, el } = entry;

    if (!target.isConnected) {
      this.remove(imgId); // target gone from the DOM
      return;
    }

    const r = target.getBoundingClientRect();
    // Hide degenerate / fully off-screen targets rather than parking them.
    const visible =
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < window.innerHeight &&
      r.left < window.innerWidth;

    if (!visible) {
      el.style.display = 'none';
      return;
    }

    el.style.display = 'block';
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top}px`;
    el.style.width = `${r.width}px`;
    el.style.height = `${r.height}px`;
  }
}
