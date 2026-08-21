// Service worker — pure router. Holds no models and does no compute.
// It may die after ~30s idle and be respawned; all state here is best-effort and
// re-derivable. The offscreen document is the persistent compute context.

import {
  isMaskRequest,
  isMaskResult,
  isCancelJob,
  type MaskResult,
  type OffscreenJob,
} from '../shared/messages';

console.log('[foodmask][sw] booted');

const OFFSCREEN_URL = 'offscreen.html';

// requestId -> which tab to deliver the result back to.
const pending = new Map<string, { tabId: number }>();

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
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      // WORKERS keeps the doc alive with no fixed lifetime; never AUDIO_PLAYBACK
      // (that self-closes after ~30s of no audio).
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Runs on-device food classification and segmentation models.',
    })
    .then(() => {
      console.log('[foodmask][sw] offscreen document created');
    })
    .catch((err) => {
      // A racing create may have won; tolerate the "already exists" error.
      if (!String(err?.message ?? err).includes('single offscreen')) throw err;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  // From a content script: sender.tab is set. Route into the offscreen worker.
  if (isMaskRequest(msg) && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    pending.set(msg.requestId, { tabId });

    void (async () => {
      try {
        await ensureOffscreen();
        const job: OffscreenJob = {
          type: 'OFFSCREEN_JOB',
          requestId: msg.requestId,
          imgId: msg.imgId,
          imageUrl: msg.imageUrl,
          naturalWidth: msg.naturalWidth,
          naturalHeight: msg.naturalHeight,
        };
        await chrome.runtime.sendMessage(job);
      } catch (err) {
        console.warn('[foodmask][sw] failed to dispatch job', err);
        // Report a benign failure back to the tab so the HUD can settle.
        const failure: MaskResult = {
          type: 'MASK_RESULT',
          requestId: msg.requestId,
          imgId: msg.imgId,
          isFood: false,
          error: String((err as Error)?.message ?? err),
        };
        routeResult(failure);
      }
    })();
    return; // no synchronous response
  }

  // Cancellation from a content script: forget the mapping and tell the offscreen
  // worker to drop the job if it hasn't started.
  if (isCancelJob(msg)) {
    pending.delete(msg.requestId);
    // Only forward if the offscreen doc exists; if it doesn't, there's no job.
    void hasOffscreen().then((exists) => {
      if (exists) chrome.runtime.sendMessage(msg).catch(() => {});
    });
    return;
  }

  // From the offscreen document: deliver the result to the originating tab.
  if (isMaskResult(msg)) {
    routeResult(msg);
    return;
  }
});

function routeResult(result: MaskResult) {
  const target = pending.get(result.requestId);
  pending.delete(result.requestId);
  if (!target) {
    // Tab may have navigated away, or the SW restarted and lost the mapping.
    return;
  }
  chrome.tabs.sendMessage(target.tabId, result).catch((err) => {
    // Tab closed / no content script (e.g. chrome:// page). Safe to ignore.
    console.debug('[foodmask][sw] deliver to tab failed', err?.message ?? err);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[foodmask][sw] onInstalled');
});
