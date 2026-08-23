// COCO-80 class policy: the stock YOLOv8n-seg model's classes, of which ten are
// food. Narrow coverage but high precision on what it does know — the detection
// pass over those ten classes IS the food gate.

import type { ClassPolicy } from './yolo-seg';

export const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck',
  'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench',
  'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra',
  'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove',
  'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup',
  'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
  'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
  'toothbrush',
] as const;

// banana, apple, sandwich, orange, broccoli, carrot, hot dog, pizza, donut, cake
export const FOOD_CLASS_IDS = new Set<number>([46, 47, 48, 49, 50, 51, 52, 53, 54, 55]);

export function isFoodClass(classId: number): boolean {
  return FOOD_CLASS_IDS.has(classId);
}

export const COCO_POLICY: ClassPolicy = {
  isFood: isFoodClass,
  label: (id) => COCO_CLASSES[id] ?? `#${id}`,
};
