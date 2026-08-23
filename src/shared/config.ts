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

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
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
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
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
