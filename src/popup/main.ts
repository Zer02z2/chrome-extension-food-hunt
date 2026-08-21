// Popup UI: global on/off + blur intensity, persisted to chrome.storage.local.
// Content and offscreen contexts react via storage.onChanged; we also broadcast
// SETTINGS_CHANGED so the offscreen blur updates immediately.

import { loadSettings, saveSettings } from '../shared/config';
import type { SettingsChanged } from '../shared/messages';

const enabledEl = document.getElementById('enabled') as HTMLInputElement;
const blurEl = document.getElementById('blur') as HTMLInputElement;
const blurVal = document.getElementById('blurVal') as HTMLSpanElement;

async function boot() {
  const s = await loadSettings();
  enabledEl.checked = s.enabled;
  blurEl.value = String(s.blurPx);
  blurVal.textContent = String(s.blurPx);
}

async function persist() {
  const next = {
    enabled: enabledEl.checked,
    blurPx: Number(blurEl.value),
  };
  await saveSettings(next);
  const broadcast: SettingsChanged = { type: 'SETTINGS_CHANGED', ...next };
  chrome.runtime.sendMessage(broadcast).catch(() => {});
}

enabledEl.addEventListener('change', () => void persist());
blurEl.addEventListener('input', () => {
  blurVal.textContent = blurEl.value;
});
blurEl.addEventListener('change', () => void persist());

void boot();
