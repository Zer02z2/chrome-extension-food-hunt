// Turns a classifier's verdict into a binary food mask at ORIGINAL image
// resolution: alpha 255 inside food, 0 elsewhere. Shared by every model — this
// step is deliberately model-agnostic, it only consumes the generic
// Segmentation shape (or nothing at all).

import { PIPELINE } from '../shared/config';
import type { Letterbox } from './preprocess';
import type { Detection, Protos } from './classifiers/types';

// Build the union of instance masks. Returns null when there is nothing to
// project (no prototypes, or no surviving detections).
export function buildFoodMaskCanvas(
  detections: Detection[],
  protos: Protos | null,
  lb: Letterbox,
): OffscreenCanvas | null {
  if (!protos || detections.length === 0) return null;

  const { data, ch, h: mh, w: mw } = protos;
  const scale = mw / lb.size; // model px -> proto px
  const union = new Uint8ClampedArray(mw * mh * 4); // RGBA

  for (const det of detections) {
    const bx1 = clampI(det.box[0] * scale, 0, mw);
    const by1 = clampI(det.box[1] * scale, 0, mh);
    const bx2 = clampI(det.box[2] * scale, 0, mw);
    const by2 = clampI(det.box[3] * scale, 0, mh);

    for (let y = by1; y < by2; y++) {
      for (let x = bx1; x < bx2; x++) {
        const pIdx = (y * mw + x) * 4;
        if (union[pIdx + 3] === 255) continue; // already set by another instance
        let s = 0;
        const base = y * mw + x;
        for (let k = 0; k < ch; k++) {
          s += det.coeffs[k] * data[k * mh * mw + base];
        }
        if (sigmoid(s) > PIPELINE.maskThreshold) {
          union[pIdx] = 255;
          union[pIdx + 1] = 255;
          union[pIdx + 2] = 255;
          union[pIdx + 3] = 255;
        }
      }
    }
  }

  // proto union -> upscale to the letterbox square -> crop padding -> original size.
  const protoCanvas = new OffscreenCanvas(mw, mh);
  protoCanvas.getContext('2d')!.putImageData(new ImageData(union, mw, mh), 0, 0);

  const letterCanvas = new OffscreenCanvas(lb.size, lb.size);
  const lctx = letterCanvas.getContext('2d')!;
  lctx.imageSmoothingEnabled = true;
  lctx.drawImage(protoCanvas, 0, 0, lb.size, lb.size);

  const newW = lb.size - 2 * lb.padX;
  const newH = lb.size - 2 * lb.padY;
  const origCanvas = new OffscreenCanvas(lb.srcW, lb.srcH);
  const octx = origCanvas.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  octx.drawImage(
    letterCanvas,
    lb.padX, lb.padY, newW, newH, // src crop (remove gray padding)
    0, 0, lb.srcW, lb.srcH, // dest (full original)
  );

  return origCanvas;
}

// Fallback for a classifier that answers "food" without saying where. Masks the
// entire image, which is the only honest reading of a bare boolean.
export function wholeImageMaskCanvas(width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clampI(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
