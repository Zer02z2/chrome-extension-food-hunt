// Finds candidate <img> elements lazily and cheaply:
//   - MutationObserver catches dynamically added / src-changed images (SPAs, infinite scroll)
//   - IntersectionObserver defers work until an image is actually visible
//   - filters out icons, sprites, and non-http(s) sources before emitting
//
// Every qualifying image is stamped with a stable id (data-foodmask-id) and
// reported exactly once via onDiscovered. Src changes re-arm an element.

import { DISCOVERY } from '../shared/config';

export type DiscoveredImage = {
  el: HTMLImageElement;
  imgId: string;
  imageUrl: string;
};

export type DiscoveryCallbacks = {
  onDiscovered: (img: DiscoveredImage) => void;
  onReset?: (imgId: string, el: HTMLImageElement) => void;
};

const ID_ATTR = 'foodmaskId'; // dataset key -> data-foodmask-id

export class ImageDiscovery {
  private io: IntersectionObserver;
  private mo: MutationObserver;
  private cb: DiscoveryCallbacks;
  private processed = new Set<string>();
  private started = false;

  constructor(cb: DiscoveryCallbacks) {
    this.cb = cb;
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), {
      rootMargin: '200px', // start a little before the image scrolls in
      threshold: 0.01,
    });
    this.mo = new MutationObserver((records) => this.onMutations(records));
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.scanExisting(document.documentElement);
    this.mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset'],
    });
  }

  stop() {
    this.io.disconnect();
    this.mo.disconnect();
    this.started = false;
  }

  // Forget every verdict already reached on this page and consider all images
  // again. Used when the active model changes: the previous model's answers are
  // no longer the ones the user asked for.
  rescan() {
    this.processed.clear();
    document.querySelectorAll<HTMLImageElement>('img[data-foodmask-id]').forEach((el) => {
      delete el.dataset[ID_ATTR];
    });
    if (this.started) this.scanExisting(document.documentElement);
  }

  private scanExisting(root: ParentNode) {
    root.querySelectorAll('img').forEach((img) => this.arm(img));
  }

  private arm(el: HTMLImageElement) {
    // (Re)observe an element for visibility. Idempotent per element.
    this.io.observe(el);
  }

  private onMutations(records: MutationRecord[]) {
    for (const r of records) {
      if (r.type === 'childList') {
        r.addedNodes.forEach((n) => {
          if (n instanceof HTMLImageElement) this.arm(n);
          else if (n instanceof Element) this.scanExisting(n);
        });
      } else if (r.type === 'attributes' && r.target instanceof HTMLImageElement) {
        this.handleSrcChange(r.target);
      }
    }
  }

  private handleSrcChange(el: HTMLImageElement) {
    const existing = el.dataset[ID_ATTR];
    if (existing) {
      // The element now shows different content — retire the old id and re-arm.
      this.processed.delete(existing);
      delete el.dataset[ID_ATTR];
      this.cb.onReset?.(existing, el);
    }
    this.arm(el);
  }

  private onIntersect(entries: IntersectionObserverEntry[]) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      this.consider(e.target as HTMLImageElement);
    }
  }

  private consider(el: HTMLImageElement) {
    if (el.dataset[ID_ATTR] && this.processed.has(el.dataset[ID_ATTR]!)) {
      this.io.unobserve(el);
      return;
    }

    const url = el.currentSrc || el.src;
    if (!url || !/^https?:/i.test(url)) {
      // MVP handles http(s) <img> sources only; data:/blob:/background-image deferred.
      this.io.unobserve(el);
      return;
    }

    // Need real dimensions before we can size-filter.
    if (!el.complete || el.naturalWidth === 0) {
      el.addEventListener('load', () => this.consider(el), { once: true });
      el.addEventListener('error', () => this.io.unobserve(el), { once: true });
      return;
    }

    const rect = el.getBoundingClientRect();
    const w = Math.max(el.naturalWidth, rect.width);
    const h = Math.max(el.naturalHeight, rect.height);
    if (w < DISCOVERY.minWidth || h < DISCOVERY.minHeight) {
      this.io.unobserve(el); // too small — icon/sprite/spacer
      return;
    }

    const imgId = crypto.randomUUID();
    el.dataset[ID_ATTR] = imgId;
    this.processed.add(imgId);
    this.io.unobserve(el);

    this.cb.onDiscovered({ el, imgId, imageUrl: url });
  }
}
