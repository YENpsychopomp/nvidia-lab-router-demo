// 路由策略：每個策略定義一張路線圖（graph）與一個決策函式（decide）。
// decide 產生動畫步驟，地圖依序播放；同一份 SystemOne 訊號可以餵給所有策略比較。
import { MODELS, estimate, formatCost, formatSeconds } from './catalog.js';
import { SIGNALS, hash, rng } from './brain.js';

const pct = (p) => `${Math.round(p * 100)}%`;
const f2 = (v) => Number(v).toFixed(2);
const LV = SIGNALS.find((s) => s.key === 'complexity').levels;
const DOMAIN_NAMES = SIGNALS.find((s) => s.key === 'domain').options;
const level = (s) => Math.max(0, Math.min(4, Math.round(s.complexity.level)));
const sensitivity = (s) => Math.max(s.contains_pii.p, s.sensitivity.probs.confidential ?? 0);

const Q = (x, y) => ({ id: 'q', kind: 'source', x, y, name: '使用者問題', lp: 't' });
const BRAIN = (x, y, sub) => ({ id: 'brain', kind: 'brain', x, y, name: 'SystemOne', sub, lp: 'b' });
const ST = (model, x, y, o = {}) => ({ id: model, kind: 'station', model, x, y, lp: 'b', ...o });
const GATE = (id, x, y, name, o = {}) => ({ id, kind: 'gate', x, y, name, lp: 't', ...o });
const E = (from, to, o = {}) => ({ from, to, ...o });

class Route {
  steps = [];
  go(from, to, trace) { this.steps.push({ t: 'move', from, to, trace }); return this; }
  all(moves, trace) { this.steps.push({ t: 'parallel', moves, trace }); return this; }
  check(node, tone, text, trace) { this.steps.push({ t: 'check', node, tone, text, trace }); return this; }
  mark(node, tone, text, trace) { this.steps.push({ t: 'mark', node, tone, text, trace }); return this; }
  weights(items, trace) { this.steps.push({ t: 'weights', items, trace }); return this; }
  block(from, to, at, text, trace) { this.steps.push({ t: 'block', from, to, at, text, trace }); return this; }
  relabel(node, patch) { this.steps.push({ t: 'relabel', node, patch }); return this; }
  decor(state) { this.steps.push({ t: 'decor', state }); return this; }
  note(trace) { this.steps.push({ t: 'note', trace }); return this; }
  arrive(node, model, detail) {
    const m = MODELS[model];
    this.steps.push({ t: 'arrive', node, trace: { title: `抵達 ${m.name}`, detail: detail ?? `${m.role}，部署於${m.where}。`, tone: 'arrive', line: m.line } });
    return this;
  }
  done(node, model, reason, extra = {}) { return { node, model, reason, steps: this.steps, ...extra }; }
}

// ---------------------------------------------------------------- 能力分層

const cascade = {
  id: 'cascade', group: '能力分層', name: '階層式', en: 'Cascade', glyph: 'cascade',
  summary: '先交給地端小模型，信心不足再逐層升級到地端大模型，最後才用雲端模型。',
  uses: ['small_ok', 'large_ok'],
  controls: [{ id: 'th', type: 'range', label: '接受門檻', min: 0.3, max: 0.9, step: 0.05, value: 0.6, format: f2 }],
  graph: () => ({
    lanes: [
      { x0: 0.31, y0: 0.0, y1: 0.34, label: '雲端', line: 'cloud' },
      { x0: 0.31, y0: 0.34, y1: 0.66, label: '地端機房', line: 'dc' },
      { x0: 0.31, y0: 0.66, y1: 1.0, label: '地端邊緣', line: 'edge' },
    ],
    // 階梯往右上爬升，站牌放在右下角才不會壓到進出站的斜線。
    nodes: [Q(0.05, 0.5), BRAIN(0.19, 0.5, '預測各層可處理機率'), ST('gemma', 0.4, 0.83), ST('llama', 0.56, 0.5, { lp: 'br' }), ST('gpt5', 0.72, 0.17, { lp: 'br' })],
    edges: [E('q', 'brain'), E('brain', 'gemma'), E('gemma', 'llama'), E('llama', 'gpt5')],
  }),
  decide(s, c) {
    const r = new Route();
    const tiers = [['gemma', s.small_ok.p, '地端小模型'], ['llama', s.large_ok.p, '地端大模型']];
    r.go('brain', 'gemma');
    for (let i = 0; i < tiers.length; i++) {
      const [id, p, name] = tiers[i];
      if (p >= c.th) {
        r.check(id, 'pass', `可處理 ${f2(p)} ≥ ${f2(c.th)}`, { title: `${name}信心足夠`, detail: `可處理機率 ${pct(p)}，達到門檻 ${pct(c.th)}，直接採用這一層。`, tone: 'pass' });
        r.arrive(id, id);
        return r.done(id, id, `${name}可處理機率 ${pct(p)}，達到門檻，不必升級。`);
      }
      const next = i === 0 ? 'llama' : 'gpt5';
      r.check(id, 'fail', `可處理 ${f2(p)} < ${f2(c.th)}`, { title: `${name}信心不足`, detail: `可處理機率 ${pct(p)}，低於門檻 ${pct(c.th)}，升級到${i === 0 ? '地端大模型' : '雲端模型'}。`, tone: 'fail' });
      r.go(id, next);
    }
    r.check('gpt5', 'pass', '最上層，直接接受', { title: '雲端模型為最後一層', detail: '前兩層都未達門檻，由雲端旗艦模型回答。', tone: 'info' });
    r.arrive('gpt5', 'gpt5');
    return r.done('gpt5', 'gpt5', `地端兩層的可處理機率都低於 ${pct(c.th)}，升級到雲端。`);
  },
};

const routellm = {
  id: 'routellm', group: '能力分層', name: '強弱二分', en: 'RouteLLM', glyph: 'fork',
  summary: '預測「強模型會明顯勝出」的機率，超過門檻 α 才用雲端強模型，否則交給地端弱模型。',
  uses: ['strong_gain'],
  controls: [{ id: 'alpha', type: 'range', label: '門檻 α', min: 0.1, max: 0.9, step: 0.05, value: 0.35, format: f2 }],
  graph: () => ({
    nodes: [
      Q(0.05, 0.5), BRAIN(0.2, 0.5, '預測強模型勝率'),
      GATE('gate', 0.44, 0.5, '勝率門檻 α'),
      ST('gpt5', 0.78, 0.2, { lp: 'r', sub: '強模型' }), ST('llama', 0.78, 0.8, { lp: 'r', sub: '弱模型' }),
    ],
    edges: [E('q', 'brain'), E('brain', 'gate'), E('gate', 'gpt5'), E('gate', 'llama')],
  }),
  decide(s, c) {
    const r = new Route();
    const p = s.strong_gain.p;
    r.go('brain', 'gate');
    if (p >= c.alpha) {
      r.check('gate', 'yes', `${f2(p)} ≥ α ${f2(c.alpha)}`, { title: '強模型預期明顯較好', detail: `勝率 ${pct(p)} 高於門檻 α = ${f2(c.alpha)}，值得付出雲端成本。`, tone: 'pass' });
      r.mark('llama', 'muted', '未採用');
      r.go('gate', 'gpt5').arrive('gpt5', 'gpt5');
      return r.done('gpt5', 'gpt5', `強模型勝率 ${pct(p)} ≥ α，改用雲端強模型。`);
    }
    r.check('gate', 'no', `${f2(p)} < α ${f2(c.alpha)}`, { title: '弱模型就夠好', detail: `強模型勝率只有 ${pct(p)}，低於 α = ${f2(c.alpha)}，交給地端模型以節省成本。`, tone: 'info' });
    r.mark('gpt5', 'muted', '未採用');
    r.go('gate', 'llama').arrive('llama', 'llama');
    return r.done('llama', 'llama', `強模型勝率 ${pct(p)} < α，地端模型即可。`);
  },
};

const COST_LINE = ['gemma', 'llama', 'mini', 'gpt5'];
const REQUIRED = [1.5, 2.0, 3.0, 3.8, 4.6];
const cost = {
  id: 'cost', group: '能力分層', name: '成本最佳化', en: 'Cost-aware', glyph: 'cost',
  summary: '依難度估算所需品質，從最便宜的模型開始找，選第一個品質達標的模型。',
  uses: ['complexity', 'high_stakes', 'long_output'],
  controls: [],
  graph: () => ({
    nodes: [
      Q(0.04, 0.7), BRAIN(0.15, 0.7, '估算所需品質'),
      ...COST_LINE.map((id, i) => ST(id, 0.32 + i * 0.195, 0.7, { sub: `$${MODELS[id].price[0]} ／ $${MODELS[id].price[1]}`, maxw: 132 })),
    ],
    edges: [E('q', 'brain'), E('brain', 'gemma', { style: 'straight' }), E('gemma', 'llama', { style: 'straight' }), E('llama', 'mini', { style: 'straight' }), E('mini', 'gpt5', { style: 'straight' })],
    decor: drawQualityBars,
    note: '單價為每百萬 tokens 輸入／輸出（示意）',
  }),
  decide(s, c, ctx) {
    const r = new Route();
    const lvl = level(s);
    const req = Math.min(5, REQUIRED[lvl] + (s.high_stakes.p >= 0.5 ? 0.4 : 0));
    r.decor({ required: req });
    r.note({ title: `所需品質 ${req.toFixed(1)}`, detail: `難度「${LV[lvl]}」${s.high_stakes.p >= 0.5 ? '，且錯誤代價高（+0.4）' : ''}。從最便宜的模型往右找。`, tone: 'info' });
    let prev = 'brain';
    for (const id of COST_LINE) {
      const m = MODELS[id];
      r.go(prev, id);
      if (m.quality >= req || id === 'gpt5') {
        const est = estimate(id, s, ctx.text);
        const base = estimate('gpt5', s, ctx.text);
        const save = base.cost > 0 ? Math.floor((1 - est.cost / base.cost) * 100) / 100 : 0;
        r.check(id, 'pass', `品質 ${m.quality.toFixed(1)} ≥ ${req.toFixed(1)}`, { title: `${m.name} 品質達標`, detail: `預估費用 ${formatCost(est.cost)}，比全用 ${MODELS.gpt5.name} 省 ${pct(save)}。`, tone: 'pass' });
        r.arrive(id, id);
        return r.done(id, id, `最便宜且品質達標（${m.quality.toFixed(1)} ≥ ${req.toFixed(1)}），省 ${pct(save)}。`);
      }
      r.check(id, 'fail', `品質 ${m.quality.toFixed(1)} < ${req.toFixed(1)}`, { title: `${m.name} 品質不足`, detail: `品質 ${m.quality.toFixed(1)} 低於所需 ${req.toFixed(1)}，往下一個較貴的模型。`, tone: 'fail' });
      prev = id;
    }
  },
};

function drawQualityBars(api) {
  const { node, make, P, state } = api;
  const top = P(0, 0.1).y;
  let left = Infinity, right = -Infinity, base = 0, maxH = 0;
  for (const id of COST_LINE) {
    const n = node(id);
    const m = MODELS[id];
    base = n.y - 30;
    maxH = base - top;
    const h = (m.quality / 5) * maxH;
    left = Math.min(left, n.x - 28);
    right = Math.max(right, n.x + 28);
    make('rect', { x: n.x - 18, y: base - h, width: 36, height: h, class: 'q-bar', style: `--c: var(--line-${m.line})` });
    make('text', { x: n.x, y: base - h + 18, class: 'decor-text bar-val', 'text-anchor': 'middle', style: `fill: var(--on-${m.line})` }).textContent = m.quality.toFixed(1);
  }
  make('text', { x: left - 36, y: top - 4, class: 'decor-text' }).textContent = '品質分數（滿分 5）';
  if (state.required != null) {
    const y = base - (state.required / 5) * maxH;
    make('line', { x1: left - 36, x2: right + 16, y1: y, y2: y, class: 'req-line' });
    make('text', { x: left - 36, y: y - 8, class: 'decor-text strong' }).textContent = `所需品質 ${state.required.toFixed(1)}`;
  }
}

// ---------------------------------------------------------------- 內容理解

const DOMAINS = [
  ['coding', 'coder'], ['math', 'reason'], ['legal', 'gpt5'], ['medical', 'med'], ['finance', 'gpt5'],
  ['translation', 'taide'], ['creative', 'gpt5'], ['knowledge', 'llama'], ['chitchat', 'gemma'],
];
const semantic = {
  id: 'semantic', group: '內容理解', name: '語意路由', en: 'Semantic', glyph: 'fan',
  summary: '比對問題與各領域路由的語意相似度，送往最相近的專家模型。',
  uses: ['domain'],
  controls: [{ id: 'min', type: 'range', label: '最低相似度', min: 0.1, max: 0.7, step: 0.05, value: 0.35, format: f2 }],
  graph: () => ({
    nodes: [
      Q(0.05, 0.5), BRAIN(0.2, 0.5, '語意相似度比對'),
      ...DOMAINS.map(([d, model], i) => ST(model, 0.5, 0.06 + i * (0.88 / 8), { id: `d_${d}`, lp: 'r', row: true, name: DOMAIN_NAMES[d], sub: MODELS[model].name })),
    ],
    edges: [E('q', 'brain'), ...DOMAINS.map(([d]) => E('brain', `d_${d}`, { style: 'curve' }))],
  }),
  decide(s, c) {
    const r = new Route();
    const probs = s.domain.probs;
    r.weights(DOMAINS.map(([d]) => ({ node: `d_${d}`, from: 'brain', w: probs[d] ?? 0, text: pct(probs[d] ?? 0) })), {
      title: '計算各路由相似度', detail: DOMAINS.map(([d]) => [d, probs[d] ?? 0]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, p]) => `${DOMAIN_NAMES[d]} ${pct(p)}`).join('、'), tone: 'info',
    });
    let [top, p] = DOMAINS.map(([d]) => [d, probs[d] ?? 0]).sort((a, b) => b[1] - a[1])[0];
    let reason = `最相近的路由是「${DOMAIN_NAMES[top]}」（${pct(p)}）。`;
    if (p < c.min) {
      r.note({ title: '相似度不足，改走預設路由', detail: `最高只有 ${pct(p)}，低於 ${pct(c.min)}，退回一般知識路由。`, tone: 'warn' });
      reason = `最高相似度 ${pct(p)} 低於門檻，退回一般知識路由。`;
      top = 'knowledge';
    }
    const model = DOMAINS.find(([d]) => d === top)[1];
    r.go('brain', `d_${top}`).arrive(`d_${top}`, model, `「${DOMAIN_NAMES[top]}」路由，由 ${MODELS[model].role}回答。`);
    return r.done(`d_${top}`, model, reason);
  },
};

const LANGS = [['zh-TW', '繁體中文', 'taide'], ['zh-CN', '簡體中文', 'multi'], ['en', '英文', 'llama'], ['ja', '日文', 'gpt5'], ['other', '其他語言', 'gpt5']];
const language = {
  id: 'language', group: '內容理解', name: '語言路由', en: 'Language', glyph: 'lang',
  summary: '辨識使用者的語言，交給該語言表現最好的模型，例如繁中走在地模型。',
  uses: ['language'],
  controls: [],
  graph: () => ({
    nodes: [
      Q(0.05, 0.5), BRAIN(0.22, 0.5, '辨識語言'),
      ...LANGS.map(([k, label, model], i) => ST(model, 0.5, 0.12 + i * 0.19, { id: `g_${k}`, lp: 'r', row: true, name: label, sub: MODELS[model].name })),
    ],
    edges: [E('q', 'brain'), ...LANGS.map(([k]) => E('brain', `g_${k}`, { style: 'curve' }))],
  }),
  decide(s) {
    const r = new Route();
    const probs = s.language.probs;
    const name = (k) => LANGS.find(([key]) => key === k)?.[1] ?? k;
    const sc = s.language.script;
    if (s.language.corrected) {
      r.note({ title: '依字形修正語言判斷', detail: `SystemOne 判斷為${name(s.language.corrected.from)}，但文字含繁體字 ${sc.trad} 個、簡體字 ${sc.simp} 個，修正為${name(s.language.choice)}。`, tone: 'warn' });
    }
    r.weights(LANGS.map(([k]) => ({ node: `g_${k}`, from: 'brain', w: probs[k] ?? 0, text: pct(probs[k] ?? 0) })), { title: '語言辨識結果', detail: `${name(s.language.choice)}，信心 ${pct(s.language.confidence)}${sc && !s.language.corrected ? `；字形檢查一致（繁 ${sc.trad}、簡 ${sc.simp}）` : ''}。`, tone: 'info' });
    const [k, label, model] = LANGS.find(([key]) => key === s.language.choice) ?? LANGS[4];
    r.go('brain', `g_${k}`).arrive(`g_${k}`, model);
    return r.done(`g_${k}`, model, `判斷為${label}（${pct(s.language.confidence)}），交給 ${MODELS[model].name}。`);
  },
};

const RULES = [
  { id: 's1', label: '隱私關鍵字', re: /(身分證|身份證|病歷|密碼|帳號|電話|住址|地址|[A-Z][12]\d{8}|09\d{8})/i, model: 'llama' },
  { id: 's2', label: '程式關鍵字', re: /(程式|code|python|java|sql|bug|debug|函式|function|api)/i, model: 'coder' },
  { id: 's3', label: '翻譯請求', re: /(翻譯|翻成|譯成|translate)/i, model: 'taide' },
  { id: 's4', label: '15 字以內', test: (t) => [...t.trim()].length <= 15, model: 'gemma' },
];
const rules = {
  id: 'rules', group: '內容理解', name: '規則路由', en: 'Rule-based', glyph: 'rules', usesBrain: false,
  summary: '不呼叫路由大腦，由上而下比對關鍵字規則，第一條命中的規則決定去向。',
  uses: [],
  controls: [],
  graph: () => ({
    nodes: [
      Q(0.05, 0.06), { id: 'engine', kind: 'engine', x: 0.34, y: 0.06, name: '規則引擎', sub: '由上而下比對', lp: 'r' },
      ...RULES.map((ru, i) => ({ id: ru.id, kind: 'switch', x: 0.34, y: 0.23 + i * 0.17, name: ru.label, lp: 'l' })),
      ...RULES.map((ru, i) => ST(ru.model, 0.62, 0.23 + i * 0.17, { lp: 'r' })),
      ST('gpt5', 0.34, 0.94, { sub: '預設路由', lp: 'r' }),
    ],
    edges: [
      E('q', 'engine', { style: 'straight' }), E('engine', 's1', { style: 'straight' }), E('s1', 's2', { style: 'straight' }),
      E('s2', 's3', { style: 'straight' }), E('s3', 's4', { style: 'straight' }), E('s4', 'gpt5', { style: 'straight' }),
      ...RULES.map((ru) => E(ru.id, ru.model, { style: 'straight' })),
    ],
  }),
  decide(_s, _c, ctx) {
    const r = new Route();
    r.note({ title: '此策略不呼叫 SystemOne', detail: '只靠預先寫好的關鍵字規則，速度快但無法理解語意。', tone: 'info' });
    let prev = 'engine';
    for (const ru of RULES) {
      r.go(prev, ru.id);
      const m = ru.re ? ctx.text.match(ru.re) : ru.test(ctx.text) ? [ctx.text.trim()] : null;
      if (m) {
        const hitText = ru.re ? `命中「${m[0]}」` : `命中（${[...ctx.text.trim()].length} 字）`;
        r.check(ru.id, 'yes', hitText, { title: `規則「${ru.label}」命中`, detail: `${hitText}，轉往 ${MODELS[ru.model].name}。`, tone: 'pass' });
        r.go(ru.id, ru.model).arrive(ru.model, ru.model);
        return r.done(ru.model, ru.model, `規則「${ru.label}」${hitText}。`);
      }
      r.check(ru.id, 'no', '未命中', { title: `規則「${ru.label}」未命中`, detail: '繼續比對下一條規則。', tone: 'info' });
      prev = ru.id;
    }
    r.go('s4', 'gpt5').arrive('gpt5', 'gpt5', '沒有任何規則命中，走預設路由。');
    return r.done('gpt5', 'gpt5', '沒有規則命中，走預設的雲端模型。');
  },
};

// ---------------------------------------------------------------- 限制條件

// 地端大模型應付不來，需要雲端能力。
const needsCloud = (s, lvl) => lvl >= 3 || s.large_ok.p < 0.5;

const privacy = {
  id: 'privacy', group: '限制條件', name: '隱私合規', en: 'Privacy', glyph: 'shield',
  // 送往雲端的請求（含歷史對話）會在伺服器先經過 PII 模型去識別化。
  deidentifyCloud: true,
  summary: '偵測個資與機密內容；敏感資料只能留在地端，必要時先去識別化才送雲端。',
  uses: ['contains_pii', 'sensitivity', 'complexity', 'large_ok'],
  controls: [{ id: 'th', type: 'range', label: '敏感門檻', min: 0.2, max: 0.9, step: 0.05, value: 0.5, format: f2 }],
  graph: () => ({
    regions: [
      { x0: 0.0, y0: 0.02, x1: 1.0, y1: 0.4, label: '雲端', line: 'cloud' },
      { x0: 0.0, y0: 0.5, x1: 1.0, y1: 0.99, label: '地端信任邊界：資料不出機房', line: 'dc' },
    ],
    nodes: [
      Q(0.05, 0.68), BRAIN(0.19, 0.68, '偵測個資與機密'),
      GATE('gate', 0.42, 0.68, '含敏感資料？', { lp: 'b' }),
      { id: 'mask', kind: 'engine', x: 0.58, y: 0.45, name: '去識別化閘道', lp: 'r' },
      ST('gpt5', 0.72, 0.13, { lp: 'br' }), ST('llama', 0.64, 0.68, { lp: 'r' }), ST('gemma', 0.64, 0.86, { lp: 'r' }),
    ],
    edges: [
      E('q', 'brain'), E('brain', 'gate'),
      E('gate', 'gpt5', { via: [[0.42, 0.13]] }), E('gate', 'mask'), E('mask', 'gpt5', { bend: 1 }),
      E('gate', 'llama'), E('gate', 'gemma'),
    ],
  }),
  decide(s, c) {
    const r = new Route();
    const sv = sensitivity(s);
    const lvl = level(s);
    r.go('brain', 'gate');
    if (sv >= c.th) {
      r.check('gate', 'warn', `敏感 ${f2(sv)} ≥ ${f2(c.th)}`, { title: '偵測到敏感資料', detail: `個資機率 ${pct(s.contains_pii.p)}，機密機率 ${pct(s.sensitivity.probs.confidential ?? 0)}。禁止原文送往雲端。`, tone: 'warn' });
      r.block('gate', 'gpt5', [0.42, 0.45], '封鎖', { title: '封鎖直連雲端', detail: '依資料治理政策，含個資的原文不可離開地端。', tone: 'block' });
      // 與無敏感資料時的判斷一致：地端大模型應付不來（難度「困難」以上，或 70B 可勝任機率不到一半）
      // 就需要雲端能力，這時先去識別化再送出；否則留在地端。
      if (needsCloud(s, lvl)) {
        const why = lvl >= 3 ? `難度「${LV[lvl]}」` : `70B 模型可勝任機率只有 ${pct(s.large_ok.p)}`;
        r.go('gate', 'mask');
        r.check('mask', 'pass', '已遮罩個資', { title: '先去識別化', detail: `${why}，需要雲端能力。遮罩身分證、電話等欄位後才放行。`, tone: 'pass' });
        r.go('mask', 'gpt5').arrive('gpt5', 'gpt5', '收到的是去識別化後的內容。');
        return r.done('gpt5', 'gpt5', `含敏感資料且${why}：遮罩個資後送雲端。`);
      }
      const id = lvl <= 1 ? 'gemma' : 'llama';
      r.go('gate', id).arrive(id, id, '資料全程留在地端機房。');
      return r.done(id, id, `含敏感資料（${pct(sv)}），留在地端處理。`);
    }
    r.check('gate', 'pass', `敏感 ${f2(sv)} < ${f2(c.th)}`, { title: '未偵測到敏感資料', detail: `可以依難度「${LV[lvl]}」自由選擇地端或雲端。`, tone: 'pass' });
    const id = needsCloud(s, lvl) ? 'gpt5' : lvl <= 1 ? 'gemma' : 'llama';
    r.go('gate', id).arrive(id, id);
    return r.done(id, id, `無敏感資料，依難度「${LV[lvl]}」選擇${MODELS[id].role}。`);
  },
};

const LAT_MIN = 0.3, LAT_MAX = 20;
const latX = (t) => 0.3 + 0.62 * (Math.log(Math.max(LAT_MIN, Math.min(LAT_MAX, t)) / LAT_MIN) / Math.log(LAT_MAX / LAT_MIN));
const LAT_LINE = [['gemma', 'b'], ['llama', 't'], ['gpt5', 'b'], ['reason', 't']];
const BUDGET = { realtime: 1.5, standard: 8, deep: Infinity };
const BUDGET_NAME = { realtime: '即時', standard: '一般', deep: '深度' };
const latency = {
  id: 'latency', group: '限制條件', name: '延遲預算', en: 'Latency SLA', glyph: 'clock',
  summary: '依使用者期待的回覆速度設定時間預算，在預算內挑品質最好的模型（含目前佇列）。',
  uses: ['urgency', 'needs_reasoning'],
  controls: [],
  graph: () => ({
    nodes: [
      Q(0.05, 0.42), BRAIN(0.17, 0.42, '判斷回覆時效'),
      ...LAT_LINE.map(([id, lp]) => ST(id, latX(MODELS[id].p50), 0.42, { lp })),
    ],
    edges: [E('q', 'brain'), E('brain', 'gemma', { style: 'straight' }), E('gemma', 'llama', { style: 'straight' }), E('llama', 'gpt5', { style: 'straight' }), E('gpt5', 'reason', { style: 'straight' })],
    decor: drawLatencyAxis,
  }),
  decide(s, _c, ctx) {
    const r = new Route();
    const u = s.urgency.choice;
    const budget = BUDGET[u] ?? 8;
    const rnd = rng(ctx.seed);
    const queue = { gemma: rnd() * 0.3, llama: rnd() * 1.6, gpt5: rnd() * 3, reason: rnd() * 4 };
    const quality = (id) => (id === 'reason' && s.needs_reasoning.p >= 0.6 ? 5.2 : MODELS[id].quality);
    const eff = (id) => MODELS[id].p50 + queue[id];
    r.decor({ budget, label: Number.isFinite(budget) ? `時間預算 ${formatSeconds(budget)}` : '不限時間' });
    r.note({ title: `回覆時效：${BUDGET_NAME[u]}`, detail: Number.isFinite(budget) ? `時間預算 ${formatSeconds(budget)}，含各節點目前的佇列等待。` : '使用者重視品質，不設時間上限。', tone: 'info' });
    for (const [id] of LAT_LINE) r.relabel(id, { metric: `${formatSeconds(eff(id))}（佇列 ${formatSeconds(queue[id])}）` });
    const ok = LAT_LINE.map(([id]) => id).filter((id) => eff(id) <= budget);
    const best = ok.length ? ok.reduce((b, id) => (quality(id) > quality(b) ? id : b)) : 'gemma';
    const order = LAT_LINE.map(([id]) => id);
    let prev = 'brain';
    for (const id of order.slice(0, order.indexOf(best) + 1)) {
      r.go(prev, id);
      if (id !== best) r.check(id, 'muted', '預算內，續找更好的');
      prev = id;
    }
    for (const id of order.slice(order.indexOf(best) + 1)) {
      if (eff(id) > budget) r.mark(id, 'fail', `超出預算 ${formatSeconds(eff(id))}`);
      else r.mark(id, 'muted', '品質較低');
    }
    if (!ok.length) {
      r.check(best, 'warn', '全部超出預算', { title: '沒有模型能在預算內完成', detail: '改用最快的地端小模型先回覆。', tone: 'warn' });
    } else {
      r.check(best, 'pass', `預算內品質最高`, { title: `${MODELS[best].name} 在預算內`, detail: `預估 ${formatSeconds(eff(best))} 開始回覆，是預算內品質最高的選擇。`, tone: 'pass' });
    }
    r.arrive(best, best);
    return r.done(best, best, Number.isFinite(budget) ? `在 ${formatSeconds(budget)}的時間預算內品質最高（預估 ${formatSeconds(eff(best))}）。` : '不限時間，選品質最高的模型。');
  },
};

function drawLatencyAxis(api) {
  const { make, P, node, state, box } = api;
  const y = P(0, 0.82).y;
  const x0 = P(latX(LAT_MIN), 0).x, x1 = P(latX(LAT_MAX), 0).x;
  if (state.budget != null) {
    const bx = Number.isFinite(state.budget) ? P(latX(state.budget), 0).x : x1;
    if (Number.isFinite(state.budget)) make('rect', { x: bx, y: box.oy, width: Math.max(0, box.ox + box.cw - bx), height: y - box.oy, class: 'over-zone' });
    make('line', { x1: bx, x2: bx, y1: box.oy + 4, y2: y, class: 'budget-line' });
    make('text', { x: bx - 8, y: box.oy + 18, class: 'decor-text strong', 'text-anchor': 'end' }).textContent = state.label;
  }
  make('line', { x1: x0, x2: x1, y1: y, y2: y, class: 'axis' });
  for (const t of [0.5, 1, 2, 5, 10, 20]) {
    const x = P(latX(t), 0).x;
    make('line', { x1: x, x2: x, y1: y - 4, y2: y + 4, class: 'axis' });
    make('text', { x, y: y + 20, class: 'decor-text', 'text-anchor': 'middle' }).textContent = t < 1 ? `${t * 1000} ms` : `${t} 秒`;
  }
  make('text', { x: x0, y: y + 42, class: 'decor-text' }).textContent = '首字延遲（對數尺度）';
  for (const [id] of LAT_LINE) {
    const n = node(id);
    make('line', { x1: n.x, x2: n.x, y1: n.y + 12, y2: y - 6, class: 'drop-line' });
  }
}

// ---------------------------------------------------------------- 可靠與規模

const ensemble = {
  id: 'ensemble', group: '可靠與規模', name: '多模型共識', en: 'Ensemble', glyph: 'merge',
  summary: '高風險或高難度的問題同時問三個模型，再由彙整器交叉比對出最終答案。',
  uses: ['high_stakes', 'complexity'],
  controls: [],
  graph: () => ({
    nodes: [
      Q(0.04, 0.5), BRAIN(0.15, 0.5, '評估風險與難度'),
      GATE('gate', 0.33, 0.5, '需要共識？'),
      ST('llama', 0.67, 0.14, { maxw: 112 }), ST('gpt5', 0.67, 0.5, { maxw: 112 }), ST('reason', 0.67, 0.86, { maxw: 112 }),
      { id: 'agg', kind: 'agg', x: 0.95, y: 0.5, name: '彙整器', sub: `${MODELS.gpt5.name} 交叉比對`, lp: 'b' },
    ],
    // 三條路線平行前進：出門後分開、到彙整器前才收攏，站牌放在各自路線的下方。
    edges: [
      E('q', 'brain'), E('brain', 'gate'),
      E('gate', 'llama', { bend: 0.4 }), E('gate', 'gpt5'), E('gate', 'reason', { bend: 0.4 }),
      E('llama', 'agg', { bend: 1 }), E('gpt5', 'agg'), E('reason', 'agg', { bend: 1 }),
    ],
  }),
  decide(s) {
    const r = new Route();
    const lvl = level(s);
    const need = s.high_stakes.p >= 0.5 || lvl >= 3;
    r.go('brain', 'gate');
    if (!need) {
      r.check('gate', 'no', '單一模型即可', { title: '不需要多模型共識', detail: `錯誤代價 ${pct(s.high_stakes.p)}、難度「${LV[lvl]}」，用單一地端大模型回答。`, tone: 'info' });
      r.mark('gpt5', 'muted', '未呼叫').mark('reason', 'muted', '未呼叫');
      r.go('gate', 'llama').arrive('llama', 'llama');
      return r.done('llama', 'llama', '低風險問題，不需要共識，單一模型回答。');
    }
    r.check('gate', 'yes', s.high_stakes.p >= 0.5 ? `錯誤代價 ${pct(s.high_stakes.p)}` : `難度 ${LV[lvl]}`, { title: '啟動多模型共識', detail: '同時向三個模型提問，降低單一模型出錯的風險。', tone: 'warn' });
    r.all([['gate', 'llama'], ['gate', 'gpt5'], ['gate', 'reason']], { title: '平行送出 3 個請求', detail: `${MODELS.llama.name}、${MODELS.gpt5.name}、${MODELS.reason.name} 同時作答。`, tone: 'info' });
    r.check('llama', 'pass', '候選答案 A').check('gpt5', 'pass', '候選答案 B').check('reason', 'pass', '候選答案 C');
    r.all([['llama', 'agg'], ['gpt5', 'agg'], ['reason', 'agg']], { title: '彙整三份答案', detail: '比對一致之處、標記分歧，產生最終答案。', tone: 'info' });
    r.steps.push({ t: 'arrive', node: 'agg', trace: { title: '抵達彙整器', detail: `由 ${MODELS.gpt5.name} 交叉比對三份候選答案後回覆。`, tone: 'arrive', line: 'cloud' } });
    return r.done('agg', 'gpt5', '高風險或高難度：三個模型作答後彙整。', { label: '三模型共識' });
  },
};

const fallback = {
  id: 'fallback', group: '可靠與規模', name: '容錯備援', en: 'Fallback', glyph: 'detour',
  summary: '先送主要節點；逾時或錯誤時自動改走備援節點，並提醒品質是否降級。',
  uses: ['complexity'],
  controls: [
    { id: 'cloudDown', type: 'toggle', label: '模擬雲端中斷', value: true },
    { id: 'dcDown', type: 'toggle', label: '模擬機房中斷', value: false },
  ],
  graph: () => ({
    nodes: [
      Q(0.05, 0.5), BRAIN(0.18, 0.5, '評估最低可接受層級'),
      ST('gpt5', 0.38, 0.5, { sub: '主要節點' }), ST('llama', 0.63, 0.5, { sub: '備援節點 1' }), ST('gemma', 0.88, 0.5, { sub: '備援節點 2' }),
    ],
    edges: [E('q', 'brain'), E('brain', 'gpt5'), E('gpt5', 'llama', { dashed: true }), E('llama', 'gemma', { dashed: true })],
  }),
  decide(s, c) {
    const r = new Route();
    const lvl = level(s);
    r.go('brain', 'gpt5');
    if (!c.cloudDown) {
      r.check('gpt5', 'pass', '健康檢查正常', { title: '主要節點正常', detail: `${MODELS.gpt5.name} 健康檢查通過，直接回覆。`, tone: 'pass' });
      r.arrive('gpt5', 'gpt5');
      return r.done('gpt5', 'gpt5', '主要節點正常。');
    }
    r.check('gpt5', 'fail', '逾時 3.0 秒', { title: '主要節點逾時', detail: `${MODELS.gpt5.name} 3 秒內沒有回應，觸發備援。`, tone: 'fail' });
    r.go('gpt5', 'llama');
    if (!c.dcDown) {
      r.check('llama', 'pass', '備援成功', { title: '改由地端大模型接手', detail: lvl >= 4 ? `難度「${LV[lvl]}」略高於地端能力，回覆會附註品質可能降低。` : '品質足以處理這個問題。', tone: lvl >= 4 ? 'warn' : 'pass' });
      r.arrive('llama', 'llama');
      return r.done('llama', 'llama', '雲端逾時，由地端大模型接手。');
    }
    r.check('llama', 'fail', '503 無法服務', { title: '備援節點 1 也失敗', detail: '地端機房回傳 503，繼續往下一個備援。', tone: 'fail' });
    r.go('llama', 'gemma');
    r.check('gemma', lvl >= 2 ? 'warn' : 'pass', lvl >= 2 ? '品質降級' : '備援成功', { title: '最後備援：地端小模型', detail: lvl >= 2 ? `難度「${LV[lvl]}」超出小模型能力，回覆會標示「降級服務」。` : '問題簡單，小模型足以應付。', tone: lvl >= 2 ? 'warn' : 'pass' });
    r.arrive('gemma', 'gemma');
    return r.done('gemma', 'gemma', '雲端與機房都中斷，降級到地端小模型。');
  },
};

const POOLS = [
  { model: 'gemma', names: ['邊緣節點 A', '邊緣節點 B', '邊緣節點 C'], cap: [1, 1, 2] },
  { model: 'llama', names: ['GPU 節點 01', 'GPU 節點 02', 'GPU 節點 03'], cap: [2, 1, 2] },
  { model: 'gpt5', names: ['日本東部', '東南亞', '美國西部'], cap: [2, 2, 1] },
];
const loadbalance = {
  id: 'loadbalance', group: '可靠與規模', name: '負載平衡', en: 'Load balancing', glyph: 'spread',
  summary: '先依難度選擇服務層級，再把請求送到該層「佇列 ÷ 容量」最低的節點。',
  uses: ['complexity'],
  controls: [],
  graph: () => ({
    nodes: [
      Q(0.05, 0.5), BRAIN(0.18, 0.5, '決定服務層級'),
      { id: 'lb', kind: 'engine', x: 0.4, y: 0.5, name: '負載平衡器', sub: '佇列 ÷ 容量最低', lp: 'b' },
      ...[0, 1, 2].map((i) => ({ id: `r${i}`, kind: 'station', x: 0.7, y: 0.16 + i * 0.34, name: `節點 ${'ABC'[i]}`, sub: '等待分派', lp: 'r', line: 'dc' })),
    ],
    edges: [E('q', 'brain'), E('brain', 'lb'), ...[0, 1, 2].map((i) => E('lb', `r${i}`))],
  }),
  decide(s, _c, ctx) {
    const r = new Route();
    const lvl = level(s);
    const pool = POOLS[lvl <= 1 ? 0 : lvl <= 3 ? 1 : 2];
    const m = MODELS[pool.model];
    const rnd = rng(ctx.seed ^ 0x9e37);
    const queue = pool.cap.map(() => Math.floor(rnd() * 9));
    const score = queue.map((q, i) => q / pool.cap[i]);
    const best = score.indexOf(Math.min(...score));
    r.go('brain', 'lb');
    r.check('lb', 'info', `${m.role}池`, { title: `難度「${LV[lvl]}」：使用${m.role}池`, detail: `${m.name}，部署於${m.where}，共 3 個節點。`, tone: 'info' });
    pool.names.forEach((name, i) => r.relabel(`r${i}`, { name, sub: m.name, line: m.line }));
    r.weights(pool.names.map((_, i) => ({ node: `r${i}`, from: 'lb', w: 1 - Math.min(1, score[i] / 8), text: `佇列 ${queue[i]} ÷ 容量 ${pool.cap[i]}` })), {
      title: '比較各節點負載', detail: pool.names.map((n, i) => `${n} ${score[i].toFixed(1)}`).join('、'), tone: 'info',
    });
    r.go('lb', `r${best}`).arrive(`r${best}`, pool.model, `${pool.names[best]}負載最低（${score[best].toFixed(1)}）。`);
    return r.done(`r${best}`, pool.model, `${m.role}池中，${pool.names[best]}負載最低。`);
  },
};

// ---------------------------------------------------------------- 組合

const hybrid = {
  id: 'hybrid', group: '組合', name: '綜合策略', en: 'Policy tree', glyph: 'tree',
  summary: '把隱私、即時性、領域與難度串成一棵決策樹，模擬正式環境的路由政策。',
  uses: ['contains_pii', 'sensitivity', 'needs_fresh', 'domain', 'complexity', 'high_stakes', 'large_ok'],
  controls: [],
  graph: () => {
    const ys = [0.24, 0.38, 0.52, 0.66, 0.8];
    const x = 0.34;
    return {
      nodes: [
        Q(0.05, 0.07), { ...BRAIN(x, 0.07, '一次取得所有訊號'), lp: 'r' },
        GATE('d1', x, ys[0], '敏感資料？', { lp: 'l' }), GATE('d2', x, ys[1], '需即時資訊？', { lp: 'l' }), GATE('d3', x, ys[2], '程式任務？', { lp: 'l' }),
        GATE('d4', x, ys[3], '高難度或高風險？', { lp: 'l' }), GATE('d5', x, ys[4], '只是寒暄？', { lp: 'l' }),
        ST('llama', 0.62, ys[0], { id: 'p_llama', sub: '隱私保護', lp: 'r' }), ST('search', 0.62, ys[1], { lp: 'r' }), ST('coder', 0.62, ys[2], { lp: 'r' }),
        ST('gpt5', 0.62, ys[3], { lp: 'r' }), ST('gemma', 0.62, ys[4], { lp: 'r' }), ST('llama', x, 0.95, { sub: '預設路由', lp: 'r' }),
      ],
      edges: [
        E('q', 'brain', { style: 'straight' }), E('brain', 'd1', { style: 'straight' }), E('d1', 'd2', { style: 'straight' }), E('d2', 'd3', { style: 'straight' }),
        E('d3', 'd4', { style: 'straight' }), E('d4', 'd5', { style: 'straight' }), E('d5', 'llama', { style: 'straight' }),
        E('d1', 'p_llama', { style: 'straight' }), E('d2', 'search', { style: 'straight' }), E('d3', 'coder', { style: 'straight' }),
        E('d4', 'gpt5', { style: 'straight' }), E('d5', 'gemma', { style: 'straight' }),
      ],
    };
  },
  decide(s) {
    const r = new Route();
    const lvl = level(s);
    const sv = sensitivity(s);
    const coding = s.domain.choice === 'coding' || (s.domain.probs.coding ?? 0) >= 0.5;
    const hard = lvl >= 4 || s.high_stakes.p >= 0.6 || s.large_ok.p < 0.5;
    const tests = [
      ['d1', '含敏感資料', sv >= 0.5, f2(sv), `敏感機率 ${pct(sv)}`, 'p_llama', 'llama', '含敏感資料，留在地端機房。'],
      ['d2', '需要即時資訊', s.needs_fresh.p >= 0.5, f2(s.needs_fresh.p), `即時資訊機率 ${pct(s.needs_fresh.p)}`, 'search', 'search', '需要即時資訊，使用雲端模型加網路搜尋。'],
      ['d3', '屬於程式任務', coding, pct(s.domain.probs.coding ?? 0), `程式領域機率 ${pct(s.domain.probs.coding ?? 0)}`, 'coder', 'coder', '程式任務，交給地端程式專家。'],
      ['d4', '高難度或高風險', hard, LV[lvl], `70B 可勝任 ${pct(s.large_ok.p)}，錯誤代價 ${pct(s.high_stakes.p)}`, 'gpt5', 'gpt5', '超出地端模型能力或錯誤代價高，使用雲端旗艦模型。'],
      ['d5', '只是寒暄', lvl === 0 || s.domain.choice === 'chitchat', LV[lvl], `難度「${LV[lvl]}」，領域「${DOMAIN_NAMES[s.domain.choice]}」`, 'gemma', 'gemma', '簡單寒暄，地端小模型即可。'],
    ];
    let prev = 'brain';
    for (const [id, name, yes, text, detail, node, model, reason] of tests) {
      r.go(prev, id);
      if (yes) {
        r.check(id, 'yes', `是 ${text}`, { title: `條件成立：${name}`, detail: `${detail}。${reason}`, tone: 'pass' });
        r.go(id, node).arrive(node, model);
        return r.done(node, model, reason);
      }
      r.check(id, 'no', `否 ${text}`, { title: `不成立：${name}`, detail: `${detail}，繼續往下判斷。`, tone: 'info' });
      prev = id;
    }
    r.go('d5', 'llama').arrive('llama', 'llama', '所有條件都不成立，走預設路由。');
    return r.done('llama', 'llama', '一般問題，走預設的地端大模型。');
  },
};

export const MODES = [cascade, routellm, cost, semantic, language, rules, privacy, latency, ensemble, fallback, loadbalance, hybrid];
export const MODE_MAP = Object.fromEntries(MODES.map((m) => [m.id, m]));

export function defaultControls() {
  return Object.fromEntries(MODES.map((m) => [m.id, Object.fromEntries(m.controls.map((c) => [c.id, c.value]))]));
}

export function decideAll(signals, controls, ctx) {
  return MODES.map((m) => {
    try { return { mode: m, decision: m.decide(signals, controls[m.id], ctx) }; }
    catch (err) { return { mode: m, error: err }; }
  });
}

export const seedFor = (text) => hash(text);
