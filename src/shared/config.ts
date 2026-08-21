// Central knobs. Kept tiny and dependency-free so any context can import it.

export const DEFAULTS = {
  enabled: true,
  blurPx: 16,
} as const;

export type Settings = {
  enabled: boolean;
  blurPx: number;
};

export const STORAGE_KEY = 'foodmask.settings';

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const stored = raw[STORAGE_KEY] as Partial<Settings> | undefined;
  return {
    enabled: stored?.enabled ?? DEFAULTS.enabled,
    blurPx: stored?.blurPx ?? DEFAULTS.blurPx,
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

// Offscreen pipeline knobs.
export const PIPELINE = {
  maxConcurrent: 2,
  // Longest edge fed to the segmentation model input (YOLOv8-seg uses 640).
  modelInputSize: 640,
  // Confidence threshold for keeping a detection.
  scoreThreshold: 0.25,
  // Mask binarization threshold (after sigmoid).
  maskThreshold: 0.5,
} as const;
