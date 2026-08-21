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
  // Models and the ORT wasm live in public/ and are loaded same-origin by the
  // offscreen document, so they do not need to be web_accessible_resources.
});
