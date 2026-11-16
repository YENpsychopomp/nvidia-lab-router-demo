// 路線圖（React Flow 版）：站點、軌道與平移縮放交給 React Flow，
// 版面座標與播放步驟沿用 RouteMap（map.js），所以兩種呈現方式的路由行為完全相同。
import { React, createRoot, ReactFlow, Handle, Position, ViewportPortal, applyNodeChanges } from '../vendor/flow-kit.js';
import { lineVar } from './catalog.js';
import { RouteMap } from './map.js';

const h = React.createElement;
const NS = 'http://www.w3.org/2000/svg';
const HOME = { x: 0, y: 0, zoom: 1 };
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.5;
const CENTER = [0.5, 0.5];
const GAP = 8;
// 站點圖形的外框（px）。React Flow 以這個外框當作節點大小，站牌另外定位在外側。
const SIZE = { source: [28, 28], brain: [44, 44], station: [22, 22], gate: [30, 30], engine: [40, 28], switch: [16, 16], agg: [66, 30] };
const BRAIN_DOTS = [[-11, 0], [9, -9], [9, 0], [9, 9]];

function svg(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

// ---------------------------------------------------------------- 節點與軌道元件

function Glyph({ kind, name }) {
  // 彙整器四面都有路線進出，名稱直接寫在圖形裡，不另外掛站牌。
  if (kind === 'agg') return h('div', { className: 'g-pill' }, name);
  const [w, ht] = SIZE[kind] ?? SIZE.switch;
  const box = { className: 'g', width: w, height: ht, viewBox: `${-w / 2} ${-ht / 2} ${w} ${ht}` };
  switch (kind) {
    case 'source':
      return h('svg', box, h('circle', { r: 12, className: 'g-ring' }), h('circle', { r: 6, className: 'g-core' }));
    case 'brain':
      // 一進三出的分流符號
      return h('svg', box,
        h('rect', { x: -22, y: -22, width: 44, height: 44, rx: 5, className: 'g-fill' }),
        h('path', { d: 'M-11 0 H-2 M-2 0 L9 -9 M-2 0 H9 M-2 0 L9 9', className: 'g-mark' }),
        BRAIN_DOTS.map(([cx, cy]) => h('rect', { key: `${cx},${cy}`, x: cx - 2.5, y: cy - 2.5, width: 5, height: 5, className: 'g-mark-dot' })));
    case 'station':
      return h('svg', box, h('circle', { r: 12, className: 'g-halo' }), h('circle', { r: 7.5, className: 'g-stop' }));
    case 'gate':
      return h('svg', box, h('rect', { x: -10, y: -10, width: 20, height: 20, rx: 2, transform: 'rotate(45)', className: 'g-stop' }));
    case 'engine':
      return h('svg', box, h('rect', { x: -19, y: -13, width: 38, height: 26, rx: 4, className: 'g-stop' }), h('path', { d: 'M-10 -4 H10 M-10 4 H4', className: 'g-mark' }));
    default:
      return h('svg', box, h('circle', { r: 6, className: 'g-stop' }));
  }
}

function Metric({ m, slot }) {
  if (m == null) {
    // 清單式站牌先保留量表的位置，數值出現時版面才不會跳動。
    return slot ? h('div', { className: 'sign-metric is-empty' }, h('span', { className: 'mbar' }, h('i', { style: { width: 0 } })), h('span', { className: 'mnum' })) : null;
  }
  if (typeof m === 'string') return h('div', { className: 'sign-metric' }, m);
  return h('div', { className: 'sign-metric' },
    h('span', { className: 'mbar' }, h('i', { style: { width: `${Math.round(m.w * 100)}%` } })),
    h('span', { className: 'mnum' }, m.text));
}

function Sign({ n }) {
  const name = h('div', { className: 'sign-name' }, n.name);
  const sub = n.sub ? h('div', { className: 'sign-sub' }, n.sub) : null;
  // 以文字當 key：內容換了就重新掛載，出現的動畫才會重播。
  const badge = n.badge ? h('div', { key: n.badge.text, className: `sign-badge tone-${n.badge.tone}` }, n.badge.text) : null;
  if (n.kind === 'agg') return badge ? h('div', { className: 'sign' }, h('div', { className: 'sign-notes' }, badge)) : null;
  if (n.row) {
    return h('div', { className: 'sign' },
      h('div', { className: 'sign-plate' }, h(Metric, { m: n.metric, slot: true }), name, sub),
      badge ? h('div', { className: 'sign-notes' }, badge) : null);
  }
  const metric = h(Metric, { m: n.metric });
  return h('div', { className: 'sign' },
    h('div', { className: n.kind === 'station' ? 'sign-plate' : 'sign-text' }, name, sub),
    n.metric != null || badge ? h('div', { className: 'sign-notes' }, metric, badge) : null);
}

function StopNode({ data: n }) {
  const [w, ht] = SIZE[n.kind] ?? SIZE.switch;
  // 站牌能用的寬度很窄時（站點排得密、模型名稱又長）改用小一號的字。
  const tight = !n.row && n.maxw < 124;
  const cls = ['stop', `kind-${n.kind}`, `lp-${n.lp ?? 'b'}`, n.row && 'is-row', tight && 'is-tight', n.state && `st-${n.state}`].filter(Boolean).join(' ');
  const style = { width: w, height: ht, '--c': lineVar(n.line), '--on': n.line ? `var(--on-${n.line})` : 'var(--paper)', '--maxw': `${n.maxw}px`, '--i': n.order };
  return h('div', { className: cls, style },
    h(Handle, { type: 'target', position: Position.Left, isConnectable: false }),
    h(Handle, { type: 'source', position: Position.Right, isConnectable: false }),
    n.kind === 'brain' ? h('i', { className: 'think-ring' }) : null,
    h(Glyph, { kind: n.kind, name: n.name }),
    h(Sign, { n }));
}

function TrackEdge({ id, data }) {
  const { map, k } = data;
  const e = map.edges.get(k);
  if (!e || !data.d) return null;
  const cls = ['rt', e.dashed && 'is-dashed', e.blocked && 'is-blocked', e.weight != null && 'is-weighted'].filter(Boolean).join(' ');
  // 權重（相似度、負載）以軌道粗細與濃淡表示。
  const road = e.weight != null ? { stroke: data.color, opacity: 0.16 + 0.6 * e.weight, strokeWidth: 2 + 7 * e.weight } : undefined;
  return h('g', { className: cls },
    h('path', { className: 'rt-road', d: data.d, style: road }),
    // 走過的路段：長度正規化為 1，進度由 FlowMap 直接寫入 stroke-dashoffset，不經過 React。
    h('path', { className: 'rt-paint', d: data.d, pathLength: 1, style: { stroke: data.color }, ref: (el) => map.bindPaint(id, k, el) }));
}

const NODE_TYPES = { stop: StopNode };
const EDGE_TYPES = { track: TrackEdge };

function FlowView({ map }) {
  const snap = React.useSyncExternalStore(map.subscribe, map.getSnapshot);
  return h(ReactFlow, {
    nodes: snap.nodes,
    edges: snap.edges,
    nodeTypes: NODE_TYPES,
    edgeTypes: EDGE_TYPES,
    onNodesChange: map.onNodesChange,
    onInit: map.onInit,
    onMove: map.onMove,
    nodeOrigin: CENTER,
    defaultViewport: HOME,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    translateExtent: snap.extent,
    nodesDraggable: false,
    nodesConnectable: false,
    nodesFocusable: false,
    edgesFocusable: false,
    elementsSelectable: false,
    // 窄螢幕時路線圖在可捲動的頁面裡，停用平移縮放，把捲動留給頁面。
    panOnDrag: snap.interactive,
    zoomOnScroll: snap.interactive,
    zoomOnPinch: snap.interactive,
    zoomOnDoubleClick: false,
    preventScrolling: snap.interactive,
    disableKeyboardA11y: true,
    deleteKeyCode: null,
    selectionKeyCode: null,
    multiSelectionKeyCode: null,
    panActivationKeyCode: null,
    zoomActivationKeyCode: null,
    'aria-label': '路由路線圖。每一步判斷的文字版本列在「決策軌跡」。',
  },
  h(ViewportPortal, null,
    h('svg', { className: 'flow-layer flow-back', ref: map.refBack, 'aria-hidden': true }),
    h('svg', { className: 'flow-layer flow-decor', ref: map.refDecor, 'aria-hidden': true }),
    h('svg', { className: 'flow-layer flow-marks', ref: map.refMarks, 'aria-hidden': true }),
    h('div', { className: 'flow-layer flow-tokens', ref: map.refTokens, 'aria-hidden': true })));
}

// ---------------------------------------------------------------- FlowMap

export class FlowMap extends RouteMap {
  constructor(root) {
    super(root);
    this.seq = 0;
    this.cargo = '';
    this.layers = {};
    this.paintEls = new Map();
    this.sig = new Map();
    this.listeners = new Set();
    this.snap = { nodes: [], edges: [], extent: undefined, interactive: false };
    this.view = HOME;
    this.onView = null;
    this.shape = '';
    this.size = '';

    root.classList.add('is-flow');
    // .map-flow 是外框；窄螢幕時畫布（.map-canvas）比外框寬，可以左右捲動。
    this.scroller = root.querySelector('.map-flow');
    if (!this.scroller) {
      this.scroller = document.createElement('div');
      this.scroller.className = 'map-flow';
      root.prepend(this.scroller);
    }
    this.canvas = document.createElement('div');
    this.canvas.className = 'map-canvas';
    this.scroller.replaceChildren(this.canvas);
    this.scroller.addEventListener('scroll', () => this.markScroll(), { passive: true });
    // 只用來量測路徑長度與取點，不顯示。
    this.measure = svg('svg', { class: 'flow-measure', width: 0, height: 0, 'aria-hidden': 'true' }, root);
    this.wide = matchMedia('(min-width: 861px)');
    this.wide.addEventListener('change', () => this.layout());
    createRoot(this.canvas).render(h(FlowView, { map: this }));
  }

  // ---------- 與 React 之間的狀態 ----------

  subscribe = (fn) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  getSnapshot = () => this.snap;

  commit(patch) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  // React Flow 量到節點尺寸後回報；保留在節點上，之後更新內容時才不會重新量測而閃爍。
  onNodesChange = (changes) => {
    const dims = changes.filter((c) => c.type === 'dimensions');
    if (dims.length) this.commit({ nodes: applyNodeChanges(dims, this.snap.nodes) });
  };

  onInit = (rf) => { this.rf = rf; };
  onMove = (_event, viewport) => { this.view = viewport; this.emitView(); };

  refBack = (el) => { this.layers.back = el; if (el) this.drawBack(); };
  refDecor = (el) => { this.layers.decor = el; if (el) this.drawDecor(); };
  refMarks = (el) => { this.layers.marks = el; if (el) this.drawMarks(); };
  refTokens = (el) => { this.layers.tokens = el; if (el) for (const d of this.dots) el.appendChild(d.g); };

  // ---------- 檢視：平移與縮放 ----------

  viewState() {
    const { x, y, zoom } = this.rf?.getViewport() ?? this.view;
    return {
      interactive: this.snap.interactive,
      canZoomIn: zoom < MAX_ZOOM - 0.01,
      canZoomOut: zoom > MIN_ZOOM + 0.01,
      moved: Math.abs(zoom - 1) > 0.005 || Math.abs(x) > 0.5 || Math.abs(y) > 0.5,
    };
  }

  emitView() { this.onView?.(this.viewState()); }

  async zoomBy(dir) {
    if (!this.rf) return;
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.rf.getViewport().zoom * (dir > 0 ? 1.3 : 1 / 1.3)));
    await this.rf.zoomTo(zoom, { duration: this.reduced() ? 0 : 220 });
    this.emitView();
  }

  async resetView(animate = false) {
    await this.rf?.setViewport(HOME, { duration: animate && !this.reduced() ? 260 : 0 });
    this.view = HOME;
    this.emitView();
  }

  // ---------- 建立與版面 ----------

  load(graph, opts) {
    // 先移除再由 RouteMap.load 加回，進場動畫才會從頭播放。
    this.root.classList.remove('is-intro');
    super.load(graph, opts);
    // 換了一張不同的圖才回到完整檢視；重播同一張圖時保留使用者的縮放位置。
    const shape = graph.nodes.map((n) => `${n.id}@${n.x},${n.y}`).join('|');
    if (shape !== this.shape) { this.shape = shape; this.resetView(); }
  }

  build() {
    this.seq++;
    this.sig = new Map();
    this.edgeEls = new Map();
    this.layers.tokens?.replaceChildren();
    this.scroller.scrollLeft = 0;
  }

  measureBox() {
    // 窄螢幕：路線圖在可捲動的頁面裡，停用平移縮放，畫布維持最小寬度並可左右捲動。
    const interactive = this.wide.matches;
    this.root.classList.toggle('is-static', !interactive);
    const W = this.canvas.clientWidth, H = this.root.clientHeight;
    if (!W || !H) return false;
    const legend = this.root.querySelector('.map-key');
    const narrow = W < 520;
    const padX = narrow ? 22 : 40, padTop = interactive ? 50 : 34, padBottom = (legend?.offsetHeight ?? 20) + 44;
    const aw = W - padX * 2, ah = H - padTop - padBottom;
    const cw = Math.min(aw, ah * 2.3);
    const ch = Math.min(ah, cw * (narrow ? 1.25 : 0.9));
    this.box = { W, H, ox: padX + (aw - cw) / 2, oy: padTop + (ah - ch) / 2, cw, ch };
    return true;
  }

  layout() {
    if (!this.graph) return;
    this.measureBox();
    this.rebuild();
    const size = `${this.box.W}x${this.box.H}`;
    if (size !== this.size) { this.size = size; this.resetView(); }
  }

  rebuild() {
    const prev = new Map(this.snap.nodes.map((n) => [n.id, n]));
    this.measure.replaceChildren();
    for (const [k, e] of this.edges) {
      const d = this.edgeD(e);
      const base = svg('path', { d }, this.measure);
      this.edgeEls.set(k, { base, d, len: base.getTotalLength() });
    }
    const order = [...this.nodes.values()].sort((a, b) => a.x - b.x || a.y - b.y).map((n) => n.id);
    const nodes = [...this.nodes.values()].map((n) => this.rfNode(n, prev.get(n.id), order.indexOf(n.id)));
    const { W, H } = this.box;
    const interactive = this.wide.matches;
    this.commit({ nodes, edges: this.rfEdges(), interactive, extent: W > 1 ? [[-W * 0.5, -H * 0.5], [W * 1.5, H * 1.5]] : undefined });
    this.drawBack();
    this.drawMarks();
    this.drawDecor();
    for (const dot of this.dots) this.placeDot(dot);
    this.markScroll();
    this.emitView();
  }

  // 畫布比外框寬時，標示左右兩側還有沒有內容（CSS 以漸淡邊緣提示可以捲動）。
  markScroll() {
    const s = this.scroller;
    const max = s.scrollWidth - s.clientWidth;
    s.classList.toggle('more-left', s.scrollLeft > 4);
    s.classList.toggle('more-right', max - s.scrollLeft > 4);
  }

  // 窄螢幕播放時讓畫面跟著問題走。
  follow(x) {
    const s = this.scroller;
    const max = s.scrollWidth - s.clientWidth;
    if (max > 0) s.scrollLeft = Math.max(0, Math.min(max, x - s.clientWidth * 0.42));
  }

  rfNode(n, prev, order) {
    const p = this.P(n.x, n.y);
    const node = {
      // 站點永遠疊在軌道上面（走過的路段 z-index 為 1）。
      id: n.id, type: 'stop', position: p, zIndex: 2,
      data: { ...n, maxw: this.signMax(n, p), order },
      draggable: false, selectable: false, focusable: false, connectable: false, deletable: false,
    };
    if (prev?.measured && prev.data.kind === n.kind) node.measured = prev.measured;
    return node;
  }

  // 站牌最多能有多寬：不超出圖紙，也不壓到同一排的鄰站。
  signMax(n, p) {
    const { W } = this.box;
    if (W <= 1) return 160;
    const lp = n.lp ?? 'b';
    const off = (SIZE[n.kind]?.[0] ?? 16) / 2 + GAP;
    // 右側界線：有層級標示時讓出邊欄，有區域框時留在框內，否則到圖紙邊緣。
    const regions = this.graph.regions;
    const right = regions ? this.P(Math.max(...regions.map((r) => r.x1)), 0).x - 10 : W - (this.graph.lanes ? 30 : 12);
    if (lp === 'r') return Math.max(72, right - p.x - off);
    if (lp === 'l') return Math.max(72, p.x - off - 14);
    if (lp === 'br') return Math.max(72, Math.min(190, right - p.x - 2));
    let max = Math.min(n.maxw ?? 172, 2 * (Math.min(p.x, W - p.x) - (this.graph.lanes ? 30 : 10)));
    for (const o of this.nodes.values()) {
      if (o === n || (o.lp ?? 'b') !== lp) continue;
      const q = this.P(o.x, o.y);
      if (Math.abs(q.y - p.y) < 44) max = Math.min(max, Math.abs(q.x - p.x) - 12);
    }
    return Math.max(64, max);
  }

  rfEdges() {
    return [...this.edges].map(([k, e]) => {
      const color = this.edgeColor(e);
      this.sig.set(k, this.edgeSig(e, color));
      return {
        id: `${this.seq}:${k}`, source: e.from, target: e.to, type: 'track',
        // 走過的路段疊在還沒走的軌道上面。
        zIndex: e.active || e.progress > 0 ? 1 : 0,
        data: { map: this, k, d: this.edgeEls.get(k)?.d ?? '', color },
        focusable: false, selectable: false, deletable: false, reconnectable: false,
      };
    });
  }

  edgeSig(e, color) { return `${color}|${e.weight}|${e.blocked ? 1 : 0}|${e.active ? 1 : 0}`; }

  // ---------- 繪製 ----------

  paintNode(n) {
    const i = this.snap.nodes.findIndex((x) => x.id === n.id);
    if (i < 0) return;
    const nodes = this.snap.nodes.slice();
    nodes[i] = { ...nodes[i], data: { ...nodes[i].data, ...n } };
    this.commit({ nodes });
  }

  bindPaint(id, k, el) {
    if (!el) { this.paintEls.delete(id); return; }
    this.paintEls.set(id, el);
    if (id === `${this.seq}:${k}`) this.applyProgress(k);
  }

  applyProgress(k) {
    const e = this.edges.get(k);
    const el = this.paintEls.get(`${this.seq}:${k}`);
    if (!e || !el) return;
    el.style.strokeDashoffset = String(1 - e.progress);
    el.style.opacity = e.progress > 0 ? '1' : '0';
  }

  paintEdge(k) {
    const e = this.edges.get(k);
    if (!e) return;
    this.applyProgress(k);
    // 顏色、權重或封鎖狀態變了才請 React 重畫；每一格動畫只動上面兩個樣式。
    if (this.sig.get(k) !== this.edgeSig(e, this.edgeColor(e))) this.commit({ edges: this.rfEdges() });
  }

  drawBack() {
    const g = this.layers.back;
    if (!g || !this.graph) return;
    g.replaceChildren();
    const defs = svg('defs', {}, g);
    const pat = svg('pattern', { id: 'hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    svg('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch-line' }, pat);
    const { W } = this.box;
    // 服務層級：橫線分隔，右側邊欄以路線色色條與直排文字標示。
    for (const lane of this.graph.lanes ?? []) {
      const x = this.P(lane.x0 ?? 0, 0).x, y0 = this.P(0, lane.y0).y, y1 = this.P(0, lane.y1).y;
      if (lane.y0 > 0.01) svg('line', { x1: x, x2: W - 10, y1: y0, y2: y0, class: 'lane-rule' }, g);
      svg('rect', { x: W - 7, y: y0 + 5, width: 3, height: Math.max(0, y1 - y0 - 10), rx: 1.5, class: 'lane-chip', style: `--c:${lineVar(lane.line)}` }, g);
      svg('text', { x: W - 17, y: (y0 + y1) / 2, class: 'lane-label' }, g).textContent = lane.label;
    }
    for (const rg of this.graph.regions ?? []) {
      const a = this.P(rg.x0, rg.y0), b = this.P(rg.x1, rg.y1);
      svg('rect', { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y, rx: 6, class: `region region-${rg.line}` }, g);
      const bg = svg('rect', { x: a.x + 10, y: a.y - 10, height: 20, rx: 3, class: 'region-label-bg' }, g);
      const t = svg('text', { x: a.x + 17, y: a.y + 4.5, class: 'region-label' }, g);
      t.textContent = rg.label;
      bg.setAttribute('width', t.getComputedTextLength() + 14);
    }
  }

  drawMarks() {
    if (!this.layers.marks) return;
    this.gMarks = this.layers.marks;
    super.drawMarks();
  }

  drawDecor() {
    if (!this.layers.decor || !this.graph) return;
    this.gDecor = this.layers.decor;
    super.drawDecor();
  }

  // ---------- 問題（沿路線移動的點） ----------

  addDot(at) {
    const g = document.createElement('div');
    g.className = 'token';
    g.appendChild(document.createElement('i')).className = 'token-dot';
    if (this.cargo) {
      const chip = g.appendChild(document.createElement('span'));
      chip.className = 'token-chip';
      chip.textContent = this.cargo;
    }
    this.layers.tokens?.appendChild(g);
    const dot = { g, at };
    this.dots.push(dot);
    this.placeDot(dot);
    return dot;
  }

  placeDot(dot) {
    const edge = dot.at.edge && this.edgeEls.get(dot.at.edge);
    const p = edge && edge.len > 0
      ? edge.base.getPointAtLength(edge.len * dot.at.t)
      : this.px(dot.at.node ?? this.edges.get(dot.at.edge).to);
    dot.g.style.transform = `translate(${p.x}px, ${p.y}px)`;
    if (dot === this.dots[0] && !this.wide.matches) this.follow(p.x);
  }

  async go(from, to, dot) {
    const e = this.edges.get(`${from}>${to}`);
    if (e && !e.active) { e.active = true; this.commit({ edges: this.rfEdges() }); }
    return super.go(from, to, dot);
  }
}
