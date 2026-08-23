// Downloads the ONNX weights the offscreen document needs into public/models/.
// These are large binaries that must NOT be committed (see .gitignore); fetch
// them once after cloning.
//
// Both food-categorization models ship side by side and are switchable at
// runtime from the extension popup, so by default BOTH are downloaded:
//
//   yolov8-foodseg103.onnx   YOLOv8-seg fine-tuned on FoodSeg103 — 103 food
//                            ingredient classes, broad coverage (default model)
//                            https://huggingface.co/magnusdtd/yolov8-foodseg103
//   yolov8n-seg-coco.onnx    Stock YOLOv8n-seg (COCO) — 10 food classes,
//                            precise on what it knows
//
// Filenames must match `file` in src/shared/models.ts.
//
// Usage:
//   npm run fetch:models                          # both
//   MODEL=coco npm run fetch:models               # just one
//   MODEL=foodseg103 MODEL_URL=https://…/my.onnx npm run fetch:models
//                                                 # replace one slot's source

import { existsSync, mkdirSync, createWriteStream, statSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dest = join(root, 'public', 'models');

// Standard ultralytics YOLOv8-seg exports: input images[1,3,N,N]; outputs
// output0[1, 4+numClasses+protoCh, numAnchors] and output1[1,protoCh,H,W]
// (mask prototypes). The decode reads class count, input size, and output names
// from the session, so any standard YOLOv8-seg export works in either slot.
const MODELS = {
  foodseg103: {
    file: 'yolov8-foodseg103.onnx',
    url: 'https://huggingface.co/magnusdtd/yolov8-foodseg103/resolve/main/yolov8_foodseg103.onnx',
    manual:
      'Download yolov8_foodseg103.onnx from https://huggingface.co/magnusdtd/yolov8-foodseg103',
  },
  coco: {
    file: 'yolov8n-seg-coco.onnx',
    // Pinned to a commit for reproducibility.
    url: 'https://cdn.jsdelivr.net/gh/Hyuto/yolov8-seg-onnxruntime-web@2f404048359f26bc7d00f80e9a6f10e3b19b8ced/public/model/yolov8n-seg.onnx',
    manual:
      'pip install ultralytics && yolo export model=yolov8n-seg.pt format=onnx imgsz=640 opset=12',
  },
};

const MIN_BYTES = 1_000_000;

function selected() {
  const which = process.env.MODEL;
  if (!which || which === 'all') return Object.keys(MODELS);
  if (!MODELS[which]) {
    throw new Error(`Unknown MODEL="${which}". Expected one of: ${Object.keys(MODELS).join(', ')}, all`);
  }
  return [which];
}

// Earlier versions saved a single model as food-model.onnx. Reuse it instead of
// re-downloading ~14 MB — but only after confirming which model it actually is,
// since that filename was also used for MODEL_URL overrides.
function migrateLegacyFile() {
  const legacy = join(dest, 'food-model.onnx');
  if (!existsSync(legacy) || statSync(legacy).size < MIN_BYTES) return;

  // Ultralytics embeds its class-name map in the ONNX metadata, so the weights
  // identify themselves.
  const head = readFileSync(legacy);
  const id = head.includes('hanamaki baozi')
    ? 'foodseg103'
    : head.includes('hair drier')
      ? 'coco'
      : null;

  if (!id) {
    console.log(
      '[fetch-models] Found legacy food-model.onnx but could not identify it; leaving it alone.',
    );
    return;
  }

  const target = join(dest, MODELS[id].file);
  if (existsSync(target)) return;
  renameSync(legacy, target);
  console.log(`[fetch-models] Migrated legacy food-model.onnx -> ${MODELS[id].file} (${id})`);
}

async function fetchOne(id) {
  const spec = MODELS[id];
  const outFile = join(dest, spec.file);

  if (existsSync(outFile) && statSync(outFile).size > MIN_BYTES) {
    console.log(`[fetch-models] ${id}: already present (${mb(outFile)} MB). Skipping.`);
    return;
  }

  // MODEL_URL overrides the source; with several models selected it would be
  // ambiguous which one it replaces, so require MODEL to name the slot.
  const override = process.env.MODEL_URL;
  if (override && !process.env.MODEL) {
    throw new Error('MODEL_URL requires MODEL=<id> so it is clear which model it replaces.');
  }
  const url = override || spec.url;

  console.log(`[fetch-models] ${id}: downloading\n  ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed for ${id}: HTTP ${res.status} ${res.statusText}`);
  }

  await new Promise((resolve, reject) => {
    const stream = createWriteStream(outFile);
    Readable.fromWeb(res.body).pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  const size = statSync(outFile).size;
  if (size < MIN_BYTES) {
    throw new Error(
      `${id}: downloaded file is only ${size} bytes — the URL likely returned an error page, not a model.`,
    );
  }
  console.log(`[fetch-models] ${id}: saved ${outFile} (${mb(outFile)} MB)`);
}

async function main() {
  mkdirSync(dest, { recursive: true });
  migrateLegacyFile();
  for (const id of selected()) {
    await fetchOne(id);
  }
}

function mb(f) {
  return (statSync(f).size / 1_048_576).toFixed(1);
}

main().catch((err) => {
  console.error('[fetch-models] ERROR:', err.message);
  console.error(
    '\nCould not download automatically. Provide the weights manually instead:\n' +
      Object.entries(MODELS)
        .map(([id, m]) => `  ${id}: ${m.manual}\n         -> save as public/models/${m.file}`)
        .join('\n') +
      '\nOr set MODEL=<id> MODEL_URL=<reachable .onnx> and re-run `npm run fetch:models`.',
  );
  process.exit(1);
});
