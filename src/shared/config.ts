// Central knobs. Kept tiny and dependency-free so any context can import it.

import { DEFAULT_MODEL_ID, isModelId, type ModelId } from './models';

export type Settings = {
  enabled: boolean;
  modelId: ModelId;
};

export const DEFAULTS: Settings = {
  enabled: true,
  modelId: DEFAULT_MODEL_ID,
};

const STORAGE_KEY = 'foodmask.settings';

// A content script left over from a previous build keeps running with its
// chrome.* namespaces torn down, so even reading chrome.storage can throw there.
// Settings are a convenience — every context has a sane default — so this
// degrades instead of taking the script down with it.
function storage(): chrome.storage.StorageArea | null {
  try {
    return chrome.storage?.local ?? null;
  } catch {
    return null;
  }
}

export async function loadSettings(): Promise<Settings> {
  const area = storage();
  if (!area) return { ...DEFAULTS };

  const stored = (await area.get(STORAGE_KEY))[STORAGE_KEY] as Partial<Settings> | undefined;
  return {
    enabled: stored?.enabled ?? DEFAULTS.enabled,
    // Validate rather than trust: an id from an older build must not wedge the
    // pipeline on a model that no longer exists.
    modelId: isModelId(stored?.modelId) ? stored.modelId : DEFAULTS.modelId,
  };
}

export async function saveSettings(next: Settings): Promise<void> {
  const area = storage();
  // The popup is the only writer and always runs in a live context. If it
  // somehow doesn't, failing loudly beats discarding the user's choice.
  if (!area) throw new Error('chrome.storage unavailable');
  await area.set({ [STORAGE_KEY]: next });
}

/** Subscribe to settings written by the popup. A no-op if storage is gone. */
export function watchSettings(onChange: (settings: Settings) => void): void {
  let onChanged;
  try {
    onChanged = chrome.storage?.onChanged;
  } catch {
    return;
  }
  onChanged?.addListener((_changes, area) => {
    if (area === 'local') void loadSettings().then(onChange);
  });
}

// Content-script image discovery thresholds. Smaller images are icons, sprites
// and spacers.
export const DISCOVERY = {
  minWidth: 128,
  minHeight: 128,
} as const;
