// A small status HUD pinned to the bottom-right of every page, isolated inside a
// Shadow DOM so page CSS can never touch it. Shows live food-detection / masking
// counts and a short rolling log.

export type HudCounts = {
  scanned: number;
  food: number;
  masked: number;
  pending: number;
};

const CSS = `
:host { all: initial; }
.wrap {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 2147483647;
  font: 12px/1.35 system-ui, -apple-system, Segoe UI, sans-serif;
  color: #f3f3f3;
  background: rgba(20, 22, 26, 0.92);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.35);
  width: 210px;
  overflow: hidden;
  user-select: none;
  backdrop-filter: blur(2px);
}
.head {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px;
  cursor: pointer;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #2e7d32; flex: none; }
.dot.off { background: #9e9e9e; }
.dot.busy { background: #f9a825; animation: pulse 1s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
.title { font-weight: 600; flex: 1; }
.chev { opacity: 0.6; transition: transform .15s; }
.wrap.collapsed .chev { transform: rotate(-90deg); }
.wrap.collapsed .body { display: none; }
.body { padding: 8px 10px; }
.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; margin-bottom: 6px; }
.stat { display: flex; justify-content: space-between; }
.stat b { font-variant-numeric: tabular-nums; }
.k { opacity: 0.65; }
.model {
  display: flex; justify-content: space-between; gap: 8px;
  font-size: 11px; opacity: 0.7; margin-top: 2px;
}
.model b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log {
  margin-top: 4px; max-height: 76px; overflow: auto;
  font-size: 11px; line-height: 1.3; opacity: 0.8;
  border-top: 1px solid rgba(255,255,255,0.08); padding-top: 6px;
}
.log div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;

export class StatusHud {
  private host: HTMLDivElement;
  private root: ShadowRoot;
  private wrap!: HTMLDivElement;
  private dot!: HTMLDivElement;
  private logEl!: HTMLDivElement;
  private modelEl!: HTMLElement;
  private statEls: Record<keyof HudCounts, HTMLElement> = {} as never;
  private counts: HudCounts = { scanned: 0, food: 0, masked: 0, pending: 0 };
  private enabled = true;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'foodmask-hud-host';
    // The host itself is inert; all layout lives in the shadow root.
    this.host.style.cssText = 'all: initial;';
    this.root = this.host.attachShadow({ mode: 'open' });
    this.render();
  }

  mount() {
    if (!this.host.isConnected) {
      (document.body ?? document.documentElement).appendChild(this.host);
    }
  }

  private render() {
    const style = document.createElement('style');
    style.textContent = CSS;

    this.wrap = document.createElement('div');
    this.wrap.className = 'wrap';

    const head = document.createElement('div');
    head.className = 'head';
    this.dot = document.createElement('div');
    this.dot.className = 'dot';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = '🍔 Food Mask';
    const chev = document.createElement('div');
    chev.className = 'chev';
    chev.textContent = '▾';
    head.append(this.dot, title, chev);
    head.addEventListener('click', () => this.wrap.classList.toggle('collapsed'));

    const body = document.createElement('div');
    body.className = 'body';
    const stats = document.createElement('div');
    stats.className = 'stats';
    const mk = (key: keyof HudCounts, label: string) => {
      const s = document.createElement('div');
      s.className = 'stat';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = label;
      const v = document.createElement('b');
      v.textContent = '0';
      s.append(k, v);
      this.statEls[key] = v;
      return s;
    };
    stats.append(
      mk('scanned', 'scanned'),
      mk('food', 'food'),
      mk('masked', 'masked'),
      mk('pending', 'pending'),
    );

    const model = document.createElement('div');
    model.className = 'model';
    const modelK = document.createElement('span');
    modelK.textContent = 'model';
    this.modelEl = document.createElement('b');
    this.modelEl.textContent = '—';
    model.append(modelK, this.modelEl);

    this.logEl = document.createElement('div');
    this.logEl.className = 'log';

    body.append(stats, model, this.logEl);
    this.wrap.append(head, body);
    this.root.append(style, this.wrap);
  }

  setModel(name: string) {
    this.modelEl.textContent = name;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.refreshDot();
  }

  setBusy(busy: boolean) {
    if (!this.enabled) return;
    this.dot.className = busy ? 'dot busy' : 'dot';
    if (!busy) this.refreshDot();
  }

  private refreshDot() {
    this.dot.className = this.enabled ? 'dot' : 'dot off';
  }

  update(patch: Partial<HudCounts>) {
    this.counts = { ...this.counts, ...patch };
    (Object.keys(this.statEls) as (keyof HudCounts)[]).forEach((k) => {
      this.statEls[k].textContent = String(this.counts[k]);
    });
  }

  get snapshot(): HudCounts {
    return { ...this.counts };
  }

  log(msg: string) {
    const line = document.createElement('div');
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    line.textContent = `${hh}:${mm}:${ss}  ${msg}`;
    this.logEl.prepend(line);
    while (this.logEl.childElementCount > 30) {
      this.logEl.lastElementChild?.remove();
    }
  }
}
