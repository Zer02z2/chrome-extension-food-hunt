import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [crx({ manifest })],
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
