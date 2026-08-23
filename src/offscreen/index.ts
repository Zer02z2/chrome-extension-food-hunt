// Offscreen document entry point. Owns the persistent inference pipeline and
// replies to SW-routed jobs. All heavy compute (Canvas, WebGPU, ONNX) lives here.
//
// IMPORTANT: an offscreen document is limited to chrome.runtime and the
// messaging APIs. chrome.storage is undefined here even though the manifest
// requests it, so settings must be brokered through the service worker:
//   - at boot we ask for them (SETTINGS_REQUEST)
//   - afterwards the popup's SETTINGS_CHANGED broadcast reaches us directly

import { Pipeline } from './pipeline';
import {
  isOffscreenJob,
  isSettingsChanged,
  isCancelJob,
  type SettingsRequest,
} from './../shared/messages';
import { DEFAULTS, type Settings } from '../shared/config';
import { modelSpec } from '../shared/models';

console.log('[foodmask][offscreen] loaded');

async function requestSettings(): Promise<Settings> {
  const msg: SettingsRequest = { type: 'SETTINGS_REQUEST' };
  try {
    const settings = (await chrome.runtime.sendMessage(msg)) as Settings | undefined;
    if (settings) return settings;
    console.warn('[foodmask][offscreen] no settings from SW, using defaults');
  } catch (err) {
    console.warn('[foodmask][offscreen] settings request failed, using defaults', err);
  }
  return { ...DEFAULTS };
}

const pipeline = new Pipeline();
const initDone = requestSettings()
  .then((settings) => pipeline.init(settings))
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

// No chrome.storage.onChanged backstop here — it does not exist in this
// context. A change made while this document was absent is picked up by the
// SETTINGS_REQUEST above when it is (re)created.
