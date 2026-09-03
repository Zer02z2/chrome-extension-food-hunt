// The camera frame: webcam in, head cutout out.
//
// This document is iframed into the host page by the content script, at 1x1 and
// invisible. It exists for three reasons:
//
//   1. It is an extension page, so the MediaPipe wasm loads under the
//      extension's CSP ('wasm-unsafe-eval') instead of whatever the host page
//      declares, and getUserMedia is attributed to the extension's own frame.
//   2. Its main thread is not the host page's main thread, so a 30 fps
//      segmenter cannot make the page janky.
//   3. The raw webcam stream never enters the host page's world at all — only
//      the finished cutout crosses, over a private MessagePort.
//
// Per frame we run MediaPipe's multiclass selfie segmenter, keep the two
// categories that make up a head (hair and face skin), crop to their bounding
// box and mask the video with it. The result is an ImageBitmap that is exactly
// the head, transferred to the content script, which decides where to draw it.

import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { HEAD_TOKEN_KEY, isHeadHandshake, type HeadCommand, type HeadEvent } from '../shared/head';

// Category ids of selfie_multiclass_256x256, straight out of the labels.txt
// embedded in the weights: 0 background, 1 hair, 2 body-skin, 3 face-skin,
// 4 clothes, 5 others. A head is 1 + 3; body skin (neck, shoulders) and clothes
// are deliberately dropped so the cutout ends at the jaw rather than trailing a
// torso. A lookup table, not a Set: this is read once per mask pixel.
const IS_HEAD = new Uint8Array(256);
IS_HEAD[1] = 1; // hair
IS_HEAD[3] = 1; // face-skin

const CAMERA_W = 640;
const CAMERA_H = 480;

const FRAME_MS = 33; // ~30 fps, paced by timers: rAF is throttled in a 1x1 frame
const MIN_HEAD_PX = 24; // below this the "head" is noise, not a head
const PAD = 0.06; // grow the crop box a little so hair is not shaved off
const SMOOTH = 0.35; // EMA weight on the new box; lower = steadier, laggier
const EDGE_BLUR_PX = 1.2; // feathers the mask so the cutout has no jaggies

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get(HEAD_TOKEN_KEY);

let port: MessagePort | null = null;
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let segmenter: ImageSegmenter | null = null;
let segmenterLoad: Promise<ImageSegmenter> | null = null;

let running = false;
let timer = 0;
let lastStamp = 0;

// Scratch surfaces, reused for the life of the frame.
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
let out: OffscreenCanvas | null = null;
let outCtx: OffscreenCanvasRenderingContext2D | null = null;
let stencil: ImageData | null = null; // reused: a fresh one per frame is ~1 MB of garbage

type Box = { x: number; y: number; w: number; h: number };

// The smoothed crop box, in mask pixels.
let box: Box | null = null;

function send(event: HeadEvent, transfer: Transferable[] = []) {
  port?.postMessage(event, transfer);
}

function fail(message: string) {
  console.warn('[foodmask][camera]', message);
  send({ type: 'error', message });
}

// --- handshake ---------------------------------------------------------------

// First valid port wins and the listener goes away, so a host page that races
// the content script cannot swap itself in afterwards.
function onHandshake(e: MessageEvent) {
  if (!token || port) return;
  if (!isHeadHandshake(e.data) || e.data.token !== token) return;
  const incoming = e.ports[0];
  if (!incoming) return;

  window.removeEventListener('message', onHandshake);
  port = incoming;
  port.onmessage = (m: MessageEvent<HeadCommand>) => {
    if (m.data?.type === 'start') void start();
    else if (m.data?.type === 'stop') stop();
  };
  port.start();
}

window.addEventListener('message', onHandshake);

// --- camera + model ----------------------------------------------------------

async function openCamera(): Promise<HTMLVideoElement> {
  if (video && stream?.active) return video;

  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: CAMERA_W, height: CAMERA_H, facingMode: 'user' },
    audio: false,
  });

  const el = document.createElement('video');
  el.autoplay = true;
  el.muted = true;
  el.playsInline = true;
  el.srcObject = stream;
  await el.play();

  // play() resolves before the first frame has dimensions on some devices.
  if (!el.videoWidth) {
    await new Promise<void>((resolve) => {
      el.addEventListener('loadeddata', () => resolve(), { once: true });
    });
  }

  video = el;
  return el;
}

function loadSegmenter(): Promise<ImageSegmenter> {
  if (segmenterLoad) return segmenterLoad;

  const load = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('mediapipe'));
    const seg = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL('models/selfie_multiclass_256x256.tflite'),
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
    segmenter = seg;
    return seg;
  })();

  // A failed load must not poison the next attempt.
  load.catch(() => {
    if (segmenterLoad === load) segmenterLoad = null;
  });
  segmenterLoad = load;
  return load;
}

async function start() {
  if (running) return;
  running = true;
  send({ type: 'state', state: 'loading' });

  try {
    // The model is ~16 MB and takes a beat; the camera prompt can be answered
    // while it loads.
    await Promise.all([openCamera(), loadSegmenter()]);
    if (!running) return; // stopped while we were waiting
  } catch (err) {
    running = false;
    releaseCamera();
    const name = err instanceof DOMException ? err.name : '';
    fail(
      name === 'NotAllowedError'
        ? 'camera permission denied'
        : name === 'NotFoundError'
          ? 'no camera found'
          : `camera/model failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  box = null;
  send({ type: 'state', state: 'live' });
  tick();
}

function stop() {
  if (!running && !stream) return;
  running = false;
  clearTimeout(timer);
  timer = 0;
  releaseCamera();
  box = null;
  send({ type: 'state', state: 'idle' });
}

// The segmenter is kept loaded — it is the expensive half — but the stream is
// dropped so the tab's recording indicator goes out the moment the gag ends.
function releaseCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video) {
    video.srcObject = null;
    video = null;
  }
}

// --- per-frame work ----------------------------------------------------------

function tick() {
  if (!running) return;
  timer = self.setTimeout(tick, FRAME_MS);

  const v = video;
  const seg = segmenter;
  if (!v || !seg || v.readyState < 2 || !v.videoWidth) return;

  // segmentForVideo rejects a timestamp that does not advance.
  const stamp = Math.max(performance.now(), lastStamp + 1);
  lastStamp = stamp;

  try {
    seg.segmentForVideo(v, stamp, (result) => {
      const mask = result.categoryMask;
      if (mask) emit(v, mask.getAsUint8Array(), mask.width, mask.height);
    });
  } catch (err) {
    fail(`segmentation failed: ${err instanceof Error ? err.message : String(err)}`);
    stop();
  }
}

/** Build the cutout for one frame and ship it. */
function emit(v: HTMLVideoElement, categories: Uint8Array, mw: number, mh: number) {
  if (!maskCtx) return;

  if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
    maskCanvas.width = mw;
    maskCanvas.height = mh;
    stencil = null;
  }
  if (!stencil) stencil = maskCtx.createImageData(mw, mh);

  // One pass over the mask: paint the head white-on-transparent and measure it.
  const px = stencil.data;
  px.fill(0);

  let minX = mw;
  let minY = mh;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0, i = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++, i++) {
      if (!IS_HEAD[categories[i]]) continue;
      const p = i * 4;
      px[p] = 255;
      px[p + 1] = 255;
      px[p + 2] = 255;
      px[p + 3] = 255;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX - minX < MIN_HEAD_PX || maxY - minY < MIN_HEAD_PX) return; // nobody there
  maskCtx.putImageData(stencil, 0, 0);

  const raw = pad({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, mw, mh);
  box = box ? smooth(box, raw) : raw;

  // Whole pixels, or the crop shimmers as the box drifts sub-pixel.
  const bx = Math.round(box.x);
  const by = Math.round(box.y);
  const bw = Math.max(1, Math.round(box.w));
  const bh = Math.max(1, Math.round(box.h));

  if (!out || out.width !== bw || out.height !== bh) {
    out = new OffscreenCanvas(bw, bh);
    outCtx = out.getContext('2d');
  }
  if (!outCtx) return;

  // The mask comes back at the input resolution, but say so explicitly rather
  // than assuming it: map the box into video pixels before sampling.
  const kx = v.videoWidth / mw;
  const ky = v.videoHeight / mh;

  outCtx.globalCompositeOperation = 'source-over';
  outCtx.filter = 'none';
  outCtx.clearRect(0, 0, bw, bh);
  outCtx.drawImage(v, bx * kx, by * ky, bw * kx, bh * ky, 0, 0, bw, bh);

  // Punch everything outside the head away, feathering the border.
  outCtx.globalCompositeOperation = 'destination-in';
  outCtx.filter = `blur(${EDGE_BLUR_PX}px)`;
  outCtx.drawImage(maskCanvas, bx, by, bw, bh, 0, 0, bw, bh);
  outCtx.filter = 'none';
  outCtx.globalCompositeOperation = 'source-over';

  const bitmap = out.transferToImageBitmap();
  send({ type: 'frame', bitmap }, [bitmap]);
}

function pad(b: Box, mw: number, mh: number): Box {
  const dx = b.w * PAD;
  const dy = b.h * PAD;
  const x = Math.max(0, b.x - dx);
  const y = Math.max(0, b.y - dy);
  return {
    x,
    y,
    w: Math.min(mw - x, b.w + dx * 2),
    h: Math.min(mh - y, b.h + dy * 2),
  };
}

// Raw per-frame boxes jitter by a few pixels, which reads as the head pulsing
// once it is scaled up over an image. Ease towards the new box instead.
function smooth(prev: Box, next: Box): Box {
  return {
    x: prev.x + (next.x - prev.x) * SMOOTH,
    y: prev.y + (next.y - prev.y) * SMOOTH,
    w: prev.w + (next.w - prev.w) * SMOOTH,
    h: prev.h + (next.h - prev.h) * SMOOTH,
  };
}

window.addEventListener('pagehide', () => stop());
