// 路線圖：SVG 畫軌道與站點，HTML 疊層畫標籤；依步驟播放「小點」沿路線前進。
import { MODELS, lineVar } from './catalog.js';

const NS = 'http://www.w3.org/2000/svg';
const key = (a, b) => `${a}>${b}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function svg(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

function octi(a, b, bend = 0.5) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (ady < 0.5 || adx < 0.5) return [a, b];
  const sx = Math.sign(dx), sy = Math.sign(dy);
  if (adx >= ady) {
    const h = (adx - ady) * bend;
    const p1 = { x: a.x + sx * h, y: a.y };
    return [a, p1, { x: p1.x + sx * ady, y: b.y }, b];
  }
  const v = (ady - adx) * bend;
  const p1 = { x: a.x, y: a.y + sy * v };
  return [a, p1, { x: b.x, y: p1.y + sy * adx }, b];
}

function rounded(pts, r = 18) {
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y), l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    // 相鄰兩點重疊時（例如 bend 為 0 或 1）沒有轉角可以修圓，直接略過，避免除以零產生 NaN。
    if (l1 < 0.01 || l2 < 0.01) continue;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const a = { x: p1.x + ((p0.x - p1.x) * rr) / l1, y: p1.y + ((p0.y - p1.y) * rr) / l1 };
    const b = { x: p1.x + ((p2.x - p1.x) * rr) / l2, y: p1.y + ((p2.y - p1.y) * rr) / l2 };
    d += ` L${a.x},${a.y} Q${p1.x},${p1.y} ${b.x},${b.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x},${last.y}`;
}

const NODE_OFFSET = { source: 16, brain: 30, station: 18, gate: 20, engine: 20, switch: 13, agg: 22 };

export class RouteMap {
  constructor(root) {
    this.root = root;
    this.svgEl = root.querySelector('.map-svg');
    this.labelLayer = root.querySelector('.map-labels');
    this.speed = 1;
    this.instant = false;
    this.run = 0;
    new ResizeObserver(() => this.layout()).observe(root);
  }

  // ---------- 建立 ----------

  load(graph, { intro = false } = {}) {
    this.run++;
    this.graph = graph;
    this.nodes = new Map();
    for (const n of graph.nodes) {
      const m = n.model ? MODELS[n.model] : null;
      this.nodes.set(n.id, { ...n, name: n.name ?? m?.name ?? '', sub: n.sub ?? m?.where ?? '', line: n.line ?? m?.line ?? null, state: null, badge: null, metric: null });
    }
    this.edges = new Map(graph.edges.map((e) => [key(e.from, e.to), { ...e, progress: 0, weight: null, blocked: null }]));
    this.decorState = {};
    this.dots = [];
    this.box ??= { W: 1, H: 1, ox: 0, oy: 0, cw: 1, ch: 1 };
    this.build();
    this.layout();
    if (intro && !this.reduced()) this.root.classList.add('is-intro');
    else this.root.classList.remove('is-intro');
  }

  reduced() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }

  build() {
    this.svgEl.replaceChildren();
    this.labelLayer.replaceChildren();
    const defs = svg('defs', {}, this.svgEl);
    const pat = svg('pattern', { id: 'hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    svg('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch-line' }, pat);
    const g = (cls) => svg('g', { class: cls }, this.svgEl);
    this.gBack = g('g-back');
    this.gDecor = g('g-decor');
    this.gTrack = g('g-track');
    this.gPaint = g('g-paint');
    this.gMarks = g('g-marks');
    this.gNodes = g('g-nodes');
    this.gDots = g('g-dots');

    this.edgeEls = new Map();
    for (const [k, e] of this.edges) {
      const base = svg('path', { class: `track${e.dashed ? ' dashed' : ''}` }, this.gTrack);
      const paint = svg('path', { class: 'paint' }, this.gPaint);
      this.edgeEls.set(k, { base, paint, len: 0 });
    }

    this.nodeEls = new Map();
    for (const n of this.nodes.values()) {
      const grp = svg('g', { class: `node kind-${n.kind}` }, this.gNodes);
      this.drawNode(n, grp);
      const label = document.createElement('div');
      label.className = `nl lp-${n.lp ?? 'b'} kind-${n.kind}${n.row ? ' is-row' : ''}`;
      label.style.setProperty('--off', `${NODE_OFFSET[n.kind] ?? 14}px`);
      if (n.maxw) label.style.setProperty('--maxw', `${n.maxw}px`);
      label.innerHTML = '<div class="nl-name"></div><div class="nl-sub"></div><div class="nl-metric"></div><div class="nl-badge"></div>';
      this.labelLayer.appendChild(label);
      this.nodeEls.set(n.id, { grp, label });
      this.paintNode(n);
    }
  }

  drawNode(n, grp) {
    switch (n.kind) {
      case 'source':
        svg('circle', { r: 13, class: 'n-src-ring' }, grp);
        svg('circle', { r: 7, class: 'n-src' }, grp);
        break;
      case 'brain':
        svg('rect', { x: -30, y: -30, width: 60, height: 60, class: 'think-ring' }, grp);
        svg('rect', { x: -22, y: -22, width: 44, height: 44, class: 'n-brain' }, grp);
        // 一進三出的分流符號
        svg('path', { d: 'M-11 0 H-2 M-2 0 L9 -9 M-2 0 H9 M-2 0 L9 9', class: 'n-brain-glyph' }, grp);
        for (const [cx, cy] of [[-11, 0], [9, -9], [9, 0], [9, 9]]) svg('rect', { x: cx - 2.5, y: cy - 2.5, width: 5, height: 5, class: 'n-brain-dot' }, grp);
        break;
      case 'station':
        svg('circle', { r: 15, class: 'n-halo' }, grp);
        svg('circle', { r: 9, class: 'n-st' }, grp);
        break;
      case 'gate':
        svg('rect', { x: -10, y: -10, width: 20, height: 20, transform: 'rotate(45)', class: 'n-gate' }, grp);
        break;
      case 'engine':
        svg('rect', { x: -20, y: -14, width: 40, height: 28, class: 'n-eng' }, grp);
        svg('path', { d: 'M-10 -4 H10 M-10 4 H4', class: 'n-eng-glyph' }, grp);
        break;
      case 'switch':
        svg('circle', { r: 7, class: 'n-sw' }, grp);
        break;
      case 'agg':
        svg('rect', { x: -26, y: -15, width: 52, height: 30, rx: 15, class: 'n-agg' }, grp);
        svg('path', { d: 'M-12 -5 L0 0 L-12 5 M0 0 H12', class: 'n-eng-glyph' }, grp);
        break;
    }
  }

  paintNode(n) {
    const { grp, label } = this.nodeEls.get(n.id);
    const c = lineVar(n.line);
    grp.style.setProperty('--c', c);
    label.style.setProperty('--c', c);
    grp.setAttribute('class', `node kind-${n.kind}${n.state ? ` st-${n.state}` : ''}`);
    label.classList.toggle('is-target', n.state === 'target');
    label.classList.toggle('is-muted', n.state === 'muted');
    label.classList.toggle('is-rejected', n.state === 'rejected');
    label.querySelector('.nl-name').textContent = n.name;
    const sub = label.querySelector('.nl-sub');
    sub.textContent = n.sub ?? '';
    sub.hidden = !n.sub;
    const metric = label.querySelector('.nl-metric');
    metric.hidden = !n.metric;
    if (n.metric) {
      if (typeof n.metric === 'string') metric.textContent = n.metric;
      else metric.innerHTML = `<span class="mbar"><i style="width:${Math.round(n.metric.w * 100)}%"></i></span><span>${n.metric.text}</span>`;
    }
    const badge = label.querySelector('.nl-badge');
    badge.hidden = !n.badge;
    if (n.badge) {
      badge.className = `nl-badge tone-${n.badge.tone}`;
      badge.textContent = n.badge.text;
    }
  }

  // ---------- 版面 ----------

  layout() {
    if (!this.graph) return;
    const W = this.root.clientWidth, H = this.root.clientHeight;
    if (!W || !H) return;
    const key = this.root.querySelector('.map-key');
    const padX = W < 600 ? 20 : 32, padTop = 28, padBottom = (key?.offsetHeight ?? 20) + 34;
    const aw = W - padX * 2, ah = H - padTop - padBottom;
    const cw = Math.min(aw, ah * 2.3);
    const ch = Math.min(ah, cw * (W < 600 ? 1.25 : 0.9));
    const ox = padX + (aw - cw) / 2, oy = padTop + (ah - ch) / 2;
    this.box = { W, H, ox, oy, cw, ch };
    this.svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

    this.gBack.replaceChildren();
    for (const lane of this.graph.lanes ?? []) {
      const x = this.P(lane.x0 ?? 0, 0).x, y0 = this.P(0, lane.y0).y, y1 = this.P(0, lane.y1).y;
      if (lane.y0 > 0.01) svg('line', { x1: x, x2: W - 24, y1: y0, y2: y0, class: 'lane-rule' }, this.gBack);
      svg('rect', { x: W - 34, y: y0 + 12, width: 10, height: 10, class: 'lane-chip', style: `--c:${lineVar(lane.line)}` }, this.gBack);
      const t = svg('text', { x: W - 42, y: y0 + 21.5, class: 'lane-label', 'text-anchor': 'end' }, this.gBack);
      t.textContent = lane.label;
    }
    for (const rg of this.graph.regions ?? []) {
      const a = this.P(rg.x0, rg.y0), b = this.P(rg.x1, rg.y1);
      svg('rect', { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y, class: 'region' }, this.gBack);
      const bg = svg('rect', { x: a.x + 10, y: a.y - 9, height: 18, class: 'region-label-bg' }, this.gBack);
      const t = svg('text', { x: a.x + 16, y: a.y + 4.5, class: 'region-label' }, this.gBack);
      t.textContent = rg.label;
      bg.setAttribute('width', t.getComputedTextLength() + 12);
    }

    for (const [k, e] of this.edges) {
      const els = this.edgeEls.get(k);
      const d = this.edgeD(e);
      els.base.setAttribute('d', d);
      els.paint.setAttribute('d', d);
      els.len = els.base.getTotalLength();
      this.paintEdge(k);
    }

    for (const n of this.nodes.values()) {
      const p = this.P(n.x, n.y);
      const { grp, label } = this.nodeEls.get(n.id);
      grp.setAttribute('transform', `translate(${p.x} ${p.y})`);
      label.style.left = `${p.x}px`;
      label.style.top = `${p.y}px`;
    }

    this.drawMarks();
    this.drawDecor();
    for (const dot of this.dots) this.placeDot(dot);
  }

  P(x, y) {
    const b = this.box;
    return { x: b.ox + x * b.cw, y: b.oy + y * b.ch };
  }

  px(id) {
    const n = this.nodes.get(id);
    return this.P(n.x, n.y);
  }

  edgeD(e) {
    const pts = [this.px(e.from), ...(e.via ?? []).map(([x, y]) => this.P(x, y)), this.px(e.to)];
    if (e.style === 'curve') {
      const [a, b] = [pts[0], pts[pts.length - 1]];
      const dx = b.x - a.x;
      return `M${a.x},${a.y} C${a.x + dx * 0.55},${a.y} ${b.x - dx * 0.45},${b.y} ${b.x},${b.y}`;
    }
    if (e.style === 'straight') return `M${pts.map((p) => `${p.x},${p.y}`).join(' L')}`;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) out.push(...octi(pts[i - 1], pts[i], e.bend ?? 0.5).slice(1));
    return rounded(out);
  }

  edgeColor(e) {
    if (e.color) return e.color;
    if (e.from === 'q') return 'var(--ink)';
    const to = this.nodes.get(e.to);
    if (to?.kind === 'station') return lineVar(to.line);
    return 'var(--ink)';
  }

  paintEdge(k) {
    const e = this.edges.get(k);
    const { base, paint, len } = this.edgeEls.get(k);
    paint.style.stroke = this.edgeColor(e);
    paint.style.strokeDasharray = `${len} ${len}`;
    paint.style.strokeDashoffset = `${len * (1 - e.progress)}`;
    paint.style.opacity = e.progress > 0 ? 1 : 0;
    if (e.weight != null) {
      base.style.stroke = this.edgeColor(e);
      base.style.opacity = 0.14 + 0.62 * e.weight;
      base.style.strokeWidth = `${2 + 7 * e.weight}px`;
    } else {
      base.style.stroke = base.style.opacity = base.style.strokeWidth = '';
    }
    base.classList.toggle('is-blocked', Boolean(e.blocked));
  }

  drawMarks() {
    this.gMarks.replaceChildren();
    for (const e of this.edges.values()) {
      if (!e.blocked) continue;
      const p = this.P(...e.blocked.at);
      const g = svg('g', { class: 'block-mark', transform: `translate(${p.x} ${p.y})` }, this.gMarks);
      svg('rect', { x: -12, y: -12, width: 24, height: 24 }, g);
      svg('path', { d: 'M-5 -5 L5 5 M5 -5 L-5 5' }, g);
      const t = svg('text', { x: 20, y: 5, class: 'block-text' }, g);
      t.textContent = e.blocked.text;
    }
  }

  drawDecor() {
    this.gDecor.replaceChildren();
    if (!this.graph.decor) return;
    this.graph.decor({
      P: (x, y) => this.P(x, y),
      node: (id) => this.px(id),
      make: (tag, attrs) => svg(tag, attrs, this.gDecor),
      state: this.decorState,
      box: this.box,
    });
  }

  // ---------- 小點 ----------

  addDot(at) {
    const g = svg('g', { class: 'dot' }, this.gDots);
    svg('circle', { r: 15, class: 'dot-halo' }, g);
    svg('circle', { r: 7, class: 'dot-core' }, g);
    const dot = { g, at };
    this.dots.push(dot);
    this.placeDot(dot);
    return dot;
  }

  placeDot(dot) {
    let p;
    const edge = dot.at.edge && this.edgeEls.get(dot.at.edge);
    if (edge && edge.len > 0) p = edge.base.getPointAtLength(edge.len * dot.at.t);
    else p = this.px(dot.at.node ?? this.edges.get(dot.at.edge).to);
    dot.g.setAttribute('transform', `translate(${p.x} ${p.y})`);
  }

  clearDots() {
    for (const d of this.dots) d.g.remove();
    this.dots = [];
  }

  // ---------- 動畫原語 ----------

  dur(ms) { return this.instant || this.reduced() ? 0 : ms * this.speed; }

  tween(ms, fn) {
    const id = this.run;
    const dur = this.dur(ms);
    return new Promise((resolve) => {
      if (dur <= 0) { fn(1); resolve(); return; }
      const t0 = performance.now();
      const frame = (now) => {
        if (id !== this.run) return resolve();
        const t = Math.min(1, (now - t0) / dur);
        fn(ease(t));
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  wait(ms) {
    const dur = this.dur(ms);
    return dur > 0 ? new Promise((r) => setTimeout(r, dur)) : Promise.resolve();
  }

  setNode(id, patch) {
    const n = this.nodes.get(id);
    if (!n) return;
    Object.assign(n, patch);
    this.paintNode(n);
  }

  async go(from, to, dot) {
    const k = key(from, to);
    const e = this.edges.get(k);
    if (!e) { console.warn('[map] missing edge', k); return; }
    dot ??= this.dots[0] ?? this.addDot({ node: from });
    if (!this.nodes.get(from).state) this.setNode(from, { state: 'visited' });
    const len = this.edgeEls.get(k).len;
    await this.tween(clamp(len * 2.2, 360, 950), (t) => {
      e.progress = t;
      this.paintEdge(k);
      dot.at = { edge: k, t };
      this.placeDot(dot);
    });
    dot.at = { node: to };
    this.placeDot(dot);
    const n = this.nodes.get(to);
    if (!n.state || n.state === 'muted') this.setNode(to, { state: 'visited' });
  }

  think(id, on, text) {
    const n = this.nodes.get(id);
    if (!n) return;
    this.setNode(id, { state: on ? 'thinking' : 'visited', badge: text ? { tone: on ? 'brain' : 'info', text } : n.badge });
  }

  // ---------- 播放步驟 ----------

  async play(steps, onTrace) {
    const id = this.run;
    for (const s of steps) {
      if (id !== this.run) return false;
      switch (s.t) {
        case 'move':
          await this.go(s.from, s.to);
          break;
        case 'parallel': {
          const main = this.dots[0];
          const extra = s.moves.slice(1).map(([from]) => this.addDot({ node: from }));
          await Promise.all(s.moves.map(([from, to], i) => this.go(from, to, i === 0 ? main : extra[i - 1])));
          for (const d of extra) { d.g.remove(); this.dots.splice(this.dots.indexOf(d), 1); }
          break;
        }
        case 'check':
          this.setNode(s.node, { badge: { tone: s.tone, text: s.text }, state: s.tone === 'fail' ? 'rejected' : this.nodes.get(s.node)?.state });
          await this.wait(s.tone === 'muted' || s.tone === 'no' ? 260 : 620);
          break;
        case 'mark':
          this.setNode(s.node, { badge: s.text ? { tone: s.tone, text: s.text } : null, state: s.tone === 'fail' ? 'rejected' : 'muted' });
          break;
        case 'weights':
          for (const it of s.items) {
            const e = this.edges.get(key(it.from, it.node));
            if (e) { e.weight = it.w; this.paintEdge(key(it.from, it.node)); }
            this.setNode(it.node, { metric: { w: it.w, text: it.text } });
          }
          await this.wait(700);
          break;
        case 'block': {
          const e = this.edges.get(key(s.from, s.to));
          if (e) { e.blocked = { at: s.at, text: s.text }; this.paintEdge(key(s.from, s.to)); this.drawMarks(); }
          this.setNode(s.to, { state: 'muted' });
          await this.wait(650);
          break;
        }
        case 'relabel':
          this.setNode(s.node, s.patch);
          if (s.patch.line) for (const [k, e] of this.edges) if (e.to === s.node) this.paintEdge(k);
          break;
        case 'decor':
          Object.assign(this.decorState, s.state);
          this.drawDecor();
          await this.wait(450);
          break;
        case 'arrive':
          this.setNode(s.node, { state: 'target' });
          this.clearDots();
          await this.wait(250);
          break;
      }
      if (id !== this.run) return false;
      if (s.trace) onTrace?.(s.trace);
    }
    return true;
  }
}
