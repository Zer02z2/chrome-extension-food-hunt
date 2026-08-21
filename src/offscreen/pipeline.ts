// The offscreen compute pipeline: fetch -> classify -> segment -> composite.
// Models load once and stay warm. A small concurrency gate keeps heavy pages
// from firing dozens of simultaneous inferences, and a URL cache skips repeats.

import { FoodModel, buildFoodMaskCanvas, classLabel } from './model';
import { compositeOverlay } from './composite';
import { loadSettings, PIPELINE, type Settings } from '../shared/config';
import type { MaskResult, OffscreenJob } from '../shared/messages';

type CacheEntry = { isFood: boolean; overlayPngDataUrl?: string };

const CANCELLED = Symbol('cancelled');
type Waiter = { id: string; start: () => void; cancel: () => void };

export class Pipeline {
  private model = new FoodModel();
  private ready: Promise<void> | null = null;
  private settings: Settings = { enabled: true, blurPx: 16 };
  private active = 0;
  private waiters: Waiter[] = [];
  private cancelled = new Set<string>();
  private cache = new Map<string, CacheEntry>();

  get provider() {
    return this.model.provider;
  }

  async init() {
    this.settings = await loadSettings();
    await this.ensureModel();
  }

  updateSettings(next: Settings) {
    const blurChanged = next.blurPx !== this.settings.blurPx;
    this.settings = next;
    // Overlays bake in the blur radius, so a blur change invalidates cached ones.
    if (blurChanged) this.cache.clear();
  }

  private ensureModel(): Promise<void> {
    if (!this.ready) this.ready = this.model.load();
    return this.ready;
  }

  // Drop a job that is still queued. In-flight inference can't be aborted, but
  // its result will be discarded by the (now absent) target on the page.
  cancel(requestId: string) {
    this.cancelled.add(requestId);
    const i = this.waiters.findIndex((w) => w.id === requestId);
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      w.cancel();
    }
  }

  async process(job: OffscreenJob): Promise<MaskResult> {
    const cached = this.cache.get(job.imageUrl);
    if (cached) {
      return { type: 'MASK_RESULT', ...idOf(job), ...cached };
    }

    try {
      await this.acquire(job.requestId);
    } catch {
      return cancelledResult(job);
    }

    const t0 = performance.now();
    try {
      await this.ensureModel();

      const bitmap = await urlToBitmap(job.imageUrl);
      const tFetch = performance.now();

      if (this.cancelled.has(job.requestId)) {
        bitmap.close();
        return cancelledResult(job);
      }

      const result = await this.model.analyze(bitmap);
      const tInfer = performance.now();

      if (!result.isFood) {
        bitmap.close();
        const entry: CacheEntry = { isFood: false };
        this.cache.set(job.imageUrl, entry);
        this.logTimings(job, t0, tFetch, tInfer, tInfer, false, []);
        return { type: 'MASK_RESULT', ...idOf(job), ...entry };
      }

      const maskCanvas = buildFoodMaskCanvas(result.detections, result.protos, result.letterbox);
      let overlay: string | undefined;
      if (maskCanvas) {
        overlay = await compositeOverlay(bitmap, maskCanvas, this.settings.blurPx);
      }
      const tComposite = performance.now();
      bitmap.close();

      const labels = result.detections.map((d) => classLabel(d.classId));
      this.logTimings(job, t0, tFetch, tInfer, tComposite, true, labels);

      const entry: CacheEntry = { isFood: true, overlayPngDataUrl: overlay };
      this.cache.set(job.imageUrl, entry);
      return { type: 'MASK_RESULT', ...idOf(job), ...entry };
    } catch (err) {
      return {
        type: 'MASK_RESULT',
        ...idOf(job),
        isFood: false,
        error: String((err as Error)?.message ?? err),
      };
    } finally {
      this.cancelled.delete(job.requestId);
      this.release();
    }
  }

  private acquire(id: string): Promise<void> {
    if (this.cancelled.has(id)) return Promise.reject(CANCELLED);
    if (this.active < PIPELINE.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({
        id,
        start: () => {
          this.active++;
          resolve();
        },
        cancel: () => reject(CANCELLED),
      });
    });
  }

  private release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next.start();
  }

  private logTimings(
    job: OffscreenJob,
    t0: number,
    tFetch: number,
    tInfer: number,
    tComposite: number,
    isFood: boolean,
    labels: string[],
  ) {
    const ms = (a: number, b: number) => `${(b - a).toFixed(0)}ms`;
    console.log(
      `[foodmask][offscreen] ${job.imgId.slice(0, 6)} ${isFood ? `FOOD[${labels.join(',')}]` : 'not-food'} ` +
        `fetch=${ms(t0, tFetch)} infer=${ms(tFetch, tInfer)} composite=${ms(tInfer, tComposite)} ` +
        `total=${ms(t0, tComposite)}`,
    );
  }
}

function idOf(job: OffscreenJob) {
  return { requestId: job.requestId, imgId: job.imgId };
}

function cancelledResult(job: OffscreenJob): MaskResult {
  return { type: 'MASK_RESULT', ...idOf(job), isFood: false, error: 'cancelled' };
}

// Fetch inside the offscreen document so extension host_permissions grant
// cross-origin access — the resulting ImageBitmap is not tainted.
async function urlToBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const blob = await res.blob();
  return createImageBitmap(blob);
}
