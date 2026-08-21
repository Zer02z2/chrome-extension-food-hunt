# 🍔 Food Mask

A Manifest V3 Chrome extension that finds food images on any webpage and masks
(blurs) the food in them — running **entirely on-device**. No server, no cloud
calls, no image ever leaves the browser.

Built with **CRXJS + Vite + TypeScript**, with in-browser inference via
**ONNX Runtime Web** (WebGPU, with a WASM fallback).

---

## Quick start

```bash
npm install            # also copies ORT wasm into public/ort (postinstall)
npm run fetch:models   # downloads YOLOv8n-seg.onnx into public/models (~13 MB)
npm run build          # outputs the unpacked extension into dist/
```

Then load it in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

For development with hot-reload: `npm run dev` (still load `dist/` unpacked; the
content script hot-reloads on save).

> **Models are not committed.** `npm run fetch:models` must be run once after
> cloning. Until it is, the offscreen document logs a model-load error and every
> image is reported as "not food". Override the source with
> `MODEL_URL=… npm run fetch:models`, or drop your own `public/models/yolov8n-seg.onnx`.

---

## How it works

Four contexts, each with one job:

| Context | Job |
|---|---|
| **Content script** (`src/content`) | Find images, stamp IDs, request masking, render the returned overlay, show the status HUD |
| **Service worker** (`src/background`) | Router only: guarantee the offscreen doc exists, correlate requests, route messages |
| **Offscreen document** (`src/offscreen`) | All compute: fetch image → classify → segment → composite the overlay |
| **Popup** (`src/popup`) | On/off toggle + blur intensity |

Flow for one image:

```
content: IntersectionObserver sees a visible <img>
  → stamp data-foodmask-id, store in Map<id, element>
  → sendMessage(MASK_REQUEST)
service worker: reads sender.tab.id, stores requestId→tabId
  → ensureOffscreen(), forward as OFFSCREEN_JOB
offscreen: fetch(url) → ImageBitmap (host_permissions dodge CORS taint)
  → YOLOv8n-seg forward pass
  → any food-class detection? → build union mask → composite blurred overlay
  → reply MASK_RESULT { isFood, overlayPngDataUrl? }
service worker: requestId→tabId → tabs.sendMessage(result)
content: Map.get(imgId) → position overlay <img> over the element
```

### Key design decisions

- **The service worker holds no models and does no compute.** It dies after ~30s
  idle and has no WebGPU/DOM. It is a disposable router. All models live in the
  offscreen document, created with `reasons: ['WORKERS']` (never `AUDIO_PLAYBACK`,
  which self-closes).
- **Only one offscreen document exists.** Creation is guarded with
  `chrome.runtime.getContexts` and serialized behind a single promise to survive
  the concurrent-create race.
- **Images are fetched inside the offscreen document**, so extension
  `host_permissions` grant cross-origin bytes and the `ImageBitmap` is not tainted.
- **Images are tracked by stamped ID**, never DOM index.
- **Overlays cross `sendMessage` as PNG data URLs** (transferables/`ImageBitmap`
  can't be sent).
- **ORT wasm is bundled locally** (`public/ort`, via `ort.env.wasm.wasmPaths`).
  MV3 forbids remote code, so a CDN would be blocked by the extension CSP.

### The model

Default is stock **YOLOv8n-seg (COCO)**. COCO already includes several food
classes — pizza, cake, sandwich, donut, hot dog, banana, apple, orange, broccoli,
carrot — so the detection pass **doubles as the food gate** and the mask
prototypes give the segmentation. See `src/offscreen/coco.ts` for the food-class
set and `src/offscreen/model.ts` for the decode.

---

## Project layout

```
manifest.config.ts        MV3 manifest (CRXJS)
vite.config.ts            build config (+ plugin that drops the duplicate ORT wasm)
scripts/
  copy-ort.mjs            copies ORT wasm/mjs into public/ort (postinstall/prebuild)
  fetch-models.mjs        downloads the ONNX model into public/models
src/
  shared/                 message contract + settings/config
  content/                discovery, overlay renderer, status HUD, orchestrator
  background/             service-worker router + offscreen lifecycle
  offscreen/              ORT runtime, preprocess, model, composite, pipeline
  popup/                  on/off + blur UI
public/
  ort/                    ORT runtime (git-ignored, copied from node_modules)
  models/                 *.onnx (git-ignored, fetched)
```

---

## Swapping in a better model (out-of-session upgrade)

The pipeline is model-agnostic by design. To widen food coverage:

1. Fine-tune `YOLO11n-seg` / `YOLOv8n-seg` on **FoodSeg103** (or UEC-FoodPix),
   export to ONNX at 640×640, opset 12.
2. Drop it in as `public/models/yolov8n-seg.onnx` (or point `MODEL_URL` at it).
3. If the class layout changes, update `COCO_CLASSES` / `FOOD_CLASS_IDS` in
   `src/offscreen/coco.ts`. No pipeline changes needed — the model wrapper reads
   input/output names from the session at runtime.

---

## Known limitations

- **Only `http(s)` `<img>` sources.** `blob:` / `data:` images and CSS
  `background-image` foods are not handled in this MVP (noted at discovery time).
- **`object-fit: cover/contain` misalignment.** Overlays are stretched to the
  image's rendered box (`object-fit: fill` assumption). Images displayed with
  `cover`/`contain` cropping may have a slightly misaligned mask.
- **WebGPU availability varies.** The WASM fallback is slower. The active provider
  is logged from the offscreen document (`provider=webgpu|wasm`).
- **In-flight inference isn't abortable.** Cancellation drops still-queued jobs;
  a job already running finishes, but its result is discarded by the page.
- **Offscreen lifetime** is currently unbounded for `WORKERS`, but Chrome may add
  idle-closing later. Model load is the only expensive step, so a cold restart is
  cheap.
- Runs in the top frame only (`all_frames: false`).
