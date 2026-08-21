// Downloads the ONNX model the offscreen document needs into public/models/.
// This is a large binary that must NOT be committed (see .gitignore); fetch it
// once after cloning. Always saved as public/models/food-model.onnx (matches
// MODEL.path in src/shared/config.ts).
//
// Default: YOLOv8-seg fine-tuned on FoodSeg103 (103 food ingredient classes) —
// far broader food coverage than stock COCO. Same architecture, so the pipeline
// is unchanged; every class counts as food.
//   Source: https://huggingface.co/magnusdtd/yolov8-foodseg103
//
// Alternatives (override with MODEL_URL):
//   COCO YOLOv8n-seg (10 food classes; sandbox-validated fallback):
//     MODEL_URL=https://cdn.jsdelivr.net/gh/Hyuto/yolov8-seg-onnxruntime-web@2f404048359f26bc7d00f80e9a6f10e3b19b8ced/public/model/yolov8n-seg.onnx npm run fetch:models
//   Your own export:
//     MODEL_URL=https://example.com/your-yolov8-seg.onnx npm run fetch:models

import { existsSync, mkdirSync, createWriteStream, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dest = join(root, 'public', 'models');
const outFile = join(dest, 'food-model.onnx');

// FoodSeg103-fine-tuned YOLOv8-seg. Standard ultralytics export:
// input images[1,3,640,640]; output0[1, 4+numClasses+32, 8400] and
// output1[1,32,160,160] (mask prototypes). The decode reads class count and
// output names from the session, so any standard YOLOv8-seg export works.
const MODEL_URL =
  process.env.MODEL_URL ||
  'https://huggingface.co/magnusdtd/yolov8-foodseg103/resolve/main/yolov8_foodseg103.onnx';

async function main() {
  mkdirSync(dest, { recursive: true });

  if (existsSync(outFile) && statSync(outFile).size > 1_000_000) {
    console.log(`[fetch-models] Already present: ${outFile} (${mb(outFile)} MB). Skipping.`);
    return;
  }

  console.log(`[fetch-models] Downloading model from:\n  ${MODEL_URL}`);
  const res = await fetch(MODEL_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }

  await new Promise((resolve, reject) => {
    const stream = createWriteStream(outFile);
    Readable.fromWeb(res.body).pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  const size = statSync(outFile).size;
  if (size < 1_000_000) {
    throw new Error(
      `Downloaded file is only ${size} bytes — the URL likely returned an error page, not a model.`,
    );
  }
  console.log(`[fetch-models] Saved ${outFile} (${mb(outFile)} MB)`);
}

function mb(f) {
  return (statSync(f).size / 1_048_576).toFixed(1);
}

main().catch((err) => {
  console.error('[fetch-models] ERROR:', err.message);
  console.error(
    '\nCould not download automatically. Provide a model manually instead:\n' +
      '  1. Download from https://huggingface.co/magnusdtd/yolov8-foodseg103 (yolov8_foodseg103.onnx)\n' +
      '     or export your own: pip install ultralytics &&\n' +
      '       yolo export model=your-food-seg.pt format=onnx imgsz=640 opset=12\n' +
      '  2. Save it as public/models/food-model.onnx\n' +
      'Or set MODEL_URL to a reachable .onnx and re-run `npm run fetch:models`.',
  );
  process.exit(1);
});
