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

Four contexts, each with one job:

| Context | Job |
|---|---|
| **Content script** (`src/content`) | Find images, stamp IDs, request masking, render the returned overlay, show the status HUD |
| **Service worker** (`src/background`) | Router only: guarantee the offscreen doc exists, correlate requests, route messages |
| **Offscreen document** (`src/offscreen`) | All compute: fetch image → classify → segment → composite the overlay |
| **Popup** (`src/popup`) | On/off toggle, blur intensity, **which detection model to use** |

Flow for one image:

```
content: IntersectionObserver sees a visible <img>
  → stamp data-foodmask-id, store in Map<id, element>
  → sendMessage(MASK_REQUEST)
service worker: reads sender.tab.id, stores requestId→tabId
  → ensureOffscreen(), forward as OFFSCREEN_JOB
offscreen: fetch(url) → ImageBitmap (host_permissions dodge CORS taint)
  → classifier.classify(bitmap) → { isFood, labels, segmentation? }   ← pluggable
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
- **The offscreen document has no `chrome.storage`.** Offscreen documents are
  limited to `chrome.runtime` and the messaging APIs; other namespaces are
  `undefined` there *even though the manifest requests the permission*. So the
  offscreen document never reads settings itself — it asks the service worker
  for them on boot (`SETTINGS_REQUEST`) and then receives the popup's
  `SETTINGS_CHANGED` broadcasts directly. Anything else needing an extension API
  from that context must be brokered the same way.
- **Images are fetched inside the offscreen document**, so extension
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
    classifiers/          ← the pluggable seam: one impl per model
      types.ts              FoodClassifier contract (image -> is-it-food)
      yolo-seg.ts           shared YOLOv8-seg engine (forward, decode, NMS)
      coco.ts               COCO-80 labels + 10-food policy
      foodseg103.ts         FoodSeg103 labels + all-but-background policy
      index.ts              ModelId -> warm classifier registry
    runtime.ts            ORT bootstrap (WebGPU -> WASM)
    preprocess.ts         letterbox + NCHW tensor
    mask.ts               verdict -> binary mask at original resolution
    composite.ts          mask + blur -> PNG overlay
    pipeline.ts           model-agnostic orchestration
  popup/                  on/off, blur, and model picker
public/
  ort/                    ORT runtime (git-ignored, copied from node_modules)
  models/                 *.onnx (git-ignored, fetched)
```

---

## Adding or swapping a model

The pipeline asks a classifier exactly one question — **is this image food?** —
and everything downstream (masking, compositing, caching, messaging, the HUD) is
shared. That one call is the only model-specific line in `pipeline.ts`:

```ts
// src/offscreen/classifiers/types.ts
export interface FoodClassifier {
  load(): Promise<void>;
  classify(bitmap: ImageBitmap): Promise<FoodVerdict>;  // { isFood, labels, segmentation? }
}
```

`segmentation` is an optional by-product, not part of the contract. Both shipped
models are YOLOv8-seg and produce instance masks in the *same* forward pass that
yields the verdict, so discarding them and re-running a segmenter would double
the cost for nothing. A pure classifier (say a MobileNet food/not-food head)
simply omits it and the pipeline blurs the whole image instead — the only honest
reading of a bare boolean.

> The classifier takes an `ImageBitmap`, not a URL. Fetching happens once in
> `pipeline.ts` so that cross-origin handling, the concurrency gate, the result
> cache, and cancellation are implemented once rather than per model.

**Another YOLOv8-seg export** — no new code:

1. `MODEL=coco MODEL_URL=https://…/your-seg.onnx npm run fetch:models`
   (or export your own: `yolo export model=your-seg.pt format=onnx imgsz=640 opset=12`).
2. Adjust that entry's `scoreThreshold` in `src/shared/models.ts` if needed.

If your export's class order differs from the tables in
`src/offscreen/classifiers/`, HUD labels may be off — cosmetic only, masking is
unaffected.

**A genuinely different model** — three small steps, none of them in the pipeline:

1. Add an entry to `MODELS` in `src/shared/models.ts` (the popup picker builds
   itself from this catalog).
2. Implement `FoodClassifier` in `src/offscreen/classifiers/`.
3. Register the factory in `src/offscreen/classifiers/index.ts`.

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
- **Both models stay resident once used.** Switching in the popup loads the new
  weights lazily and keeps the previous session warm (~30 MB for both) so that
  flipping back is instant. Restart the browser to release them.
- **Offscreen lifetime** is currently unbounded for `WORKERS`, but Chrome may add
  idle-closing later. Model load is the only expensive step, so a cold restart is
  cheap.
- Runs in the top frame only (`all_frames: false`).
