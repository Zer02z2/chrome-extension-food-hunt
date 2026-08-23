// Service worker — pure router. Holds no models and does no compute.
// It may die after ~30 s idle and be respawned, so all state here is
// best-effort and re-derivable. The offscreen document is the persistent
// compute context.

import {
  isCancelJob,
  isMaskRequest,
  isMaskResult,
  type MaskResult,
  type OffscreenJob,
} from '../shared/messages';
import { loadSettings, type Settings } from '../shared/config';

console.log('[foodmask][sw] booted');

const OFFSCREEN_URL = 'offscreen.html';

// requestId -> which tab to deliver the result back to.
const pending = new Map<string, number>();

// The worker holds no settings of its own; every job carries the ones it should
// run under. This is the only place that reads them, so one cached copy does.
let settings: Promise<Settings> | null = null;
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') settings = null;
});

// Serialize offscreen creation so two concurrent requests can't both try to
// create the document (which would throw "Only a single offscreen document...").
let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  // getContexts is the reliable MV3 way to detect an existing offscreen doc.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  if (creating) return creating;

  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      // WORKERS keeps the doc alive with no fixed lifetime; never AUDIO_PLAYBACK
      // (that self-closes after ~30 s of no audio).
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Runs on-device food classification and segmentation models.',
    })
    .then(() => console.log('[foodmask][sw] offscreen document created'))
    .catch((err) => {
      // A racing create may have won; tolerate the "already exists" error.
      if (!String(err?.message ?? err).includes('single offscreen')) throw err;
    })
    .finally(() => {
      creating = null;
    });
  return creating;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  // From a content script: sender.tab is set. Route into the offscreen worker.
  if (isMaskRequest(msg) && sender.tab?.id != null) {
    pending.set(msg.requestId, sender.tab.id);

    void (async () => {
      try {
        const [current] = await Promise.all([(settings ??= loadSettings()), ensureOffscreen()]);
        const job: OffscreenJob = {
          type: 'OFFSCREEN_JOB',
          requestId: msg.requestId,
          imgId: msg.imgId,
          imageUrl: msg.imageUrl,
          modelId: current.modelId,
          blurPx: current.blurPx,
        };
        await chrome.runtime.sendMessage(job);
      } catch (err) {
        console.warn('[foodmask][sw] failed to dispatch job', err);
        // Report a benign failure back to the tab so the HUD can settle.
        routeResult({
          type: 'MASK_RESULT',
          requestId: msg.requestId,
          imgId: msg.imgId,
          isFood: false,
          error: String((err as Error)?.message ?? err),
        });
      }
    })();
    return;
  }

  // Cancellation from a content script: forget the mapping and tell the worker
  // to drop the job if it hasn't started.
  if (isCancelJob(msg)) {
    pending.delete(msg.requestId);
    void hasOffscreen().then((exists) => {
      if (exists) chrome.runtime.sendMessage(msg).catch(() => {});
    });
    return;
  }

  // From the offscreen document: deliver the result to the originating tab.
  if (isMaskResult(msg)) routeResult(msg);
});

function routeResult(result: MaskResult) {
  const tabId = pending.get(result.requestId);
  pending.delete(result.requestId);
  // Tab may have navigated away, or the SW restarted and lost the mapping.
  if (tabId == null) return;

  chrome.tabs.sendMessage(tabId, result).catch((err) => {
    // Tab closed / no content script (e.g. a chrome:// page). Safe to ignore.
    console.debug('[foodmask][sw] deliver to tab failed', err?.message ?? err);
  });
}
