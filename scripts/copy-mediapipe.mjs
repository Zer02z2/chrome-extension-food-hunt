// Copies MediaPipe Tasks Vision' prebuilt wasm runtime into public/mediapipe so
// it ships with the extension and is addressable via
// chrome.runtime.getURL('mediapipe/...'). MV3 forbids remote code, so the
// runtime MUST be local — FilesetResolver's default CDN path is blocked by the
// extension CSP.
//
// FilesetResolver.forVisionTasks(base) resolves to
// `${base}/vision_wasm_internal.{js,wasm}` on any engine with WebAssembly SIMD,
// which every Chrome that supports MV3 offscreen documents has. The ~11 MB
// nosimd fallback is deliberately not shipped.

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dest = join(root, 'public', 'mediapipe');

if (!existsSync(src)) {
  console.warn(
    '[copy-mediapipe] @mediapipe/tasks-vision not installed yet — run `npm install` first. Skipping.',
  );
  process.exit(0);
}

mkdirSync(dest, { recursive: true });

const wanted = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];
let bytes = 0;
for (const f of wanted) {
  const from = join(src, f);
  if (!existsSync(from)) throw new Error(`[copy-mediapipe] missing ${from}`);
  copyFileSync(from, join(dest, f));
  bytes += statSync(from).size;
}
console.log(
  `[copy-mediapipe] Copied ${wanted.length} runtime file(s) into public/mediapipe/ (${(
    bytes / 1_048_576
  ).toFixed(1)} MB)`,
);
