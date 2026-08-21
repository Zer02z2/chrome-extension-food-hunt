// Offscreen document entry point. Owns the persistent inference pipeline and
// replies to SW-routed jobs. All heavy compute (Canvas, WebGPU, ONNX) lives here.

import { Pipeline } from './pipeline';
import { isOffscreenJob, isSettingsChanged } from './../shared/messages';
import { loadSettings } from '../shared/config';

console.log('[foodmask][offscreen] loaded');

const pipeline = new Pipeline();
const initDone = pipeline
  .init()
  .then(() => console.log(`[foodmask][offscreen] pipeline ready, provider=${pipeline.provider}`))
  .catch((err) => console.error('[foodmask][offscreen] init failed', err));

chrome.runtime.onMessage.addListener((msg) => {
  if (isSettingsChanged(msg)) {
    pipeline.updateSettings({ enabled: msg.enabled, blurPx: msg.blurPx });
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
chrome.storage.onChanged.addListener(async (_changes, area) => {
  if (area !== 'local') return;
  pipeline.updateSettings(await loadSettings());
});
