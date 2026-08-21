// Turns a food image + binary food mask into the finished RGBA overlay:
// blurred food inside the mask, fully transparent everywhere else. The overlay
// is exported as a PNG data URL for the trip back through the SW (sendMessage
// cannot carry ImageBitmap/transferables).

export async function compositeOverlay(
  bitmap: ImageBitmap,
  maskCanvas: OffscreenCanvas,
  blurPx: number,
): Promise<string> {
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;

  // 1. Draw the whole image blurred.
  ctx.filter = blurPx > 0 ? `blur(${blurPx}px)` : 'none';
  ctx.drawImage(bitmap, 0, 0, w, h);
  ctx.filter = 'none';

  // 2. Keep only the pixels where the mask is opaque (the food).
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';

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
