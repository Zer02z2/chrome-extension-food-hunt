// YOLOv8-seg wrapper. One forward pass yields both the food gate (any food-class
// detection) and the instance masks needed to build the overlay. Kept behind a
// small interface so a food-specialized model can be swapped in without touching
// the pipeline (see plan Phase 7).
//
// Input size, class count, and mask-prototype dimensions are all read from the
// loaded session, so COCO (640 input, 80 classes, 160 protos) and FoodSeg103
// (768 input, 104 classes incl. background, 192 protos) exports both just work.

import { createSession, ort, type LoadedSession } from './runtime';
import { preprocess, type Letterbox } from './preprocess';
import { isFoodClass, COCO_CLASSES } from './coco';
import { FOODSEG103_WITH_BG, FOODSEG103_BACKGROUND_ID } from './foodseg103';
import { PIPELINE, MODEL } from '../shared/config';

const NMS_IOU = 0.45;

// How to interpret a model's classes: which count as food, and their labels.
type FoodPolicy = {
  isFood: (classId: number) => boolean;
  label: (classId: number) => string;
};

const COCO_POLICY: FoodPolicy = {
  isFood: isFoodClass, // only the 10 COCO food classes
  label: (id) => COCO_CLASSES[id] ?? `#${id}`,
};

// Food-specialized model: every class is food, except a background class if the
// export includes one (FoodSeg103 has 104 ids with background at 0).
function foodPolicy(numClasses: number): FoodPolicy {
  const hasBackground = numClasses >= FOODSEG103_WITH_BG.length; // 104 => bg at 0
  return {
    isFood: (id) => !(hasBackground && id === FOODSEG103_BACKGROUND_ID),
    label: (id) =>
      hasBackground
        ? (FOODSEG103_WITH_BG[id] ?? `food #${id}`)
        : (FOODSEG103_WITH_BG[id + 1] ?? `food #${id}`), // no bg => shift past it
  };
}

// Choose the gate from config, defaulting to auto-detection by class count so a
// dropped-in COCO or food model both behave correctly with no config change.
function pickPolicy(numClasses: number): FoodPolicy {
  if (MODEL.kind === 'coco') return COCO_POLICY;
  if (MODEL.kind === 'foodseg103') return foodPolicy(numClasses);
  return numClasses === COCO_CLASSES.length ? COCO_POLICY : foodPolicy(numClasses);
}

// The policy for the currently loaded model, set on first analyze(). Labels read
// from it; the gate is applied during decode.
let activePolicy: FoodPolicy = COCO_POLICY;

export type Detection = {
  classId: number;
  score: number;
  box: [number, number, number, number]; // x1,y1,x2,y2 in model (letterbox) pixels
  coeffs: Float32Array; // mask coefficients (length = proto channels)
};

export type Protos = {
  data: Float32Array; // output1 [protoCh, protoH, protoW]
  ch: number;
  h: number;
  w: number;
};

export type AnalyzeResult = {
  isFood: boolean;
  detections: Detection[]; // food-class detections, post-NMS
  protos: Protos | null;
  letterbox: Letterbox;
};

export class FoodModel {
  private loaded: LoadedSession | null = null;
  private inputSize: number = PIPELINE.modelInputSize;

  get provider(): 'webgpu' | 'wasm' | 'uninitialized' {
    return this.loaded?.provider ?? 'uninitialized';
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = await createSession(MODEL.path);
    this.inputSize = readInputSize(this.loaded.session) ?? PIPELINE.modelInputSize;
    console.log(
      `[foodmask][offscreen] model ready on ${this.loaded.provider}, input=${this.inputSize}`,
    );
  }

  async analyze(bitmap: ImageBitmap): Promise<AnalyzeResult> {
    if (!this.loaded) throw new Error('model not loaded');
    const session = this.loaded.session;

    const { data, letterbox } = preprocess(bitmap, this.inputSize);
    const input = new ort.Tensor('float32', data, [1, 3, letterbox.size, letterbox.size]);

    const feeds: Record<string, ort.Tensor> = { [session.inputNames[0]]: input };
    const output = await session.run(feeds);

    const out0 = output[session.outputNames[0]]; // [1, 4+numClasses+protoCh, numAnchors]
    const out1 = output[session.outputNames[1]]; // [1, protoCh, protoH, protoW]

    const o0 = out0.dims as number[];
    const protos: Protos | null = out1
      ? {
          data: out1.data as Float32Array,
          ch: (out1.dims as number[])[1],
          h: (out1.dims as number[])[2],
          w: (out1.dims as number[])[3],
        }
      : null;

    const protoCh = protos?.ch ?? 32;
    const numClasses = o0[1] - 4 - protoCh;
    activePolicy = pickPolicy(numClasses);

    const detections = decodeDetections(out0.data as Float32Array, o0, numClasses, protoCh, activePolicy);
    const kept = nms(detections, NMS_IOU);

    return { isFood: kept.length > 0, detections: kept, protos, letterbox };
  }
}

// Read the square input size from the session's input metadata. Returns
// undefined for dynamic/unknown shapes so the caller can fall back to a default.
function readInputSize(session: ort.InferenceSession): number | undefined {
  const meta = session.inputMetadata?.[0] as { shape?: readonly (number | string)[] } | undefined;
  const shape = meta?.shape;
  if (!shape || shape.length < 4) return undefined;
  const w = shape[3];
  const h = shape[2];
  if (typeof w === 'number' && w > 0) return w;
  if (typeof h === 'number' && h > 0) return h;
  return undefined;
}

// Decode YOLOv8-seg output0 [1, 4+numClasses+protoCh, numAnchors].
// Attributes are the outer stride: value(attr, anchor) = data[attr*numAnchors + anchor].
function decodeDetections(
  data: Float32Array,
  dims: number[],
  numClasses: number,
  protoCh: number,
  policy: FoodPolicy,
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
    if (best < PIPELINE.scoreThreshold || !policy.isFood(bestC)) continue;

    const cx = data[0 * numAnchors + n];
    const cy = data[1 * numAnchors + n];
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
function nms(dets: Detection[], iouThresh: number): Detection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep: Detection[] = [];
  const removed = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    if (removed.has(i)) continue;
    keep.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (removed.has(j)) continue;
      if (iou(sorted[i].box, sorted[j].box) > iouThresh) removed.add(j);
    }
  }
  return keep;
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

// Build a binary food mask at ORIGINAL image resolution as an OffscreenCanvas
// whose alpha is 255 inside food and 0 elsewhere. Returns null if no protos.
export function buildFoodMaskCanvas(
  detections: Detection[],
  protos: Protos | null,
  lb: Letterbox,
): OffscreenCanvas | null {
  if (!protos || detections.length === 0) return null;

  const { data, ch, h: mh, w: mw } = protos;
  const scale = mw / lb.size; // model px -> proto px
  const union = new Uint8ClampedArray(mw * mh * 4); // RGBA

  for (const det of detections) {
    const bx1 = clampI(det.box[0] * scale, 0, mw);
    const by1 = clampI(det.box[1] * scale, 0, mh);
    const bx2 = clampI(det.box[2] * scale, 0, mw);
    const by2 = clampI(det.box[3] * scale, 0, mh);

    for (let y = by1; y < by2; y++) {
      for (let x = bx1; x < bx2; x++) {
        const pIdx = (y * mw + x) * 4;
        if (union[pIdx + 3] === 255) continue; // already set by another instance
        let s = 0;
        const base = y * mw + x;
        for (let k = 0; k < ch; k++) {
          s += det.coeffs[k] * data[k * mh * mw + base];
        }
        if (sigmoid(s) > PIPELINE.maskThreshold) {
          union[pIdx] = 255;
          union[pIdx + 1] = 255;
          union[pIdx + 2] = 255;
          union[pIdx + 3] = 255;
        }
      }
    }
  }

  // proto union -> upscale to the letterbox square -> crop padding -> original size.
  const protoCanvas = new OffscreenCanvas(mw, mh);
  protoCanvas.getContext('2d')!.putImageData(new ImageData(union, mw, mh), 0, 0);

  const letterCanvas = new OffscreenCanvas(lb.size, lb.size);
  const lctx = letterCanvas.getContext('2d')!;
  lctx.imageSmoothingEnabled = true;
  lctx.drawImage(protoCanvas, 0, 0, lb.size, lb.size);

  const newW = lb.size - 2 * lb.padX;
  const newH = lb.size - 2 * lb.padY;
  const origCanvas = new OffscreenCanvas(lb.srcW, lb.srcH);
  const octx = origCanvas.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  octx.drawImage(
    letterCanvas,
    lb.padX, lb.padY, newW, newH, // src crop (remove gray padding)
    0, 0, lb.srcW, lb.srcH, // dest (full original)
  );

  return origCanvas;
}

export function classLabel(id: number): string {
  return activePolicy.label(id);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clampI(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
