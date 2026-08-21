// Downloads the ONNX model(s) the offscreen document needs into public/models/.
// These are large binaries that must NOT be committed (see .gitignore); fetch
// them once after cloning.
//
// Default: YOLOv8n-seg (COCO) exported to ONNX at 640x640. COCO already includes
// several food classes (pizza, cake, sandwich, donut, hot dog, banana, apple,
// orange, broccoli, carrot). The detection pass doubles as the food gate; the
// mask prototypes give the segmentation.
//
// Override the source with MODEL_URL if you host your own export:
//   MODEL_URL=https://example.com/yolov8n-seg.onnx npm run fetch:models

import { existsSync, mkdirSync, createWriteStream, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dest = join(root, 'public', 'models');
const outFile = join(dest, 'yolov8n-seg.onnx');

const MODEL_URL =
  process.env.MODEL_URL ||
  'https://huggingface.co/onnx-community/yolov8n-seg/resolve/main/onnx/model.onnx';

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
      '  1. pip install ultralytics\n' +
      "  2. yolo export model=yolov8n-seg.pt format=onnx imgsz=640 opset=12\n" +
      '  3. mv yolov8n-seg.onnx public/models/\n' +
      'Or set MODEL_URL to a reachable .onnx and re-run `npm run fetch:models`.',
  );
  process.exit(1);
});
