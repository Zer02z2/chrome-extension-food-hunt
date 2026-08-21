// Copies ONNX Runtime Web's prebuilt wasm/mjs artifacts into public/ort so they
// are shipped verbatim with the extension and addressable via
// chrome.runtime.getURL('ort/...'). MV3 forbids remote code, so these MUST be
// bundled locally — loading from a CDN silently fails against the extension CSP.

import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const dest = join(root, 'public', 'ort');

if (!existsSync(src)) {
  console.warn('[copy-ort] onnxruntime-web not installed yet — run `npm install` first. Skipping.');
  process.exit(0);
}

mkdirSync(dest, { recursive: true });

const wanted = readdirSync(src).filter((f) => f.endsWith('.wasm') || f.endsWith('.mjs'));
let n = 0;
for (const f of wanted) {
  copyFileSync(join(src, f), join(dest, f));
  n++;
}
console.log(`[copy-ort] Copied ${n} runtime file(s) into public/ort/`);
