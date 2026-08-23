// Offscreen document entry point. Owns the persistent inference pipeline and
// replies to SW-routed jobs. All heavy compute (Canvas, WebGPU, ONNX) lives here.

import { Pipeline } from './pipeline';
import { isOffscreenJob, isSettingsChanged, isCancelJob } from './../shared/messages';
import { storageUnavailableReason, watchSettings } from '../shared/config';
import { modelSpec } from '../shared/models';

console.log('[foodmask][offscreen] loaded');

// Surface a dead/incomplete extension context once, by name, instead of letting
// it resurface as an anonymous "Cannot read properties of undefined".
const storageProblem = storageUnavailableReason();
if (storageProblem) {
  console.warn(`[foodmask][offscreen] ${storageProblem} — running with default settings`);
}

const pipeline = new Pipeline();
const initDone = pipeline
  .init()
  .then(() =>
    console.log(
      `[foodmask][offscreen] pipeline ready, model=${modelSpec(pipeline.modelId).name}, provider=${pipeline.provider}`,
    ),
  )
  .catch((err) => console.error('[foodmask][offscreen] init failed', err));

chrome.runtime.onMessage.addListener((msg) => {
  if (isSettingsChanged(msg)) {
    pipeline.updateSettings({
      enabled: msg.enabled,
      blurPx: msg.blurPx,
      modelId: msg.modelId,
    });
    return;
  }

  if (isCancelJob(msg)) {
    pipeline.cancel(msg.requestId);
    return;
  }

  if (isOffscreenJob(msg)) {
    void (async () => {
      await initDone;
      const result = await pipeline.process(msg);
      chrome.runtime.sendMessage(result).catch((err) => {
        console.warn('[foodmask][offscreen] reply failed', err);
      });
    })();
    return;
  }
});

// Pick up settings changes that happen while we're alive even if the broadcast
// is missed (e.g. set before this doc existed).
watchSettings((settings) => pipeline.updateSettings(settings));
