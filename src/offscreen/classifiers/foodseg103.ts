// FoodSeg103 class policy. The canonical dataset defines 104 ids: id 0 is
// "background", ids 1..103 are food ingredients. Because the model is trained on
// food only, EVERY non-background class counts as food — the gate is trivial and
// the label table exists purely for the HUD.
//
// Backs food-specialized YOLOv8-seg exports such as
// https://huggingface.co/magnusdtd/yolov8-foodseg103 (104 classes, incl.
// background). Some exports drop background and have 103 classes; the policy
// below handles both. If labels look off by one for your export, adjust here —
// it is cosmetic and does not affect masking.

import type { ClassPolicy } from './yolo-seg';

export const FOODSEG103_WITH_BG = [
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
] as const;

export const FOODSEG103_BACKGROUND_ID = 0;

// Every class is food, except a background class if the export includes one
// (104 ids => background at 0; 103 ids => no background, labels shift by one).
export function foodSegPolicy(numClasses: number): ClassPolicy {
  const hasBackground = numClasses >= FOODSEG103_WITH_BG.length;
  return {
    isFood: (id) => !(hasBackground && id === FOODSEG103_BACKGROUND_ID),
    label: (id) =>
      hasBackground
        ? (FOODSEG103_WITH_BG[id] ?? `food #${id}`)
        : (FOODSEG103_WITH_BG[id + 1] ?? `food #${id}`), // no bg => shift past it
  };
}
