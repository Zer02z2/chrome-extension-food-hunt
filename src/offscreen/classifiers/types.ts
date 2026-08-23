// The one pluggable seam in the pipeline.
//
// A classifier answers exactly one question: **is this image food?** Everything
// downstream (masking, compositing, messaging, caching, the HUD) is shared and
// does not care which model produced the answer. Swapping models means swapping
// an implementation of FoodClassifier — nothing else.
//
// `segmentation` is an OPTIONAL by-product. Both models shipped today are
// YOLOv8-seg, which produces instance masks in the same forward pass that gives
// the verdict, so throwing that away and re-running a segmenter would double the
// cost for nothing. A future pure classifier (e.g. a MobileNet food/not-food
// head) simply omits it, and the pipeline masks the whole image instead.

import type { Letterbox } from '../preprocess';
import type { ModelId } from '../../shared/models';

export type Provider = 'webgpu' | 'wasm' | 'uninitialized';

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

/** Instance masks a segmentation-capable classifier computed on the way. */
export type Segmentation = {
  detections: Detection[]; // food-class detections, post-NMS
  protos: Protos | null;
  letterbox: Letterbox;
};

export type FoodVerdict = {
  /** The whole contract. Everything else on this type is optional garnish. */
  isFood: boolean;
  /** Human-readable class names, for the HUD and logs only. Never gates anything. */
  labels: string[];
  /**
   * Present only when the classifier segments as a by-product. Absent/null means
   * "food, but I can't tell you where" — the pipeline masks the whole image.
   */
  segmentation?: Segmentation | null;
};

export interface FoodClassifier {
  readonly id: ModelId;
  readonly name: string;
  /** Which ORT execution provider actually initialized. For logging. */
  readonly provider: Provider;
  /** Idempotent; safe to await on every job. */
  load(): Promise<void>;
  classify(bitmap: ImageBitmap): Promise<FoodVerdict>;
}
