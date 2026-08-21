import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Food Mask',
  description: 'Finds food images on any webpage and masks the food — 100% on-device.',
  version: pkg.version,
  permissions: ['offscreen', 'storage', 'scripting'],
  host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Food Mask',
  },
  // ONNX Runtime Web instantiates WebAssembly in the offscreen document; MV3
  // requires 'wasm-unsafe-eval' in the extension-pages CSP or it is blocked.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  // Models and the ORT wasm live in public/ and are loaded same-origin by the
  // offscreen document, so they do not need to be web_accessible_resources.
});
