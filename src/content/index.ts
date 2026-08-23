// Content script orchestrator.
// Owns the imgId -> element registry, drives discovery, renders overlays, and
// talks to the SW. Cancels in-flight jobs whose image scrolls away.

import { ImageDiscovery, type DiscoveredImage } from './discovery';
import { StatusHud } from './status';
import { OverlayManager } from './overlay';
import { loadSettings } from '../shared/config';
import { DEFAULT_MODEL_ID, modelSpec, type ModelId } from '../shared/models';
import { isMaskResult, type MaskRequest, type CancelJob } from '../shared/messages';

console.log('[foodmask][content] loaded on', location.href);

const registry = new Map<string, HTMLImageElement>();
const requestByImg = new Map<string, string>(); // imgId -> requestId (in-flight)
const hud = new StatusHud();
const overlays = new OverlayManager();

let enabled = true;
let modelId: ModelId = DEFAULT_MODEL_ID;

// Watches in-flight images; if one leaves the viewport before its result lands,
// cancel the (possibly still-queued) job so we don't waste compute.
const inflightIO = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) continue;
      const el = e.target as HTMLImageElement;
      const imgId = el.dataset.foodmaskId;
      if (imgId && requestByImg.has(imgId)) cancelImage(imgId);
    }
  },
  { rootMargin: '300px' }, // a bit of hysteresis so tiny scrolls don't thrash
);

const discovery = new ImageDiscovery({
  onDiscovered: (img) => queueImage(img),
  onReset: (imgId, el) => {
    inflightIO.unobserve(el);
    if (requestByImg.has(imgId)) cancelImage(imgId, el);
    registry.delete(imgId);
    overlays.remove(imgId); // stale content — drop its mask
  },
});

function queueImage(img: DiscoveredImage) {
  if (!enabled) return;
  registry.set(img.imgId, img.el);

  const requestId = crypto.randomUUID();
  requestByImg.set(img.imgId, requestId);
  inflightIO.observe(img.el);

  const msg: MaskRequest = {
    type: 'MASK_REQUEST',
    requestId,
    imgId: img.imgId,
    imageUrl: img.imageUrl,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
  };

  hud.update({ scanned: hud.snapshot.scanned + 1, pending: hud.snapshot.pending + 1 });
  hud.setBusy(true);
  hud.log(`scan ${shorten(img.imageUrl)}`);

  chrome.runtime.sendMessage(msg).catch((err) => {
    console.warn('[foodmask][content] sendMessage failed', err);
  });
}

function cancelImage(imgId: string, el?: HTMLImageElement) {
  const requestId = requestByImg.get(imgId);
  if (!requestId) return;
  requestByImg.delete(imgId);
  const target = el ?? registry.get(imgId);
  if (target) inflightIO.unobserve(target);

  hud.update({ pending: Math.max(0, hud.snapshot.pending - 1) });
  if (hud.snapshot.pending === 0) hud.setBusy(false);

  const msg: CancelJob = { type: 'CANCEL_JOB', requestId, imgId };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function shorten(url: string): string {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').pop() || u.hostname;
    return file.length > 22 ? file.slice(0, 20) + '…' : file;
  } catch {
    return url.slice(0, 22);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!isMaskResult(msg)) return;

  const wasInflight = requestByImg.has(msg.imgId);
  requestByImg.delete(msg.imgId);
  const target = registry.get(msg.imgId);
  if (target) inflightIO.unobserve(target);

  if (wasInflight) {
    const pendingCount = Math.max(0, hud.snapshot.pending - 1);
    hud.update({ pending: pendingCount });
    if (pendingCount === 0) hud.setBusy(false);
  }

  if (!target) return; // element retired
  if (msg.error) {
    if (msg.error !== 'cancelled') hud.log(`err ${msg.imgId.slice(0, 6)} — ${msg.error}`);
    return;
  }

  if (msg.isFood) {
    hud.update({ food: hud.snapshot.food + 1 });
    hud.log(`food ✓ ${msg.imgId.slice(0, 6)}`);
    if (msg.overlayPngDataUrl && enabled) {
      overlays.show(msg.imgId, target, msg.overlayPngDataUrl);
      hud.update({ masked: hud.snapshot.masked + 1 });
    }
  } else {
    hud.log(`not food ${msg.imgId.slice(0, 6)}`);
  }
});

function applyEnabled(next: boolean) {
  if (next === enabled) return;
  enabled = next;
  hud.setEnabled(enabled);
  if (enabled) {
    discovery.start();
    hud.log('enabled');
  } else {
    discovery.stop();
    overlays.clear();
    for (const imgId of [...requestByImg.keys()]) cancelImage(imgId);
    hud.log('disabled');
  }
}

// A model switch invalidates every verdict on the page, so drop the overlays and
// send everything through the newly selected model.
function applyModel(next: ModelId) {
  if (next === modelId) return;
  modelId = next;
  hud.setModel(modelSpec(modelId).name);
  hud.log(`model → ${modelSpec(modelId).name}`);

  overlays.clear();
  for (const imgId of [...requestByImg.keys()]) cancelImage(imgId);
  registry.clear();
  hud.update({ scanned: 0, food: 0, masked: 0, pending: 0 });

  if (enabled) discovery.rescan();
}

// React to popup changes (written to chrome.storage.local).
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local') return;
  void loadSettings().then((s) => {
    applyEnabled(s.enabled);
    applyModel(s.modelId);
  });
});

async function init() {
  const settings = await loadSettings();
  enabled = settings.enabled;
  modelId = settings.modelId;

  hud.mount();
  hud.setEnabled(enabled);
  hud.setModel(modelSpec(modelId).name);
  overlays.mount();

  if (enabled) discovery.start();

  console.log('[foodmask][content] initialized, enabled =', enabled, 'model =', modelId);
}

if (document.body) {
  void init();
} else {
  document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
}
