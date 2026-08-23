// The offscreen compute pipeline: fetch -> classify -> mask -> composite.
//
// Exactly one step here is model-specific — `classifier.classify()`, which
// answers "is this food?". Everything around it is shared: the same masking,
// compositing, caching, concurrency gate, and MASK_RESULT shape serve every
// model. Switching models in the popup swaps that one call and nothing else.
//
// Classifier instances stay warm across jobs; a small concurrency gate keeps
// heavy pages from firing dozens of simultaneous inferences, and a URL cache
// skips repeats.

import { getClassifier } from './classifiers';
import type { FoodClassifier } from './classifiers/types';
import { buildFoodMaskCanvas, wholeImageMaskCanvas } from './mask';
import { compositeOverlay } from './composite';
import { DEFAULTS, PIPELINE, type Settings } from '../shared/config';
import { modelSpec, type ModelId } from '../shared/models';
import type { MaskResult, OffscreenJob } from '../shared/messages';

type CacheEntry = { isFood: boolean; overlayPngDataUrl?: string };

const CANCELLED = Symbol('cancelled');
type Waiter = { id: string; start: () => void; cancel: () => void };

export class Pipeline {
  private settings: Settings = { ...DEFAULTS };
  private active = 0;
  private waiters: Waiter[] = [];
  private cancelled = new Set<string>();
  // Keyed by model + URL: the two models disagree by design, so a verdict from
  // one must never be served for the other.
  private cache = new Map<string, CacheEntry>();

  get modelId(): ModelId {
    return this.settings.modelId;
  }

  get provider() {
    return getClassifier(this.settings.modelId).provider;
  }

  // Settings are passed in, never read here: this class runs in the offscreen
  // document, which has no chrome.storage. See offscreen/index.ts.
  async init(settings: Settings) {
    this.settings = settings;
    await this.warm(this.settings.modelId);
  }

  updateSettings(next: Settings) {
    const blurChanged = next.blurPx !== this.settings.blurPx;
    const modelChanged = next.modelId !== this.settings.modelId;
    this.settings = next;
    // Overlays bake in the blur radius, so a blur change invalidates cached ones.
    // A model change does not: cache keys already include the model id.
    if (blurChanged) this.cache.clear();
    if (modelChanged) {
      console.log(`[foodmask][offscreen] model -> ${modelSpec(next.modelId).name}`);
      void this.warm(next.modelId); // start the load now, don't stall the first job
    }
  }

  // Kick off a model load without failing the caller — jobs await it again and
  // will surface any error through their own MASK_RESULT.
  private warm(id: ModelId): Promise<void> {
    return getClassifier(id)
      .load()
      .catch((err) => {
        console.error(`[foodmask][offscreen] ${modelSpec(id).name} load failed`, err);
      });
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
    // Pin the model for the whole job: a mid-flight popup switch must not make
    // us cache one model's verdict under the other's key.
    const modelId = this.settings.modelId;
    const key = cacheKey(modelId, job.imageUrl);

    const cached = this.cache.get(key);
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
      const classifier: FoodClassifier = getClassifier(modelId);
      await classifier.load();

      const bitmap = await urlToBitmap(job.imageUrl);
      const tFetch = performance.now();

      if (this.cancelled.has(job.requestId)) {
        bitmap.close();
        return cancelledResult(job);
      }

      // ---- the only model-specific line in the pipeline ----
      const verdict = await classifier.classify(bitmap);
      const tInfer = performance.now();

      if (!verdict.isFood) {
        bitmap.close();
        const entry: CacheEntry = { isFood: false };
        this.cache.set(key, entry);
        this.logTimings(job, modelId, t0, tFetch, tInfer, tInfer, false, []);
        return { type: 'MASK_RESULT', ...idOf(job), ...entry };
      }

      // A classifier that segments tells us WHERE the food is; one that only
      // returns a boolean doesn't, so the whole image is the honest mask.
      const seg = verdict.segmentation;
      const maskCanvas = seg
        ? buildFoodMaskCanvas(seg.detections, seg.protos, seg.letterbox)
        : wholeImageMaskCanvas(bitmap.width, bitmap.height);

      let overlay: string | undefined;
      if (maskCanvas) {
        overlay = await compositeOverlay(bitmap, maskCanvas, this.settings.blurPx);
      }
      const tComposite = performance.now();
      bitmap.close();

      this.logTimings(job, modelId, t0, tFetch, tInfer, tComposite, true, verdict.labels);

      const entry: CacheEntry = { isFood: true, overlayPngDataUrl: overlay };
      this.cache.set(key, entry);
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
    modelId: ModelId,
    t0: number,
    tFetch: number,
    tInfer: number,
    tComposite: number,
    isFood: boolean,
    labels: string[],
  ) {
    const ms = (a: number, b: number) => `${(b - a).toFixed(0)}ms`;
    console.log(
      `[foodmask][offscreen] ${job.imgId.slice(0, 6)} <${modelId}> ` +
        `${isFood ? `FOOD[${labels.join(',')}]` : 'not-food'} ` +
        `fetch=${ms(t0, tFetch)} infer=${ms(tFetch, tInfer)} composite=${ms(tInfer, tComposite)} ` +
        `total=${ms(t0, tComposite)}`,
    );
  }
}

function cacheKey(modelId: ModelId, imageUrl: string): string {
  return `${modelId}::${imageUrl}`;
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
