// The EAT button: the only part of an overlay the user can actually touch.
//
// It sits dead centre of the food mask, inside the same anchored layer as the
// outline canvas, so it inherits that layer's box for free and needs no
// positioning code of its own. It is invisible until the pointer is over the
// image (or over the button itself), and — importantly — it only becomes
// hit-testable while it is visible. An always-clickable pill in the middle of
// every food photo would quietly eat the page's own links.
//
// The layer host is `pointer-events: none`, which does not stop a descendant
// from opting back in with `pointer-events: auto`; that is what makes a button
// possible inside an overlay that is otherwise invisible to the mouse.

const HIDE_DELAY_MS = 80; // covers the gap while the pointer crosses img -> button

const CSS = `
.eat {
  /* A shadow root blocks page selectors but not inherited properties, and the
     longhands below re-set everything this button actually depends on. */
  all: initial;
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) scale(0.88);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 74px;
  padding: 9px 22px;
  margin: 0;
  border: 1.5px solid rgba(255, 255, 255, 0.9);
  border-radius: 999px;
  background: rgba(8, 24, 48, 0.62);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: #fff;
  font: 700 14px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: 0.18em;
  text-indent: 0.18em; /* letter-spacing pads the right edge; re-centre the word */
  text-transform: uppercase;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.45);
  transition: opacity 130ms ease, transform 130ms ease, background 130ms ease;
}
.eat.on {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
  pointer-events: auto;
}
.eat.on:hover { background: rgba(8, 185, 255, 0.85); }
.eat.on:active { transform: translate(-50%, -50%) scale(0.94); }
.eat.eating { background: rgba(8, 185, 255, 0.85); opacity: 1; pointer-events: auto; }
`;

export class EatButton {
  private el: HTMLButtonElement;
  private target: HTMLImageElement;
  private overButton = false;
  private overImage = false;
  private hideTimer = 0;
  private destroyed = false;

  private onImageEnter = () => this.setOver('image', true);
  private onImageLeave = () => this.setOver('image', false);

  /**
   * @param target the image the mask is drawn over — the hover surface
   * @param root   the mask layer's shadow root, which already spans that image
   * @param onEat  fired on click
   */
  constructor(target: HTMLImageElement, root: ShadowRoot, onEat: () => void) {
    this.target = target;

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = 'eat';
    this.el.textContent = 'Eat';
    this.el.setAttribute('aria-label', 'Eat this food');

    this.el.addEventListener('pointerenter', () => this.setOver('button', true));
    this.el.addEventListener('pointerleave', () => this.setOver('button', false));
    this.el.addEventListener('click', (e) => {
      // The image is very often inside a link or a card handler.
      e.preventDefault();
      e.stopPropagation();
      onEat();
    });
    root.appendChild(this.el);

    target.addEventListener('pointerenter', this.onImageEnter);
    target.addEventListener('pointerleave', this.onImageLeave);
  }

  /** Latch the button on while this image is the one being eaten. */
  setEating(eating: boolean) {
    this.el.classList.toggle('eating', eating);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.hideTimer);
    this.target.removeEventListener('pointerenter', this.onImageEnter);
    this.target.removeEventListener('pointerleave', this.onImageLeave);
    this.el.remove();
  }

  // Moving from the image onto the button leaves the image before it enters the
  // button, so a bare leave-handler would flicker. Settle both flags first.
  private setOver(which: 'image' | 'button', over: boolean) {
    if (which === 'image') this.overImage = over;
    else this.overButton = over;

    clearTimeout(this.hideTimer);
    if (this.overImage || this.overButton) {
      this.el.classList.add('on');
      return;
    }
    this.hideTimer = window.setTimeout(() => {
      if (!this.destroyed) this.el.classList.remove('on');
    }, HIDE_DELAY_MS);
  }
}
