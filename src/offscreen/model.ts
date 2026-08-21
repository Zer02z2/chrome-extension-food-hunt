// YOLOv8n-seg wrapper. One forward pass yields both the food gate (any food-class
// detection) and the instance masks needed to build the overlay. Kept behind a
// small interface so a food-specialized model can be swapped in without touching
// the pipeline (see plan Phase 7).

import { createSession, ort, type LoadedSession } from './runtime';
import { preprocess, type Letterbox } from './preprocess';
import { isFoodClass, COCO_CLASSES } from './coco';
import { PIPELINE } from '../shared/config';

const MODEL_PATH = 'models/yolov8n-seg.onnx';
const NMS_IOU = 0.45;
const PROTO_SIZE = 160;
const PROTO_CH = 32;

export type Detection = {
  classId: number;
  score: number;
  box: [number, number, number, number]; // x1,y1,x2,y2 in model (letterbox) pixels
  coeffs: Float32Array; // 32 mask coefficients
};

export type AnalyzeResult = {
  isFood: boolean;
  detections: Detection[]; // food-class detections, post-NMS
  protos: Float32Array | null; // output1 data [32,160,160]
  letterbox: Letterbox;
};

export class FoodModel {
  private loaded: LoadedSession | null = null;

  get provider(): 'webgpu' | 'wasm' | 'uninitialized' {
    return this.loaded?.provider ?? 'uninitialized';
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = await createSession(MODEL_PATH);
    console.log(`[foodmask][offscreen] model ready on ${this.loaded.provider}`);
  }

  async analyze(bitmap: ImageBitmap): Promise<AnalyzeResult> {
    if (!this.loaded) throw new Error('model not loaded');
    const session = this.loaded.session;

    const { data, letterbox } = preprocess(bitmap);
    const input = new ort.Tensor('float32', data, [1, 3, letterbox.size, letterbox.size]);

    const feeds: Record<string, ort.Tensor> = { [session.inputNames[0]]: input };
    const output = await session.run(feeds);

    const out0 = output[session.outputNames[0]]; // [1,116,8400]
    const out1 = output[session.outputNames[1]]; // [1,32,160,160]

    const detections = decodeDetections(
      out0.data as Float32Array,
      out0.dims as number[],
    );
    const kept = nms(detections, NMS_IOU);

    return {
      isFood: kept.length > 0,
      detections: kept,
      protos: out1 ? (out1.data as Float32Array) : null,
      letterbox,
    };
  }
}

// Decode YOLOv8-seg output0 [1, 4+numClasses+32, numAnchors].
// Attributes are the outer stride: value(attr, anchor) = data[attr*numAnchors + anchor].
function decodeDetections(data: Float32Array, dims: number[]): Detection[] {
  const numAttrs = dims[1]; // 116
  const numAnchors = dims[2]; // 8400
  const numClasses = numAttrs - 4 - PROTO_CH; // 80
  const dets: Detection[] = [];

  for (let n = 0; n < numAnchors; n++) {
    // best class
    let bestC = -1;
    let best = 0;
    for (let c = 0; c < numClasses; c++) {
      const s = data[(4 + c) * numAnchors + n];
      if (s > best) {
        best = s;
        bestC = c;
      }
    }
    if (best < PIPELINE.scoreThreshold || !isFoodClass(bestC)) continue;

    const cx = data[0 * numAnchors + n];
    const cy = data[1 * numAnchors + n];
    const w = data[2 * numAnchors + n];
    const h = data[3 * numAnchors + n];

    const coeffs = new Float32Array(PROTO_CH);
    for (let k = 0; k < PROTO_CH; k++) {
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
  protos: Float32Array | null,
  lb: Letterbox,
): OffscreenCanvas | null {
  if (!protos || detections.length === 0) return null;

  const mh = PROTO_SIZE;
  const mw = PROTO_SIZE;
  const scale = mw / lb.size; // model px -> proto px (160/640)
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
        for (let k = 0; k < PROTO_CH; k++) {
          s += det.coeffs[k] * protos[k * mh * mw + base];
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

  // 160x160 union -> upscale to 640 letterbox -> crop padding -> original size.
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
  return COCO_CLASSES[id] ?? String(id);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clampI(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
