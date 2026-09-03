// The compute pipeline: fetch -> model -> mask -> overlay. One job in, one
// MaskResult out.
//
// This worker exists for exactly one reason. ONNX Runtime's wasm backend runs
// inference synchronously on whichever thread calls it (no SharedArrayBuffer in
// an extension page means no worker pool of its own). Called from the offscreen
// document's main thread that froze the entire extension renderer for ~0.7 s per
// image — and the popup shares that renderer, so it could not even open. In
// here the same 0.7 s costs nothing visible.
//
// The worker has no chrome.* APIs, so every extension URL it needs is handed to
// it in the INIT message.

import { runModel, configureOrt } from './model';
import { buildOverlay } from './mask';
import { MODELS, type ModelId } from '../shared/models';
import type { CancelJob, MaskResult, OffscreenJob, WorkerInit } from '../shared/messages';

const MAX_CACHE = 300;

let modelUrls: Record<ModelId, string> | null = null;

// Keyed by model + URL: the models disagree by design, so one's verdict must
// never be served for the other.
const cache = new Map<string, Omit<MaskResult, 'type' | 'requestId' | 'imgId'>>();
const cancelled = new Set<string>();

// Jobs run one at a time. Inference is CPU-bound and single-threaded, so running
// two concurrently only makes both slower and delays every result.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<WorkerInit | OffscreenJob | CancelJob>) => {
  const msg = e.data;

  if (msg.type === 'WORKER_INIT') {
    configureOrt(msg.ortBaseUrl);
    modelUrls = msg.modelUrls;
    return;
  }

  if (msg.type === 'CANCEL_JOB') {
    cancelled.add(msg.requestId);
    return;
  }

  // Never let a rejected link break the chain — one unexpected throw would
  // otherwise leave every later job queued behind it forever.
  queue = queue
    .then(async () => self.postMessage(await run(msg)))
    .catch((err) => console.error('[foodmask][worker] job failed', err));
};

async function run(job: OffscreenJob): Promise<MaskResult> {
  const done = (fields: Partial<MaskResult>): MaskResult => ({
    type: 'MASK_RESULT',
    requestId: job.requestId,
    imgId: job.imgId,
    isFood: false,
    ...fields,
  });

  // An image that scrolled away while queued is not worth 0.7 s of inference.
  if (cancelled.delete(job.requestId)) return done({ error: 'cancelled' });

  const key = `${job.modelId}::${job.imageUrl}`;
  const hit = cache.get(key);
  if (hit) return done(hit);

  if (!modelUrls) return done({ error: 'worker not initialized' });

  const t0 = performance.now();
  let bitmap: ImageBitmap | undefined;
  try {
    // Fetching here rather than in the page means extension host_permissions
    // grant cross-origin access, so the bitmap is never tainted.
    const res = await fetch(job.imageUrl);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    bitmap = await createImageBitmap(await res.blob());
    const tFetch = performance.now();

    if (cancelled.delete(job.requestId)) return done({ error: 'cancelled' });

    // ---- the only model-aware line in the pipeline ----
    const spec = MODELS[job.modelId];
    const verdict = await runModel(spec, modelUrls[job.modelId], bitmap);
    const tInfer = performance.now();

    const entry = verdict.isFood
      ? { isFood: true, overlayPngDataUrl: await buildOverlay(bitmap, verdict) }
      : { isFood: false };

    remember(key, entry);
    log(job, verdict.isFood ? `FOOD[${verdict.labels.join(',')}]` : 'not-food', [
      ['fetch', t0, tFetch],
      ['infer', tFetch, tInfer],
      ['overlay', tInfer, performance.now()],
    ]);
    return done(entry);
  } catch (err) {
    return done({ error: String((err as Error)?.message ?? err) });
  } finally {
    bitmap?.close();
    cancelled.delete(job.requestId);
  }
}

function remember(key: string, entry: Omit<MaskResult, 'type' | 'requestId' | 'imgId'>) {
  cache.set(key, entry);
  // Map iterates in insertion order, so the first key is the oldest.
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
}

function log(job: OffscreenJob, verdict: string, spans: [string, number, number][]) {
  const timings = spans.map(([name, a, b]) => `${name}=${(b - a).toFixed(0)}ms`).join(' ');
  console.log(
    `[foodmask][worker] ${job.imgId.slice(0, 6)} <${job.modelId}> ${verdict} ${timings}`,
  );
}
