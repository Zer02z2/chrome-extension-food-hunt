// Letterbox an ImageBitmap into the model's square input and produce an NCHW
// float32 tensor. The letterbox parameters are returned so detections and masks
// can be mapped back to original image coordinates.

import { PIPELINE } from '../shared/config';

export type Letterbox = {
  size: number; // square model input (e.g. 640)
  ratio: number; // scale applied to the original image
  padX: number; // left/right padding in model pixels
  padY: number; // top/bottom padding in model pixels
  srcW: number;
  srcH: number;
};

export type Preprocessed = {
  data: Float32Array; // NCHW, RGB, normalized 0..1, length 3*size*size
  letterbox: Letterbox;
};

const PAD_VALUE = 114; // standard YOLO gray padding

export function preprocess(bitmap: ImageBitmap): Preprocessed {
  const size = PIPELINE.modelInputSize;
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const ratio = Math.min(size / srcW, size / srcH);
  const newW = Math.round(srcW * ratio);
  const newH = Math.round(srcH * ratio);
  const padX = (size - newW) / 2;
  const padY = (size - newH) / 2;

  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`;
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, padX, padY, newW, newH);

  const { data: rgba } = ctx.getImageData(0, 0, size, size);
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const r = rgba[i * 4] / 255;
    const g = rgba[i * 4 + 1] / 255;
    const b = rgba[i * 4 + 2] / 255;
    out[i] = r; // R plane
    out[plane + i] = g; // G plane
    out[2 * plane + i] = b; // B plane
  }

  return {
    data: out,
    letterbox: { size, ratio, padX, padY, srcW, srcH },
  };
}
