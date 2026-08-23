// Turns a food verdict plus the original image into the finished overlay:
// blurred food where the model found food, fully transparent everywhere else.
//
// Model-agnostic by construction — it only reads the generic Verdict shape.

import type { Verdict } from './model';

const MASK_THRESHOLD = 0.5; // binarization threshold, after sigmoid

/**
 * Build the overlay PNG for an image the model called food.
 *
 * The mask comes from the instance prototypes when the model localized the
 * food. When it did not — no prototypes, or the projected mask came out empty —
 * the whole image is the only honest reading of a bare "yes", so we blur all of
 * it rather than silently returning nothing.
 */
export async function buildOverlay(
  bitmap: ImageBitmap,
  verdict: Verdict,
  blurPx: number,
): Promise<string> {
  const mask =
    projectMask(verdict) ?? solidCanvas(verdict.letterbox.srcW, verdict.letterbox.srcH);
  return composite(bitmap, mask, blurPx);
}

// Union every instance mask and project it back to original image resolution:
// alpha 255 inside food, 0 elsewhere. Null when there is nothing to project.
function projectMask(verdict: Verdict): OffscreenCanvas | null {
  const { detections, protos, letterbox: lb } = verdict;
  if (!protos || detections.length === 0) return null;

  const { data, ch, h: mh, w: mw } = protos;
  const scale = mw / lb.size; // model px -> proto px
  const union = new Uint8ClampedArray(mw * mh * 4); // RGBA
  let lit = 0;

  for (const det of detections) {
    const bx1 = clampI(det.box[0] * scale, 0, mw);
    const by1 = clampI(det.box[1] * scale, 0, mh);
    const bx2 = clampI(det.box[2] * scale, 0, mw);
    const by2 = clampI(det.box[3] * scale, 0, mh);

    for (let y = by1; y < by2; y++) {
      for (let x = bx1; x < bx2; x++) {
        const base = y * mw + x;
        const pIdx = base * 4;
        if (union[pIdx + 3] === 255) continue; // already set by another instance
        let s = 0;
        for (let k = 0; k < ch; k++) {
          s += det.coeffs[k] * data[k * mh * mw + base];
        }
        if (sigmoid(s) > MASK_THRESHOLD) {
          union[pIdx] = 255;
          union[pIdx + 1] = 255;
          union[pIdx + 2] = 255;
          union[pIdx + 3] = 255;
          lit++;
        }
      }
    }
  }

  // A verdict of "food" whose mask projects to nothing would render as an
  // invisible overlay. Report it as unusable so the caller falls back.
  if (lit === 0) return null;

  // proto union -> upscale to the letterbox square -> crop padding -> original size.
  const protoCanvas = new OffscreenCanvas(mw, mh);
  protoCanvas.getContext('2d')!.putImageData(new ImageData(union, mw, mh), 0, 0);

  const letterCanvas = new OffscreenCanvas(lb.size, lb.size);
  const lctx = letterCanvas.getContext('2d')!;
  lctx.imageSmoothingEnabled = true;
  lctx.drawImage(protoCanvas, 0, 0, lb.size, lb.size);

  const out = new OffscreenCanvas(lb.srcW, lb.srcH);
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  octx.drawImage(
    letterCanvas,
    lb.padX, lb.padY, lb.size - 2 * lb.padX, lb.size - 2 * lb.padY, // crop the gray padding
    0, 0, lb.srcW, lb.srcH,
  );
  return out;
}

function solidCanvas(width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

// The overlay travels back through the service worker, and sendMessage cannot
// carry an ImageBitmap or any transferable — hence a PNG data URL.
async function composite(
  bitmap: ImageBitmap,
  mask: OffscreenCanvas,
  blurPx: number,
): Promise<string> {
  const { width: w, height: h } = bitmap;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;

  // 1. the whole image, blurred
  ctx.filter = blurPx > 0 ? `blur(${blurPx}px)` : 'none';
  ctx.drawImage(bitmap, 0, 0, w, h);
  ctx.filter = 'none';

  // 2. keep only the pixels the mask marks as food
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0, w, h);

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clampI(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
