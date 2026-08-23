// Offscreen document: a relay between the service worker and the compute
// worker, and nothing else.
//
// It exists because a service worker cannot own a dedicated Worker and the
// pipeline needs one. Keep this file trivial: anything that runs here runs on
// the renderer main thread that the popup also needs, which is precisely what
// used to freeze the extension.

import { isCancelJob, isOffscreenJob, type WorkerInit } from '../shared/messages';
import { MODELS, type ModelId } from '../shared/models';

console.log('[foodmask][offscreen] loaded');

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

// The worker has no chrome.* APIs of its own, so resolve its URLs here.
const init: WorkerInit = {
  type: 'WORKER_INIT',
  ortBaseUrl: chrome.runtime.getURL('ort/'),
  modelUrls: Object.fromEntries(
    Object.values(MODELS).map((m) => [m.id, chrome.runtime.getURL(m.file)]),
  ) as Record<ModelId, string>,
};
worker.postMessage(init);

worker.onmessage = (e) => {
  chrome.runtime.sendMessage(e.data).catch((err) => {
    console.warn('[foodmask][offscreen] reply failed', err);
  });
};

worker.onerror = (e) => console.error('[foodmask][offscreen] worker error', e.message);

chrome.runtime.onMessage.addListener((msg) => {
  // OFFSCREEN_JOB is deliberately distinct from MASK_REQUEST: the content
  // script's broadcast reaches this document too, and only the copy routed by
  // the service worker carries the settings the worker needs.
  if (isOffscreenJob(msg) || isCancelJob(msg)) worker.postMessage(msg);
});
