// Message contract shared by every extension context.
// Distinguish senders by `type`, never by ordering.

export type MaskRequest = {
  type: 'MASK_REQUEST';
  requestId: string; // crypto.randomUUID(), generated in the content script
  imgId: string; // stable id stamped on the element (data-foodmask-id)
  imageUrl: string; // resolved absolute src (currentSrc || src)
  naturalWidth: number;
  naturalHeight: number;
};

export type MaskResult = {
  type: 'MASK_RESULT';
  requestId: string;
  imgId: string;
  isFood: boolean;
  overlayPngDataUrl?: string; // present only when isFood is true
  error?: string; // set when processing failed (treated as "not food" by the page)
};

// Fired by content -> service worker -> content is not needed; the SW just routes.
// Popup <-> content/offscreen use SETTINGS_CHANGED broadcast.
export type SettingsChanged = {
  type: 'SETTINGS_CHANGED';
  enabled: boolean;
  blurPx: number;
};

// Sent from the service worker to the offscreen document to forward a job.
export type OffscreenJob = MaskRequest & {
  // no extra fields today; kept as an alias so the routing intent is explicit
};

export type AnyMessage = MaskRequest | MaskResult | SettingsChanged;

export function isMaskRequest(m: unknown): m is MaskRequest {
  return !!m && typeof m === 'object' && (m as AnyMessage).type === 'MASK_REQUEST';
}

export function isMaskResult(m: unknown): m is MaskResult {
  return !!m && typeof m === 'object' && (m as AnyMessage).type === 'MASK_RESULT';
}

export function isSettingsChanged(m: unknown): m is SettingsChanged {
  return !!m && typeof m === 'object' && (m as AnyMessage).type === 'SETTINGS_CHANGED';
}
