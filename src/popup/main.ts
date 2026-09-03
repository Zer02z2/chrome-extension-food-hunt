// Popup UI: global on/off and which food-categorization model to use. Both
// persist to chrome.storage.local, which is the single source of truth: content
// scripts react via storage.onChanged, and the service worker re-reads and
// stamps the current settings onto every job it dispatches.

import { loadSettings, saveSettings } from '../shared/config';
import { MODEL_IDS, MODELS, isModelId, type ModelId } from '../shared/models';

const enabledEl = document.getElementById('enabled') as HTMLInputElement;
const modelEl = document.getElementById('model') as HTMLSelectElement;
const modelHint = document.getElementById('modelHint') as HTMLParagraphElement;

// Build the picker from the catalog — adding a model needs no popup edit.
for (const id of MODEL_IDS) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = MODELS[id].name;
  modelEl.append(opt);
}

function selectedModel(): ModelId {
  return isModelId(modelEl.value) ? modelEl.value : MODEL_IDS[0];
}

function showHint() {
  modelHint.textContent = MODELS[selectedModel()].summary;
}

async function boot() {
  const s = await loadSettings();
  enabledEl.checked = s.enabled;
  modelEl.value = s.modelId;
  showHint();
}

async function persist() {
  const next = {
    enabled: enabledEl.checked,
    modelId: selectedModel(),
  };
  await saveSettings(next);
}

enabledEl.addEventListener('change', () => void persist());
modelEl.addEventListener('change', () => {
  showHint();
  void persist();
});

void boot();
