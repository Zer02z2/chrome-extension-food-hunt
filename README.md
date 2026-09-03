# 🍔 Food Mask

A Manifest V3 Chrome extension that finds food images on any webpage and marks
the food in them with an animated glowing outline — running **entirely
on-device**. No server, no cloud calls, no image ever leaves the browser.

Hover a masked food and an **EAT** button appears; press it and your own head —
cut live out of your webcam with MediaPipe — leans in from the right to take a
bite. Also entirely on-device: the camera stream never leaves the extension's
own frame.

Built with **CRXJS + Vite + TypeScript**, with in-browser inference via
**ONNX Runtime Web** (WebGPU, with a WASM fallback) and **MediaPipe Tasks
Vision** for the head cutout.

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
| **Popup** (`src/popup`) | On/off toggle, **which detection model to use** |
| **Camera frame** (`src/camera`) | Webcam + MediaPipe selfie segmentation → head cutouts, on demand |

Flow for one image:

```
content: IntersectionObserver sees a visible <img>
  → stamp data-foodmask-id, store in Map<id, element>
  → sendMessage(MASK_REQUEST)
service worker: reads sender.tab.id, stores requestId→tabId
  → ensureOffscreen(), forward as OFFSCREEN_JOB + { modelId }
offscreen document: postMessage straight through to the worker
worker: fetch(url) → ImageBitmap (host_permissions dodge CORS taint)
  → runModel(spec, bitmap) → { isFood, labels, detections, protos }   ← pluggable
  → not food? reply and stop
  → food? build mask → cut the food's own pixels out through it
  → reply MASK_RESULT { isFood, overlayPngDataUrl? }
service worker: requestId→tabId → tabs.sendMessage(result)
content: Map.get(imgId) → anchor a canvas over the element, animate the outline
```

### The EAT gag

Every mask carries an invisible button at its centre that fades in on hover.
Pressing it starts a second, independent pipeline:

```
content: EAT clicked
  → HeadStage.mount(): one fixed full-screen canvas + a 1x1 camera <iframe>,
    both inside a closed shadow root
  → MessageChannel: port2 handed to the frame, nonce-checked (see src/shared/head.ts)
  → port.postMessage({ type: 'start' })
camera frame: getUserMedia({ video })  +  ImageSegmenter(selfie_multiclass_256x256)
  → per frame: category mask → keep hair (1) + face-skin (3) = a head
  → tight bbox (EMA-smoothed) → crop the video through the mask
  → transfer the ImageBitmap back over the port
content: every rAF, draw the latest bitmap against the target image's rect:
    height = 1.5 x the food mask's height, parked off its right edge, overlapping
```

Rules that fall out of the design:

- **One head canvas per page, ever.** Pressing EAT on another food re-targets the
  same canvas and the same camera; pressing it again on the food being eaten
  stops the camera and the recording indicator goes out.
- **The head sits one z-index below the masks** (`HEAD_Z` / `LAYER_Z` in
  `src/content/anchor.ts`), so the food always paints over the mouth.
- **The webcam runs in an extension iframe, not in the page.** That keeps the
  MediaPipe wasm under the extension's own CSP, keeps a 30 fps segmenter off the
  page's main thread, and means the raw stream never exists in the page's world —
  only the finished cutout crosses, over a port the page cannot see.
- **First press prompts for the camera** (per site, as any cross-origin frame
  does). Denials are reported in the HUD. `http://` pages cannot grant it at all:
  `getUserMedia` needs a secure context, and a frame inherits that from its
  ancestors.

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
  copy-mediapipe.mjs      copies MediaPipe vision wasm into public/mediapipe (idem)
  fetch-models.mjs        downloads both ONNX models + the selfie model into public/models
offscreen.html            host page for the compute worker (created at runtime)
camera.html               host page for the webcam frame (iframed into the page)
src/
  shared/                 message contract, settings/config, model catalog, head protocol
  content/                discovery, anchoring, scan + outline renderers, EAT button,
                          head stage, HUD
  background/             service-worker router + offscreen lifecycle
  offscreen/
    index.ts              relay: chrome.runtime <-> the worker (~30 lines)
    worker.ts             the pipeline: queue, cache, fetch, orchestration
    model.ts              ORT bootstrap + the shared YOLOv8-seg runner
    mask.ts               verdict + image -> food-cutout PNG overlay
  camera/main.ts          webcam + MediaPipe head segmentation, in its own frame
  popup/                  on/off and model picker
public/
  ort/                    ORT runtime (git-ignored, copied from node_modules)
  mediapipe/              MediaPipe vision wasm (git-ignored, copied from node_modules)
  models/                 *.onnx + *.tflite (git-ignored, fetched)
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
takes the whole image: the only honest reading of a bare boolean.

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
  `cover`/`contain` cropping may have a slightly misaligned outline.
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
- **The head needs a camera and a secure context.** No webcam, a denied prompt,
  or an `http://` page means EAT reports the failure in the HUD and does nothing.
- **The head stage can lose the z-order fight.** It is a page-level fixed canvas
  just under the masks, which is correct unless an image sits inside an ancestor
  that creates its own stacking context with a low `z-index` — then the mask is
  trapped in that context and the head paints over it.
- Runs in the top frame only (`all_frames: false`).
