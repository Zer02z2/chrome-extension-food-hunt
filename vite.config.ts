import { defineConfig, type Plugin } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

// onnxruntime-web references its .wasm via import.meta.url, so Rollup emits a
// hashed copy into dist/assets. We never use it — the runtime loads the wasm
// from public/ort/ via ort.env.wasm.wasmPaths — so drop it to avoid shipping a
// duplicate ~26 MB blob in the extension package.
function dropBundledOrtWasm(): Plugin {
  return {
    name: 'drop-bundled-ort-wasm',
    generateBundle(_options, bundle) {
      for (const file of Object.keys(bundle)) {
        if (/ort-.*\.wasm$/.test(file)) delete bundle[file];
      }
    },
  };
}

export default defineConfig({
  plugins: [crx({ manifest }), dropBundledOrtWasm()],
  // The pipeline runs in a module Worker; the default 'iife' worker format
  // cannot express one.
  worker: { format: 'es' },
  build: {
    target: 'esnext',
    rollupOptions: {
      // Neither of these HTML entries is referenced from the manifest's
      // content_scripts/background, so Rollup would not find them on its own:
      // the offscreen document is created at runtime via chrome.offscreen, and
      // the camera frame is iframed in by the content script.
      input: {
        offscreen: 'offscreen.html',
        camera: 'camera.html',
      },
    },
  },
  // ONNX Runtime Web ships large prebuilt wasm; keep it out of Vite's dep pre-bundle.
  // MediaPipe resolves its own wasm at runtime from public/mediapipe/ for the
  // same reason.
  optimizeDeps: {
    exclude: ['onnxruntime-web', '@mediapipe/tasks-vision'],
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});
