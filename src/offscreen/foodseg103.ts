// FoodSeg103 class names. The canonical dataset defines 104 ids: id 0 is
// "background", ids 1..103 are food ingredients. Used for HUD labels and to
// detect/skip a background class if the model emits one.
//
// Backs food-specialized YOLOv8-seg exports such as
// https://huggingface.co/magnusdtd/yolov8-foodseg103 (104 classes, incl.
// background). Some exports drop background and have 103 classes; the model
// wrapper handles both. If labels look off by one for your export, adjust here —
// it is cosmetic and does not affect masking.

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
