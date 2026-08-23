// The one model runner. Both shipped models are YOLOv8-seg, so session setup,
// letterboxing, the forward pass, decode and NMS live here exactly once; the
// only things that vary come from the ModelSpec (weights, threshold, food gate,
// labels). Adding a model does not touch this file.
//
// Runs inside the worker — see worker.ts for why that matters.

import * as ort from 'onnxruntime-web';
import type { ModelSpec } from '../shared/models';

const NMS_IOU = 0.45;
const PAD_VALUE = 114; // standard YOLO gray padding

export type Letterbox = {
  size: number; // square model input, read from the ONNX graph
  ratio: number; // scale applied to the original image
  padX: number; // left/right padding in model pixels
  padY: number; // top/bottom padding in model pixels
  srcW: number;
  srcH: number;
};

export type Detection = {
  classId: number;
  score: number;
  box: [number, number, number, number]; // x1,y1,x2,y2 in model (letterbox) pixels
  coeffs: Float32Array; // mask coefficients, one per prototype channel
};

export type Protos = {
  data: Float32Array; // [ch, h, w]
  ch: number;
  h: number;
  w: number;
};

export type Verdict = {
  /** The whole contract. Everything below is detail for drawing the mask. */
  isFood: boolean;
  /** Class names, for the HUD and logs only. */
  labels: string[];
  detections: Detection[]; // food-class detections, post-NMS
  protos: Protos | null;
  letterbox: Letterbox;
};

// MV3 forbids remote code, so the wasm artifacts are served from the packaged
// ort/ directory. The worker has no chrome.* APIs, so the URL is handed in.
let configured = false;

export function configureOrt(ortBaseUrl: string) {
  if (configured) return;
  configured = true;
  ort.env.wasm.wasmPaths = ortBaseUrl;
  // Extension pages are not cross-origin isolated, so SharedArrayBuffer-backed
  // threading is unavailable. Proxying is pointless too: this already IS a
  // worker, so ORT blocking its calling thread costs nothing visible.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
}

type Loaded = { session: ort.InferenceSession; size: number; provider: string };

// Sessions are expensive (~14 MB of weights plus graph optimization), so each is
// built at most once and kept warm. Flipping models in the popup then costs a
// load only the first time.
const sessions = new Map<string, Promise<Loaded>>();

export function loadModel(spec: ModelSpec, url: string): Promise<Loaded> {
  let loaded = sessions.get(spec.id);
  if (!loaded) {
    loaded = createSession(spec, url).catch((err) => {
      sessions.delete(spec.id); // let a later job retry
      throw err;
    });
    sessions.set(spec.id, loaded);
  }
  return loaded;
}

async function createSession(spec: ModelSpec, url: string): Promise<Loaded> {
  const res = await fetch(url);
  if (!res.ok) {
    // Weights are fetched, never committed, so a missing file is the most likely
    // first-run failure. Say so instead of surfacing a bare 404.
    throw new Error(
      `${spec.name} weights missing (${spec.file}) — run \`npm run fetch:models\` and rebuild`,
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());

  // Prefer WebGPU; ORT does not reliably fall back on its own, so try each
  // provider explicitly and report which one actually initialized.
  let session: ort.InferenceSession | null = null;
  let provider = 'wasm';
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      session = await ort.InferenceSession.create(buf, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      provider = 'webgpu';
    } catch (err) {
      console.warn('[foodmask][worker] WebGPU init failed, falling back to WASM:', err);
    }
  }
  session ??= await ort.InferenceSession.create(buf, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });

  const size = squareInputSize(session);
  console.log(`[foodmask][worker] ${spec.name} ready on ${provider}, input=${size}`);
  return { session, size, provider };
}

// Both exports declare a fixed square input (COCO 640, FoodSeg103 768), and
// feeding the wrong size is a hard shape error — so read it from the graph
// rather than assuming a value.
function squareInputSize(session: ort.InferenceSession): number {
  const meta = session.inputMetadata?.[0] as { shape?: readonly (number | string)[] } | undefined;
  const shape = meta?.shape;
  const w = shape?.[3];
  const h = shape?.[2];
  if (typeof w === 'number' && w > 0) return w;
  if (typeof h === 'number' && h > 0) return h;
  throw new Error('model declares a dynamic input shape; a fixed square export is required');
}

/** Run one image through one model. The only model-aware call in the pipeline. */
export async function runModel(
  spec: ModelSpec,
  url: string,
  bitmap: ImageBitmap,
): Promise<Verdict> {
  const { session, size } = await loadModel(spec, url);

  const { data, letterbox } = preprocess(bitmap, size);
  const input = new ort.Tensor('float32', data, [1, 3, size, size]);
  const output = await session.run({ [session.inputNames[0]]: input });

  const out0 = output[session.outputNames[0]]; // [1, 4+numClasses+protoCh, numAnchors]
  const out1 = output[session.outputNames[1]]; // [1, protoCh, protoH, protoW]

  const protos: Protos | null = out1
    ? {
        data: out1.data as Float32Array,
        ch: out1.dims[1],
        h: out1.dims[2],
        w: out1.dims[3],
      }
    : null;

  const dims = out0.dims as number[];
  const protoCh = protos?.ch ?? 32;
  const numClasses = dims[1] - 4 - protoCh;
  const detections = nms(decode(out0.data as Float32Array, dims, numClasses, protoCh, spec));

  return {
    isFood: detections.length > 0,
    labels: detections.map((d) => spec.label(d.classId)),
    detections,
    protos,
    letterbox,
  };
}

// Letterbox into the model's square input and produce an NCHW float32 tensor.
// The letterbox parameters travel with the result so masks can be mapped back to
// original image coordinates.
function preprocess(bitmap: ImageBitmap, size: number) {
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const ratio = Math.min(size / srcW, size / srcH);
  const newW = Math.round(srcW * ratio);
  const newH = Math.round(srcH * ratio);
  const padX = (size - newW) / 2;
  const padY = (size - newH) / 2;

  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`;
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, padX, padY, newW, newH);

  const { data: rgba } = ctx.getImageData(0, 0, size, size);
  const plane = size * size;
  const data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    data[i] = rgba[i * 4] / 255; // R plane
    data[plane + i] = rgba[i * 4 + 1] / 255; // G plane
    data[2 * plane + i] = rgba[i * 4 + 2] / 255; // B plane
  }

  const letterbox: Letterbox = { size, ratio, padX, padY, srcW, srcH };
  return { data, letterbox };
}

// Decode YOLOv8-seg output0 [1, 4+numClasses+protoCh, numAnchors]. Attributes
// are the outer stride: value(attr, anchor) = data[attr*numAnchors + anchor].
function decode(
  data: Float32Array,
  dims: number[],
  numClasses: number,
  protoCh: number,
  spec: ModelSpec,
): Detection[] {
  const numAnchors = dims[2];
  const dets: Detection[] = [];

  for (let n = 0; n < numAnchors; n++) {
    let bestC = -1;
    let best = 0;
    for (let c = 0; c < numClasses; c++) {
      const s = data[(4 + c) * numAnchors + n];
      if (s > best) {
        best = s;
        bestC = c;
      }
    }
    if (best < spec.scoreThreshold || !spec.isFood(bestC)) continue;

    const cx = data[n];
    const cy = data[numAnchors + n];
    const w = data[2 * numAnchors + n];
    const h = data[3 * numAnchors + n];

    const coeffs = new Float32Array(protoCh);
    for (let k = 0; k < protoCh; k++) {
      coeffs[k] = data[(4 + numClasses + k) * numAnchors + n];
    }

    dets.push({
      classId: bestC,
      score: best,
      box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
      coeffs,
    });
  }
  return dets;
}

// Class-agnostic non-max suppression.
function nms(dets: Detection[]): Detection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep: Detection[] = [];
  const dropped = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    if (dropped.has(i)) continue;
    keep.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (!dropped.has(j) && iou(sorted[i].box, sorted[j].box) > NMS_IOU) dropped.add(j);
    }
  }
  return keep;
}

function iou(a: Detection['box'], b: Detection['box']): number {
  const inter =
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}
