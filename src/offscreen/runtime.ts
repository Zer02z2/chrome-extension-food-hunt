// ONNX Runtime Web bootstrap for the offscreen document.
// MV3 forbids remote code, so the wasm artifacts are served from the packaged
// public/ort/ directory via chrome.runtime.getURL — never a CDN.

import * as ort from 'onnxruntime-web';

let configured = false;

export function configureOrt() {
  if (configured) return;
  configured = true;

  ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
  // Extension pages are not cross-origin isolated, so SharedArrayBuffer-backed
  // threading is unavailable. Single-threaded keeps the wasm EP working anywhere.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
}

export type LoadedSession = {
  session: ort.InferenceSession;
  provider: 'webgpu' | 'wasm';
};

// Prefer WebGPU; fall back to WASM. ORT does not always fall back on its own, so
// we try each provider explicitly and report which one actually initialized.
export async function createSession(
  modelPath: string,
  modelName = modelPath,
): Promise<LoadedSession> {
  configureOrt();
  const url = chrome.runtime.getURL(modelPath);
  const res = await fetch(url);
  if (!res.ok) {
    // Weights are fetched, never committed, so a missing file is the single most
    // likely first-run failure. Say so instead of surfacing a bare 404.
    throw new Error(
      `${modelName} weights missing (${modelPath}) — run \`npm run fetch:models\` and rebuild`,
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());

  const webgpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;
  if (webgpuAvailable) {
    try {
      const session = await ort.InferenceSession.create(buf, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      return { session, provider: 'webgpu' };
    } catch (err) {
      console.warn('[foodmask][offscreen] WebGPU init failed, falling back to WASM:', err);
    }
  }

  const session = await ort.InferenceSession.create(buf, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return { session, provider: 'wasm' };
}

export { ort };
