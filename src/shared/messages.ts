// Message contract shared by every extension context.
// Distinguish senders by `type`, never by ordering.

import type { ModelId } from './models';

// content -> service worker
export type MaskRequest = {
  type: 'MASK_REQUEST';
  requestId: string; // crypto.randomUUID(), generated in the content script
  imgId: string; // stable id stamped on the element (data-foodmask-id)
  imageUrl: string; // resolved absolute src (currentSrc || src)
};

// service worker -> offscreen -> worker.
//
// A DISTINCT type from MASK_REQUEST is essential: the content script's
// sendMessage is delivered to the offscreen document as well, so the offscreen
// document must only ever act on the service worker's copy. That copy also
// carries the settings, which is why the worker needs no settings state of its
// own.
export type OffscreenJob = {
  type: 'OFFSCREEN_JOB';
  requestId: string;
  imgId: string;
  imageUrl: string;
  modelId: ModelId;
};

// worker -> offscreen -> service worker -> content
export type MaskResult = {
  type: 'MASK_RESULT';
  requestId: string;
  imgId: string;
  isFood: boolean;
  overlayPngDataUrl?: string; // present only when isFood is true
  error?: string; // set when processing failed (treated as "not food" by the page)
};

// content -> service worker -> offscreen -> worker: drop a job that is no longer
// needed (the image left the viewport or was replaced before we got to it).
export type CancelJob = {
  type: 'CANCEL_JOB';
  requestId: string;
  imgId: string;
};

// Settings are not messaged at all. chrome.storage.local is the single source of
// truth: the content script watches it, and the service worker reads it and
// stamps the values onto every OFFSCREEN_JOB, so the worker holds no settings
// state that could drift.

// offscreen document -> its worker, once, with the packaged URLs the worker
// cannot resolve for itself (no chrome.* inside a worker).
export type WorkerInit = {
  type: 'WORKER_INIT';
  ortBaseUrl: string;
  modelUrls: Record<ModelId, string>;
};

type AnyMessage = MaskRequest | OffscreenJob | MaskResult | CancelJob;

const is =
  <T extends AnyMessage>(type: T['type']) =>
  (m: unknown): m is T =>
    !!m && typeof m === 'object' && (m as AnyMessage).type === type;

export const isMaskRequest = is<MaskRequest>('MASK_REQUEST');
export const isOffscreenJob = is<OffscreenJob>('OFFSCREEN_JOB');
export const isMaskResult = is<MaskResult>('MASK_RESULT');
export const isCancelJob = is<CancelJob>('CANCEL_JOB');
