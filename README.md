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
npm run fetch:models   # downloads the FoodSeg103 model to public/models (~14 MB)
npm run build          # outputs the unpacked extension into dist/
```

Prefer the COCO model instead (more precise on its 10 classes, less coverage)?

```bash
MODEL_URL="https://cdn.jsdelivr.net/gh/Hyuto/yolov8-seg-onnxruntime-web@2f404048359f26bc7d00f80e9a6f10e3b19b8ced/public/model/yolov8n-seg.onnx" npm run fetch:models
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

Default is **YOLOv8-seg fine-tuned on FoodSeg103** (104 ingredient classes incl.
background) — [magnusdtd/yolov8-foodseg103](https://huggingface.co/magnusdtd/yolov8-foodseg103).
Every non-background class is food, so the detection pass **doubles as the food
gate** and the mask prototypes give the segmentation. Coverage is far broader
than COCO (ramen, sushi, noodles, rice, curry ingredients, …).

The pipeline reads input size, class count, and prototype dimensions **from the
loaded model**, so any standard YOLOv8-seg export works with no code change:

| Model | Input | Classes | Protos | Food gate |
|---|---|---|---|---|
| FoodSeg103 (default) | 768² | 104 (bg + 103 foods) | 192² | every class but background |
| COCO YOLOv8n-seg | 640² | 80 | 160² | the 10 COCO food classes |

The gate auto-selects by class count (`MODEL.kind: 'auto'` in `config.ts`); force
it with `'coco'` / `'foodseg103'`.

**Accuracy trade-off (measured):** FoodSeg103 spreads confidence across 104
fine-grained classes and generalizes imperfectly to stock photos, so its scores
run lower than COCO's (e.g. it labels a clean pizza faintly and wrongly, ~0.20).
Because masking keys off the detection *region*, not the label, a lower
`scoreThreshold` (default **0.15**) still masks these foods correctly; the model's
background class keeps non-food (tested on a street/bus scene) from triggering
even at low thresholds. Labels in the HUD may be noisy — that's cosmetic. If you
want rock-solid labels on common Western foods and don't need broad coverage, the
COCO export (below) is more precise on its 10 classes.

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

## Swapping in another model

The pipeline reads input size, output names, class count, and prototype
dimensions from the loaded session, so any standard YOLOv8-seg ONNX export drops
in with no code change:

1. Export to ONNX (`yolo export model=your-seg.pt format=onnx imgsz=640 opset=12`)
   or point `MODEL_URL` at a hosted `.onnx`, then `npm run fetch:models` — it is
   always saved as `public/models/food-model.onnx`.
2. The food gate auto-selects by class count. For a fully custom class set, add a
   label table and, if needed, a `FoodPolicy` in `src/offscreen/model.ts`.

If your export's class order differs from the FoodSeg103 list in
`src/offscreen/foodseg103.ts`, HUD labels may be off — cosmetic only, masking is
unaffected.

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
