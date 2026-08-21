// Offscreen document — Phase 2 echo stub.
// Listens ONLY for OFFSCREEN_JOB (the SW-routed copy) and replies with a stubbed
// MASK_RESULT. Real classification/segmentation replace this in Phases 3–4.

import { isOffscreenJob, type MaskResult } from '../shared/messages';

console.log('[foodmask][offscreen] loaded');

chrome.runtime.onMessage.addListener((msg) => {
  if (!isOffscreenJob(msg)) return;

  console.log('[foodmask][offscreen] job', msg.imgId, msg.imageUrl);

  const result: MaskResult = {
    type: 'MASK_RESULT',
    requestId: msg.requestId,
    imgId: msg.imgId,
    isFood: false, // stub — no model yet
  };
  chrome.runtime.sendMessage(result).catch((err) => {
    console.warn('[foodmask][offscreen] reply failed', err);
  });
});
