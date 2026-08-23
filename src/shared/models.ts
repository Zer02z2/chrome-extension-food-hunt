// Catalog of the food models the extension can switch between.
//
// Everything that differs between models lives here, as data: where the weights
// are, how confident a detection has to be, which class ids count as food, and
// what to call them. The runner in offscreen/model.ts reads this and contains no
// per-model branches, so adding a model is one entry below and nothing else.
//
// Dependency-free on purpose — the popup, the content HUD and the worker all
// import it, and only the worker may pull in ONNX.

export type ModelId = 'foodseg103' | 'coco';

export type ModelSpec = {
  id: ModelId;
  /** Shown in the popup picker and the content HUD. */
  name: string;
  /** One-line trade-off blurb shown under the picker. */
  summary: string;
  /** Path under public/, resolved with chrome.runtime.getURL. */
  file: string;
  /**
   * Confidence floor for keeping a detection. Per-model because the exports
   * score differently: FoodSeg103 spreads confidence over 104 fine-grained
   * classes and so peaks lower than COCO's 80 coarse ones.
   */
  scoreThreshold: number;
  /** The food gate. Given a winning class id, is this food? */
  isFood: (classId: number) => boolean;
  /** Display name for a class id. Cosmetic — never gates anything. */
  label: (classId: number) => string;
};

// COCO-80, the stock YOLOv8n-seg classes. Ids 46-55 are the ten edible ones and
// they happen to be contiguous: banana, apple, sandwich, orange, broccoli,
// carrot, hot dog, pizza, donut, cake.
const COCO = [
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
];

// FoodSeg103 as exported by huggingface.co/magnusdtd/yolov8-foodseg103: 104 ids,
// 0 = background and 1..103 = ingredients. The model only ever saw food, so the
// gate is "anything but background" and this table is purely for the HUD.
const FOODSEG103 = [
  'background', 'candy', 'egg tart', 'french fries', 'chocolate', 'biscuit',
  'popcorn', 'pudding', 'ice cream', 'cheese butter', 'cake', 'wine',
  'milkshake', 'coffee', 'juice', 'milk', 'tea', 'almond', 'red beans',
  'cashew', 'dried cranberries', 'soy', 'walnut', 'peanut', 'egg', 'apple',
  'date', 'apricot', 'avocado', 'banana', 'strawberry', 'cherry', 'blueberry',
  'raspberry', 'mango', 'olives', 'peach', 'lemon', 'pear', 'fig', 'pineapple',
  'grape', 'kiwi', 'melon', 'orange', 'watermelon', 'steak', 'pork',
  'chicken duck', 'sausage', 'fried meat', 'lamb', 'sauce', 'crab', 'fish',
  'shellfish', 'shrimp', 'soup', 'bread', 'corn', 'hamburg', 'pizza',
  'hanamaki baozi', 'wonton dumplings', 'pasta', 'noodles', 'rice', 'pie',
  'tofu', 'eggplant', 'potato', 'garlic', 'cauliflower', 'tomato', 'kelp',
  'seaweed', 'spring onion', 'rape', 'ginger', 'okra', 'lettuce', 'pumpkin',
  'cucumber', 'white radish', 'carrot', 'asparagus', 'bamboo shoots', 'broccoli',
  'celery stick', 'cilantro mint', 'snow peas', 'cabbage', 'bean sprouts',
  'onion', 'pepper', 'green beans', 'French beans', 'king oyster mushroom',
  'shiitake', 'enoki mushroom', 'oyster mushroom', 'white button mushroom',
  'salad', 'other ingredients',
];

export const MODELS: Record<ModelId, ModelSpec> = {
  foodseg103: {
    id: 'foodseg103',
    name: 'FoodSeg103',
    summary: '103 ingredient classes — broad coverage (ramen, sushi, curry…), noisier labels.',
    file: 'models/yolov8-foodseg103.onnx',
    // Measured: 0.15 masks pizza/ramen/sushi while street and desk scenes stay
    // at zero detections — the background class suppresses non-food even here.
    scoreThreshold: 0.15,
    isFood: (id) => id !== 0,
    label: (id) => FOODSEG103[id] ?? `food #${id}`,
  },
  coco: {
    id: 'coco',
    name: 'COCO (10 foods)',
    summary:
      'Precise on pizza, cake, sandwich, donut, hot dog, banana, apple, orange, broccoli, carrot.',
    file: 'models/yolov8n-seg-coco.onnx',
    scoreThreshold: 0.25,
    isFood: (id) => id >= 46 && id <= 55,
    label: (id) => COCO[id] ?? `#${id}`,
  },
};

/** Display order for the popup picker. */
export const MODEL_IDS: ModelId[] = ['foodseg103', 'coco'];

export const DEFAULT_MODEL_ID: ModelId = 'foodseg103';

export function isModelId(v: unknown): v is ModelId {
  return typeof v === 'string' && v in MODELS;
}
