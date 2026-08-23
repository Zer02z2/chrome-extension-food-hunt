// Registry: ModelId -> a live FoodClassifier.
//
// Sessions are expensive to build (~14 MB weights + ORT graph optimization), so
// instances are memoized and stay warm. Switching models in the popup therefore
// costs a load exactly once per model per offscreen-document lifetime; flipping
// back and forth after that is instant. Two warm sessions is ~30 MB — an
// acceptable trade for a picker that responds immediately.

import { MODELS, type ModelId } from '../../shared/models';
import { YoloSegClassifier } from './yolo-seg';
import { COCO_POLICY } from './coco';
import { foodSegPolicy } from './foodseg103';
import type { FoodClassifier } from './types';

// One factory per catalog entry. This is the ONLY place that knows how a model
// id becomes running code — the pipeline just asks for an id.
const FACTORIES: Record<ModelId, () => FoodClassifier> = {
  foodseg103: () => new YoloSegClassifier(MODELS.foodseg103, foodSegPolicy),
  coco: () => new YoloSegClassifier(MODELS.coco, () => COCO_POLICY),
};

const warm = new Map<ModelId, FoodClassifier>();

export function getClassifier(id: ModelId): FoodClassifier {
  let c = warm.get(id);
  if (!c) {
    c = FACTORIES[id]();
    warm.set(id, c);
  }
  return c;
}

export type { FoodClassifier, FoodVerdict, Segmentation, Detection, Protos } from './types';
