// Catalog of the food-categorization models the extension can switch between.
//
// This file is deliberately dependency-free (no ONNX imports) because three
// contexts read it: the popup renders the picker from it, the content HUD shows
// the active name, and the offscreen document resolves it to a real classifier.
// Only the offscreen document may import ORT code.
//
// Adding a model = one entry here + one factory in
// src/offscreen/classifiers/index.ts. Nothing else in the pipeline changes.

export type ModelId = 'foodseg103' | 'coco';

export type ModelSpec = {
  id: ModelId;
  /** Shown in the popup picker and the content HUD. */
  name: string;
  /** One-line trade-off blurb shown under the picker. */
  summary: string;
  /** Path under public/, loaded via chrome.runtime.getURL. */
  file: string;
  /**
   * Confidence floor for keeping a detection. Per-model because the two exports
   * score very differently: FoodSeg103 spreads confidence across 104
   * fine-grained classes and so scores lower than COCO's 80 coarse ones.
   */
  scoreThreshold: number;
};

export const MODELS: Record<ModelId, ModelSpec> = {
  foodseg103: {
    id: 'foodseg103',
    name: 'FoodSeg103',
    summary: '103 ingredient classes — broad coverage (ramen, sushi, curry…), noisier labels.',
    file: 'models/yolov8-foodseg103.onnx',
    // Validated: 0.15 masks pizza/ramen/sushi while a street/bus scene stays
    // clean — the model's background class suppresses non-food even this low.
    scoreThreshold: 0.15,
  },
  coco: {
    id: 'coco',
    name: 'COCO (10 foods)',
    summary:
      'Precise on pizza, cake, sandwich, donut, hot dog, banana, apple, orange, broccoli, carrot.',
    file: 'models/yolov8n-seg-coco.onnx',
    scoreThreshold: 0.25,
  },
};

// Display order for the popup picker.
export const MODEL_IDS: ModelId[] = ['foodseg103', 'coco'];

export const DEFAULT_MODEL_ID: ModelId = 'foodseg103';

export function isModelId(v: unknown): v is ModelId {
  return typeof v === 'string' && v in MODELS;
}

export function modelSpec(id: ModelId): ModelSpec {
  return MODELS[id];
}
