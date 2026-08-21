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
// A DISTINCT type (not MASK_REQUEST) is essential: chrome.runtime.sendMessage
// from the content script is also delivered to the offscreen document, so the
// offscreen must only ever act on OFFSCREEN_JOB — the SW-routed copy — and
// ignore the raw content broadcast.
export type OffscreenJob = {
  type: 'OFFSCREEN_JOB';
  requestId: string;
  imgId: string;
  imageUrl: string;
  naturalWidth: number;
  naturalHeight: number;
};

// Content -> SW -> offscreen: drop a job that is no longer needed (image left
// the viewport or was removed before processing finished).
export type CancelJob = {
  type: 'CANCEL_JOB';
  requestId: string;
  imgId: string;
};

export type AnyMessage =
  | MaskRequest
  | MaskResult
  | SettingsChanged
  | OffscreenJob
  | CancelJob;

export function isOffscreenJob(m: unknown): m is OffscreenJob {
  return !!m && typeof m === 'object' && (m as AnyMessage).type === 'OFFSCREEN_JOB';
}

export function isMaskRequest(m: unknown): m is MaskRequest {
  return !!m && typeof m === 'object' && (m as AnyMessage).type === 'MASK_REQUEST';
}

export function isMaskResult(m: unknown): m is MaskResult {
  return !!m && typeof m === 'object' && (m as AnyMessage).type === 'MASK_RESULT';
}

export function isSettingsChanged(m: unknown): m is SettingsChanged {
  return !!m && typeof m === 'object' && (m as AnyMessage).type === 'SETTINGS_CHANGED';
}

export function isCancelJob(m: unknown): m is CancelJob {
  return !!m && typeof m === 'object' && (m as AnyMessage).type === 'CANCEL_JOB';
}
