// Central knobs. Kept tiny and dependency-free so any context can import it.

import { DEFAULT_MODEL_ID, isModelId, type ModelId } from './models';

export const DEFAULTS = {
  enabled: true,
  blurPx: 16,
  modelId: DEFAULT_MODEL_ID,
} as const;

export type Settings = {
  enabled: boolean;
  blurPx: number;
  /** Which food-categorization model the offscreen document should use. */
  modelId: ModelId;
};

export const STORAGE_KEY = 'foodmask.settings';

// chrome.storage can be missing even though the manifest requests it. The usual
// cause is an INVALIDATED EXTENSION CONTEXT: a rebuild or "Reload" leaves this
// document orphaned from the previous extension instance, Chrome tears down its
// chrome.* namespaces, and every API read becomes undefined while the page keeps
// running (and keeps logging under the same prefix).
//
// Settings are a convenience — every context has a sane default — so this must
// degrade, never throw. Reading chrome.* in a dead context can itself throw, so
// even the probe is guarded.
function storageArea(): chrome.storage.StorageArea | null {
  try {
    return chrome.storage?.local ?? null;
  } catch {
    return null;
  }
}

/** Human-readable explanation, or null when storage is fine. For logging. */
export function storageUnavailableReason(): string | null {
  if (storageArea()) return null;
  try {
    if (!chrome?.runtime?.id) {
      return 'extension context invalidated — this page is left over from a previous build; close it and reload the extension';
    }
  } catch {
    return 'extension context invalidated — this page is left over from a previous build; close it and reload the extension';
  }
  return 'chrome.storage is unavailable — is the "storage" permission present in the loaded manifest?';
}

export async function loadSettings(): Promise<Settings> {
  const area = storageArea();
  if (!area) return { ...DEFAULTS };

  const raw = await area.get(STORAGE_KEY);
  const stored = raw[STORAGE_KEY] as Partial<Settings> | undefined;
  return {
    enabled: stored?.enabled ?? DEFAULTS.enabled,
    blurPx: stored?.blurPx ?? DEFAULTS.blurPx,
    // Validate rather than trust: a stored id from an older build (or a removed
    // model) must not wedge the pipeline on a model that no longer exists.
    modelId: isModelId(stored?.modelId) ? stored.modelId : DEFAULTS.modelId,
  };
}

export async function saveSettings(next: Settings): Promise<void> {
  const area = storageArea();
  // The popup is the only writer and always runs in a live context. If it
  // somehow doesn't, failing loudly beats silently discarding the user's choice.
  if (!area) throw new Error(storageUnavailableReason() ?? 'chrome.storage unavailable');
  await area.set({ [STORAGE_KEY]: next });
}

// Subscribe to settings written by the popup. A no-op (rather than a thrown
// TypeError) when storage is unavailable — this is called at module scope in
// both the content script and the offscreen document, so throwing here would
// abort the rest of their initialization.
export function watchSettings(onChange: (settings: Settings) => void): void {
  let onChanged;
  try {
    onChanged = chrome.storage?.onChanged;
  } catch {
    return;
  }
  if (!onChanged) return;

  onChanged.addListener((_changes, area) => {
    if (area !== 'local') return;
    void loadSettings().then(onChange);
  });
}

// Content-script image discovery thresholds.
export const DISCOVERY = {
  minWidth: 128,
  minHeight: 128,
} as const;

// Offscreen pipeline knobs. Model-specific tuning (score threshold, weights
// path) lives per-model in shared/models.ts, not here.
export const PIPELINE = {
  maxConcurrent: 2,
  // Fallback square input size, used only when a model's ONNX metadata declares
  // a dynamic/unknown input shape. Standard YOLOv8-seg exports declare 640.
  modelInputSize: 640,
  // Mask binarization threshold (after sigmoid).
  maskThreshold: 0.5,
} as const;
