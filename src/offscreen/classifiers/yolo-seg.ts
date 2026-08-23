// Shared YOLOv8-seg engine. Both shipped models use this architecture, so the
// forward pass, decode, and NMS live here exactly once; a concrete classifier
// supplies only its ModelSpec and its class policy (which class ids count as
// food, and what to call them).
//
// Input size, class count, and mask-prototype dimensions are all read from the
// loaded session, so COCO (640 input, 80 classes, 160 protos) and FoodSeg103
// (104 classes incl. background, 192 protos) exports both just work.

import { createSession, ort, type LoadedSession } from '../runtime';
import { preprocess } from '../preprocess';
import { PIPELINE } from '../../shared/config';
import type { ModelSpec } from '../../shared/models';
import type { Detection, FoodClassifier, FoodVerdict, Protos, Provider } from './types';

const NMS_IOU = 0.45;

/** How a given model's class ids map to "food" and to display names. */
export type ClassPolicy = {
  isFood: (classId: number) => boolean;
  label: (classId: number) => string;
};

/**
 * `makePolicy` receives the class count decoded from the session so a policy can
 * adapt to export variants (e.g. FoodSeg103 with or without a background class).
 */
export class YoloSegClassifier implements FoodClassifier {
  private loaded: LoadedSession | null = null;
  private loading: Promise<void> | null = null;
  private inputSize: number = PIPELINE.modelInputSize;
  private policy: ClassPolicy | null = null;

  constructor(
    private readonly spec: ModelSpec,
    private readonly makePolicy: (numClasses: number) => ClassPolicy,
  ) {}

  get id() {
    return this.spec.id;
  }

  get name() {
    return this.spec.name;
  }

  get provider(): Provider {
    return this.loaded?.provider ?? 'uninitialized';
  }

  load(): Promise<void> {
    if (!this.loading) {
      this.loading = this.doLoad().catch((err) => {
        this.loading = null; // let a later job retry (e.g. after fetch:models)
        throw err;
      });
    }
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    this.loaded = await createSession(this.spec.file, this.spec.name);
    this.inputSize = readInputSize(this.loaded.session) ?? PIPELINE.modelInputSize;
    console.log(
      `[foodmask][offscreen] ${this.spec.name} ready on ${this.loaded.provider}, input=${this.inputSize}`,
    );
  }

  async classify(bitmap: ImageBitmap): Promise<FoodVerdict> {
    await this.load();
    const session = this.loaded!.session;

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
    // The class count is only knowable once a real output is in hand, so the
    // policy is built on first inference and reused thereafter.
    this.policy ??= this.makePolicy(numClasses);
    const policy = this.policy;

    const dets = decodeDetections(
      out0.data as Float32Array,
      o0,
      numClasses,
      protoCh,
      policy,
      this.spec.scoreThreshold,
    );
    const kept = nms(dets, NMS_IOU);

    return {
      isFood: kept.length > 0,
      labels: kept.map((d) => policy.label(d.classId)),
      segmentation: { detections: kept, protos, letterbox },
    };
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
  policy: ClassPolicy,
  scoreThreshold: number,
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
    if (best < scoreThreshold || !policy.isFood(bestC)) continue;

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
