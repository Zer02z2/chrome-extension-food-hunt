// The head stage: one webcam cutout of the user's head, parked next to whichever
// food they last pressed EAT on.
//
// There is exactly one of these per page, however many food masks are mounted.
// Pressing EAT on a second image re-targets the same canvas rather than
// spawning another — the webcam is opened once and the head simply moves.
//
// Two elements live in a closed shadow root pinned to the viewport:
//
//   - a full-screen <canvas>, one z-index below the food masks, so the food is
//     always painted over the head and the bite reads as a bite;
//   - a 1x1 invisible <iframe> holding the camera frame (src/camera/main.ts),
//     which does the webcam and MediaPipe work and posts back finished cutouts.
//
// The canvas is `position: fixed`, so nothing has to be recomputed on scroll:
// each frame we read the target image's viewport rect and draw the head against
// it. Sizing is the one rule the whole thing exists for — the head is always
// 1.5x the height of the food mask it is eating, whatever the image's size.

import { HEAD_Z, applyImportant } from './anchor';
import { addFrameTask, removeFrameTask, type FrameTask } from './loop';
import { HEAD_TOKEN_KEY, type HeadCommand, type HeadEvent } from '../shared/head';

const HEAD_SCALE = 1.5; // head height, as a multiple of the food mask's height
const OVERLAP = 0.22; // fraction of the head's width that laps over the food
const MIRROR = true; // draw selfie-style, the way a webcam preview reads

export type HeadStageOptions = {
  /** Progress and failures, for the on-page HUD. */
  onLog?: (line: string) => void;
  /** The eaten image changed — including to none, when the stage stops itself. */
  onTargetChange?: (target: HTMLImageElement | null) => void;
};

export class HeadStage {
  private opts: HeadStageOptions;

  private host: HTMLDivElement | null = null;
  private shadow: ShadowRoot | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private frame: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;

  private target: HTMLImageElement | null = null;
  private bitmap: ImageBitmap | null = null;
  private task: FrameTask = () => this.draw();
  private drawing = false;
  private dpr = 0;

  constructor(opts: HeadStageOptions = {}) {
    this.opts = opts;
  }

  /** The image currently being eaten, if any. */
  get eating(): HTMLImageElement | null {
    return this.target;
  }

  /** Press EAT on `target`: start on the first press, re-target after that. */
  eat(target: HTMLImageElement) {
    this.mount();
    this.setTarget(target);
    this.startDrawing();
    this.send({ type: 'start' });
  }

  /** Pressing EAT on the image already being eaten puts the camera away. */
  toggle(target: HTMLImageElement) {
    if (this.target === target) this.stop();
    else this.eat(target);
  }

  /** Release the camera and clear the canvas. Keeps the frame around, warm. */
  stop() {
    if (!this.target && !this.drawing) return;
    this.setTarget(null);
    this.send({ type: 'stop' });
    this.stopDrawing();
    this.clear();
    this.dropBitmap();
  }

  /** Stop, and if `target` is not the image being eaten, do nothing at all. */
  stopIf(target: HTMLImageElement) {
    if (this.target === target) this.stop();
  }

  private setTarget(target: HTMLImageElement | null) {
    if (this.target === target) return;
    this.target = target;
    this.opts.onTargetChange?.(target);
  }

  destroy() {
    this.stop();
    this.port?.close();
    this.port = null;
    this.frame = null;
    this.host?.remove();
    this.host = null;
  }

  // --- DOM ---------------------------------------------------------------

  private mount() {
    if (this.host?.isConnected) return;

    if (!this.host) {
      this.host = document.createElement('div');
      this.host.setAttribute('aria-hidden', 'true');
      applyImportant(this.host, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: '100%',
        height: '100%',
        margin: '0',
        padding: '0',
        border: '0',
        overflow: 'hidden',
        'pointer-events': 'none',
        'z-index': HEAD_Z,
      });
      // Closed: the host page can neither restyle the canvas nor reach into the
      // frame element to hijack the camera handshake.
      this.shadow = this.host.attachShadow({ mode: 'closed' });

      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText =
        'display:block;width:100%;height:100%;margin:0;padding:0;border:0;background:transparent';
      this.ctx = this.canvas.getContext('2d');
      this.shadow.appendChild(this.canvas);

      window.addEventListener('resize', () => this.resize(), { passive: true });
    }

    (document.body ?? document.documentElement).appendChild(this.host);
    this.resize();
    this.mountFrame();
  }

  // The camera frame is an extension page, so the wasm loads under the
  // extension's CSP and the webcam prompt is attributed to this frame rather
  // than to whatever the host page is allowed to do.
  private mountFrame() {
    if (this.frame || !this.shadow) return;

    let base: string;
    try {
      base = chrome.runtime.getURL('camera.html');
    } catch {
      this.log('camera unavailable — reload the page'); // context invalidated
      return;
    }

    // The nonce rides in the fragment: it never reaches the network, and the
    // host page cannot read it back off a cross-origin iframe's src.
    const token = crypto.randomUUID();
    const origin = new URL(base).origin;

    const iframe = document.createElement('iframe');
    iframe.allow = 'camera';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    applyImportant(iframe, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '1px',
      height: '1px',
      border: '0',
      opacity: '0',
      'pointer-events': 'none',
    });

    const channel = new MessageChannel();
    iframe.addEventListener(
      'load',
      () => {
        // Handed over the instant the document exists, before page script has
        // a chance to notice the frame and race a handshake of its own.
        iframe.contentWindow?.postMessage({ type: 'foodmask:head-port', token }, origin, [
          channel.port2,
        ]);
      },
      { once: true },
    );

    iframe.src = `${base}#${HEAD_TOKEN_KEY}=${token}`;
    this.shadow.appendChild(iframe);
    this.frame = iframe;

    this.port = channel.port1;
    this.port.onmessage = (e: MessageEvent<HeadEvent>) => this.onEvent(e.data);
    this.port.start();
  }

  private send(cmd: HeadCommand) {
    this.port?.postMessage(cmd);
  }

  private onEvent(event: HeadEvent) {
    switch (event.type) {
      case 'frame':
        // A frame that arrives after the user has stopped is simply dropped;
        // its bitmap still has to be released.
        if (!this.target) {
          event.bitmap.close();
          return;
        }
        this.dropBitmap();
        this.bitmap = event.bitmap;
        return;
      case 'state':
        if (event.state === 'loading') this.log('eat — starting camera');
        else if (event.state === 'live') this.log('eat — camera live');
        return;
      case 'error':
        this.log(`eat — ${event.message}`);
        this.stop();
        return;
    }
  }

  private log(line: string) {
    this.opts.onLog?.(line);
    console.log('[foodmask][head]', line);
  }

  // --- painting ----------------------------------------------------------

  private startDrawing() {
    if (this.drawing) return;
    this.drawing = true;
    addFrameTask(this.task);
  }

  private stopDrawing() {
    if (!this.drawing) return;
    this.drawing = false;
    removeFrameTask(this.task);
  }

  private dropBitmap() {
    this.bitmap?.close();
    this.bitmap = null;
  }

  private resize() {
    const canvas = this.canvas;
    if (!canvas) return;
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(window.innerWidth * this.dpr));
    const h = Math.max(1, Math.round(window.innerHeight * this.dpr));
    if (canvas.width !== w) canvas.width = w; // assignment clears the canvas
    if (canvas.height !== h) canvas.height = h;
  }

  private clear() {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Redrawn every frame rather than only on a new cutout: the head has to stay
  // glued to its image while the page scrolls, which happens far more often
  // than 30 times a second.
  private draw() {
    const ctx = this.ctx;
    const bitmap = this.bitmap;
    const target = this.target;
    if (!ctx || !target) return;

    if (!target.isConnected) {
      this.stop(); // the image went away mid-bite
      return;
    }

    // An SPA that replaces <body> takes the stage with it; put it back rather
    // than silently going dark until the next press.
    if (this.host && !this.host.isConnected) {
      (document.body ?? document.documentElement).appendChild(this.host);
    }

    if (this.dpr !== (window.devicePixelRatio || 1)) this.resize();
    this.clear();
    if (!bitmap) return; // camera still warming up

    const r = target.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;

    const scale = this.dpr;
    const h = r.height * HEAD_SCALE * scale;
    const w = (bitmap.width / bitmap.height) * h;

    // Parked off the right edge of the food, leaning back over it just enough
    // to read as a bite, and centred on the food's own middle.
    const left = (r.right * scale) - w * OVERLAP;
    const top = (r.top + r.height / 2) * scale - h / 2;

    ctx.save();
    if (MIRROR) {
      ctx.translate(left + w, top);
      ctx.scale(-1, 1);
      ctx.drawImage(bitmap, 0, 0, w, h);
    } else {
      ctx.drawImage(bitmap, left, top, w, h);
    }
    ctx.restore();
  }
}
