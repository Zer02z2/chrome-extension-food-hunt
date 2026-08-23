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
npm run fetch:models   # downloads BOTH models to public/models (~28 MB total)
npm run build          # outputs the unpacked extension into dist/
```

Both food-detection models ship side by side and are **switched at runtime from
the popup** — no rebuild. To fetch only one:

```bash
MODEL=foodseg103 npm run fetch:models   # broad coverage (default)
MODEL=coco       npm run fetch:models   # precise on 10 common foods
```

Then load it in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

For development with hot-reload: `npm run dev` (still load `dist/` unpacked; the
content script hot-reloads on save).

> **Models are not committed.** `npm run fetch:models` must be run once after
> cloning. Until it is, the offscreen document reports
> `… weights missing — run npm run fetch:models` and every image comes back "not
> food". If you only fetched one model, selecting the other in the popup produces
> that same error until you fetch it. Override a source with
> `MODEL=<id> MODEL_URL=… npm run fetch:models`.

---

## How it works

Five contexts, each with one job:

| Context | Job |
|---|---|
| **Content script** (`src/content`) | Find images, stamp IDs, request masking, render the returned overlay, show the status HUD |
| **Service worker** (`src/background`) | Router only: guarantee the offscreen doc exists, stamp settings onto jobs, correlate requests |
| **Offscreen document** (`src/offscreen/index.ts`) | A relay. Owns the compute worker and forwards messages to it — nothing else |
| **Compute worker** (`src/offscreen/worker.ts`) | All compute: fetch image → model → mask → overlay |
| **Popup** (`src/popup`) | On/off toggle, blur intensity, **which detection model to use** |

Flow for one image:

```
content: IntersectionObserver sees a visible <img>
  → stamp data-foodmask-id, store in Map<id, element>
  → sendMessage(MASK_REQUEST)
service worker: reads sender.tab.id, stores requestId→tabId
  → ensureOffscreen(), forward as OFFSCREEN_JOB + { modelId, blurPx }
offscreen document: postMessage straight through to the worker
worker: fetch(url) → ImageBitmap (host_permissions dodge CORS taint)
  → runModel(spec, bitmap) → { isFood, labels, detections, protos }   ← pluggable
  → not food? reply and stop
  → food? build mask → composite blurred overlay
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
- **Inference never runs on a main thread.** ORT's wasm backend runs
  synchronously on whichever thread calls it, and every extension page shares one
  renderer process — so calling it from the offscreen document froze the whole
  extension for ~0.7 s per image and the popup could not even open. All compute
  therefore lives in a dedicated `Worker`; the offscreen document exists only to
  own it, because a service worker cannot.
- **The worker has no `chrome.*` APIs.** It is handed the packaged URLs it needs
  (ORT wasm, model weights) in a single `WORKER_INIT` message, and every job
  arrives carrying the settings it should run under, so there is no settings
  state in the worker to drift.
- **Jobs run one at a time.** Inference is CPU-bound and single-threaded;
  overlapping two only makes both slower and delays every result.
- **Images are fetched inside the worker**, so extension
  `host_permissions` grant cross-origin bytes and the `ImageBitmap` is not tainted.
- **Images are tracked by stamped ID**, never DOM index.
- **Overlays cross `sendMessage` as PNG data URLs** (transferables/`ImageBitmap`
  can't be sent).
- **The model is one swappable function.** Classification is the only
  model-specific step; masking, compositing, caching, and messaging are shared.
  See [Adding or swapping a model](#adding-or-swapping-a-model).
- **ORT wasm is bundled locally** (`public/ort`, via `ort.env.wasm.wasmPaths`).
  MV3 forbids remote code, so a CDN would be blocked by the extension CSP.

### The models

Two food-categorization models ship together. The popup switches between them at
runtime; the extension reloads weights lazily and keeps both warm, so flipping
back and forth after the first load is instant.

| Model | Input | Classes | Protos | Food gate | Score floor |
|---|---|---|---|---|---|
| **FoodSeg103** (default) | 768² | 104 (bg + 103 ingredients) | 192² | every class but background | 0.15 |
| **COCO** YOLOv8n-seg | 640² | 80 | 160² | the 10 COCO food classes | 0.25 |

- **FoodSeg103** — [magnusdtd/yolov8-foodseg103](https://huggingface.co/magnusdtd/yolov8-foodseg103),
  fine-tuned on food only, so *every* non-background class is food and the
  detection pass is itself the gate. Far broader coverage than COCO (ramen,
  sushi, noodles, rice, curry ingredients, …).
- **COCO** — stock YOLOv8n-seg. Only ten of its eighty classes are food (pizza,
  cake, sandwich, donut, hot dog, banana, apple, orange, broccoli, carrot), but
  it is markedly more precise and better-labelled on those.

**Accuracy trade-off (measured):** FoodSeg103 spreads confidence across 104
fine-grained classes and generalizes imperfectly to stock photos, so its scores
run lower than COCO's (e.g. it labels a clean pizza faintly and wrongly, ~0.20).
Because masking keys off the detection *region*, not the label, its lower score
floor (**0.15**) still masks these foods correctly, and the model's background
class keeps non-food (tested on a street/bus scene) from triggering even that
low. HUD labels may be noisy — cosmetic only. Pick COCO when you want rock-solid
labels on common Western foods and don't need breadth.

Per-model tuning (weights path, score floor, display name) lives in
`src/shared/models.ts`. Input size, class count, and prototype dimensions are
read from the loaded session, so the 768²/192² and 640²/160² exports above run
through the same code with no branching.

---

## Project layout

```
manifest.config.ts        MV3 manifest (CRXJS)
vite.config.ts            build config (+ plugin that drops the duplicate ORT wasm)
scripts/
  copy-ort.mjs            copies ORT wasm/mjs into public/ort (postinstall/prebuild)
  fetch-models.mjs        downloads both ONNX models into public/models
src/
  shared/                 message contract, settings/config, model catalog
  content/                discovery, overlay renderer, status HUD, orchestrator
  background/             service-worker router + offscreen lifecycle
  offscreen/
    index.ts              relay: chrome.runtime <-> the worker (~30 lines)
    worker.ts             the pipeline: queue, cache, fetch, orchestration
    model.ts              ORT bootstrap + the shared YOLOv8-seg runner
    mask.ts               verdict + image -> blurred PNG overlay
  popup/                  on/off, blur, and model picker
public/
  ort/                    ORT runtime (git-ignored, copied from node_modules)
  models/                 *.onnx (git-ignored, fetched)
```

---

## Adding or swapping a model

The pipeline asks exactly one question — **is this image food?** — and
everything downstream (masking, compositing, caching, messaging, the HUD) is
shared. Adding a model must not add a branch anywhere.

Everything that differs between models is **data**, in one table:

```ts
// src/shared/models.ts
export type ModelSpec = {
  id: ModelId;
  name: string;
  summary: string;
  file: string;                            // weights under public/
  scoreThreshold: number;
  isFood: (classId: number) => boolean;    // the gate
  label: (classId: number) => string;      // cosmetic
};
```

`src/offscreen/model.ts` reads that spec and contains no per-model branches. It
returns a `Verdict` — `{ isFood, labels, detections, protos, letterbox }` —
where `isFood` is the whole contract and the rest is detail for drawing the mask.
A model that cannot localize its answer leaves `protos` null and the overlay step
blurs the whole image: the only honest reading of a bare boolean.

> The runner takes an `ImageBitmap`, not a URL. Fetching happens once in
> `worker.ts` so cross-origin handling, the job queue, the result cache and
> cancellation are implemented once rather than per model.

**Another YOLOv8-seg export** — no new code:

1. `MODEL=coco MODEL_URL=https://…/your-seg.onnx npm run fetch:models`
   (or export your own: `yolo export model=your-seg.pt format=onnx imgsz=640 opset=12`).
2. Adjust that entry's `scoreThreshold` in `src/shared/models.ts` if needed.

Input size is read from the ONNX graph, so 640 and 768 exports both just work.
If your export's class order differs from the tables in `src/shared/models.ts`,
HUD labels may be off — cosmetic only, masking is unaffected.

**A genuinely different architecture** — add the entry to `MODELS` as above, then
give it a runner alongside `runModel` returning the same `Verdict`. Everything
downstream is already shared and the popup picker builds itself from the
catalog.

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
- **Reloading the extension needs a page refresh.** Tabs open at reload time keep
  an orphaned content script until they reload - standard for MV3.
- **Both models stay resident once used.** Switching in the popup loads the new
  weights lazily and keeps the previous session warm (~30 MB for both) so that
  flipping back is instant. Restart the browser to release them.
- **Offscreen lifetime** is currently unbounded for `WORKERS`, but Chrome may add
  idle-closing later. Model load is the only expensive step, so a cold restart is
  cheap.
- Runs in the top frame only (`all_frames: false`).
