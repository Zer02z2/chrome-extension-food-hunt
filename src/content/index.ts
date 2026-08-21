// Content script orchestrator.
// Owns the imgId -> element registry, drives discovery, and talks to the SW.
// Overlay rendering is added in Phase 5.

import { ImageDiscovery, type DiscoveredImage } from './discovery';
import { StatusHud } from './status';
import { loadSettings } from '../shared/config';
import type { MaskRequest } from '../shared/messages';

console.log('[foodmask][content] loaded on', location.href);

const registry = new Map<string, HTMLImageElement>();
const requestByImg = new Map<string, string>(); // imgId -> requestId
const hud = new StatusHud();

let enabled = true;

const discovery = new ImageDiscovery({
  onDiscovered: (img) => queueImage(img),
  onReset: (imgId) => {
    registry.delete(imgId);
    requestByImg.delete(imgId);
  },
});

function queueImage(img: DiscoveredImage) {
  if (!enabled) return;
  registry.set(img.imgId, img.el);

  const requestId = crypto.randomUUID();
  requestByImg.set(img.imgId, requestId);

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
    // SW may be asleep/restarting; the message API auto-wakes it, but a hard
    // failure (e.g. during reload) should not throw uncaught.
    console.warn('[foodmask][content] sendMessage failed', err);
  });
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

async function init() {
  const settings = await loadSettings();
  enabled = settings.enabled;

  hud.mount();
  hud.setEnabled(enabled);

  if (enabled) discovery.start();

  console.log('[foodmask][content] initialized, enabled =', enabled);
}

// Kick off once the DOM is ready enough to have a body.
if (document.body) {
  void init();
} else {
  document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
}
