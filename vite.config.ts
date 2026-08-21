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
        if (file.endsWith('.wasm')) delete bundle[file];
      }
    },
  };
}

export default defineConfig({
  plugins: [crx({ manifest }), dropBundledOrtWasm()],
  build: {
    target: 'esnext',
    rollupOptions: {
      // The offscreen document is created at runtime via chrome.offscreen, so it
      // is NOT referenced in the manifest and would not be picked up otherwise.
      input: {
        offscreen: 'offscreen.html',
      },
    },
  },
  // ONNX Runtime Web ships large prebuilt wasm; keep it out of Vite's dep pre-bundle.
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});
