// 主控：左側對話（固定 auto 模型）、右側路由播放與檢視器。
import { MODELS, LINES, TIER_MODELS, TIER_LABEL, lineVar, estimate, formatCost, formatSeconds, applyTiers, execution } from './catalog.js';
import { SIGNALS, askBrain, hash } from './brain.js';
import { MODES, MODE_MAP, defaultControls, decideAll } from './modes.js';
import { RouteMap } from './map.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const truncate = (s, n) => ([...s].length > n ? `${[...s].slice(0, n).join('')}…` : s);
const pct = (p) => `${Math.round(p * 100)}%`;

const store = {
  get(k, fallback) { try { const v = localStorage.getItem(`router-demo:${k}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(`router-demo:${k}`, JSON.stringify(v)); } catch { /* 無痕模式等情況下略過 */ } },
};

// 範例問題依類別分組；每一題在不同策略下會走到不同的路線，方便展示。
const EXAMPLE_GROUPS = [
  { name: '日常', items: [
    { kind: '閒聊', text: '早安！今天有點累，推薦一首適合早上聽的歌' },
    { kind: '單一事實', text: '台灣最高的山是哪一座？' },
    { kind: '改寫', text: '幫我把這段話改得更有禮貌：明天的會議我不去了，你們自己開' },
    { kind: '翻譯', text: '把這句翻成英文：本公司將於下一季推出可地端部署的 AI 助理' },
  ] },
  { name: '不同語言', items: [
    { kind: '簡體中文', text: '帮我写一段周末去爬山的朋友圈文案，轻松一点' },
    { kind: '日文', text: '来週の会議の議題を三つ提案してください' },
    { kind: '英文', text: 'Explain the difference between TCP and UDP in simple terms' },
  ] },
  { name: '專業領域', items: [
    { kind: '程式', text: '用 Python 實作一個 LRU Cache，並說明每個操作的時間複雜度' },
    { kind: '除錯', text: '這段 SQL 很慢該怎麼優化：SELECT * FROM orders WHERE YEAR(created_at) = 2023' },
    { kind: '數學', text: '證明根號 2 是無理數，並說明每一步的推理' },
    { kind: '醫療', text: '我爸爸有高血壓，正在吃降血壓藥，可以同時吃止痛藥嗎？劑量要注意什麼？' },
    { kind: '法律', text: '房東不退押金，依台灣法律我可以怎麼處理？' },
  ] },
  { name: '隱私與機密', items: [
    { kind: '個資', text: '我的身分證字號是 A123456789，電話 0912345678，請幫我寫一份請假申請書' },
    { kind: '個資＋分析', text: '我的身分證字號是 A123456789，請比較三種保險方案的優缺點並分析哪個最適合我' },
    { kind: '公司內部', text: '這是公司內部未公開的營收資料，請整理成一頁摘要：Q3 營收 12 億，毛利率 38%' },
  ] },
  { name: '深度與即時', items: [
    { kind: '深度分析', text: '比較 Transformer 與 Mamba 架構在長文本推理上的優缺點，並提出三個值得研究的方向' },
    { kind: '系統設計', text: '設計一個每秒處理十萬筆訂單的電商結帳系統，說明架構與取捨' },
    { kind: '長篇輸出', text: '寫一篇 1500 字的報告，介紹台灣半導體產業的發展歷程' },
    { kind: '即時資訊', text: '今天台積電的股價是多少？最近有什麼重大新聞？' },
  ] },
];
const EXAMPLES = EXAMPLE_GROUPS.flatMap((g) => g.items);

// ---------------------------------------------------------------- 狀態

const state = {
  cfg: { brainModel: 'Microsoft-Decision-1', chatModel: 'auto', hasKey: false, endpoint: '' },
  settings: { simulate: false, speed: 1, brainModel: '', ...store.get('settings', {}) },
  modeId: store.get('mode', 'cascade'),
  controls: defaultControls(),
  messages: [],
  queries: new Map(),
  currentQ: null,
  streaming: null,
  brainError: null,
  trace: [],
};
if (!MODE_MAP[state.modeId]) state.modeId = 'cascade';

// 路線圖預設使用 React Flow 版本（flow.js）；載入失敗或網址帶 ?map=classic 時，
// 退回內建的 SVG 版本（map.js）。兩者介面相同，其餘程式不必區分。
async function createMap(root) {
  if (new URLSearchParams(location.search).get('map') !== 'classic') {
    try {
      const { FlowMap } = await import('./flow.js');
      return new FlowMap(root);
    } catch (err) {
      root.classList.remove('is-flow');
      console.warn('[map] React Flow 路線圖無法載入，改用內建的 SVG 路線圖。', err);
    }
  }
  root.classList.add('is-classic');
  return new RouteMap(root);
}

const map = await createMap($('#map'));
let playToken = 0;
let qSeq = 0;
let mSeq = 0;

const brainModel = () => state.settings.brainModel || state.cfg.brainModel;
const tiered = () => Boolean(state.cfg.chatTiers);
const simulate = () => state.settings.simulate || !state.cfg.hasKey;
const mode = () => MODE_MAP[state.modeId];
const currentQuery = () => state.queries.get(state.currentQ) ?? null;

// 決策實際落在哪一層（LOW / MID / HIGH），路線編號牌用這個字母與顏色。
function tierOf(decision) {
  return decision.label ? 'high' : MODELS[decision.model]?.tier ?? 'mid';
}
function bullet(tier) {
  return `<span class="bullet t-${tier}" aria-label="${TIER_LABEL[tier]} 層">${TIER_LABEL[tier][0]}</span>`;
}

// ---------------------------------------------------------------- 策略列與標題

function renderStrategies() {
  const groups = [];
  for (const m of MODES) {
    let g = groups.find((x) => x.name === m.group);
    if (!g) groups.push((g = { name: m.group, modes: [] }));
    g.modes.push(m);
  }
  $('#strategies').innerHTML = groups.map((g) => `
    <div class="s-group" role="group" aria-label="${esc(g.name)}">
      <span class="s-label" aria-hidden="true">${esc(g.name)}</span>
      <div class="s-list">${g.modes.map((m) => `<button class="strat" type="button" data-mode="${m.id}" aria-pressed="${m.id === state.modeId}" title="${esc(m.summary)}">${esc(m.name)}</button>`).join('')}</div>
    </div>`).join('');
}

function renderModeHead() {
  const m = mode();
  $('#modeName').textContent = m.name;
  $('#modeEn').textContent = m.en;
  $('#modeSummary').textContent = m.summary;
  for (const b of document.querySelectorAll('.strat')) b.setAttribute('aria-pressed', String(b.dataset.mode === m.id));
  const box = $('#modeControls');
  box.replaceChildren();
  for (const c of m.controls) {
    const v = state.controls[m.id][c.id];
    const label = document.createElement('label');
    label.className = `ctl${c.type === 'toggle' ? ' toggle' : ''}`;
    if (c.type === 'range') {
      label.innerHTML = `<span>${esc(c.label)}</span><input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${v}"><output>${c.format(v)}</output>`;
      const input = label.querySelector('input');
      const out = label.querySelector('output');
      input.addEventListener('input', () => { out.textContent = c.format(Number(input.value)); });
      input.addEventListener('change', () => onControl(c.id, Number(input.value)));
    } else {
      label.innerHTML = `<input type="checkbox" role="switch" class="switch"${v ? ' checked' : ''}><span>${esc(c.label)}</span>`;
      label.querySelector('input').addEventListener('change', (e) => onControl(c.id, e.target.checked));
    }
    box.appendChild(label);
  }
}

function onControl(id, value) {
  state.controls[state.modeId][id] = value;
  refreshDerived();
  const q = currentQuery();
  if (q) playRoute(q);
}

function selectMode(id) {
  if (!MODE_MAP[id]) return;
  state.modeId = id;
  store.set('mode', id);
  renderModeHead();
  refreshDerived();
  const q = currentQuery();
  if (q) playRoute(q);
  else idleMap();
}

function renderLegend() {
  $('#legend').innerHTML = LINES.map((l) => `<li><i style="--c:${lineVar(l.id)}"></i>${esc(l.label)}</li>`).join('') +
    '<li><i class="sq" style="--c:var(--ink)"></i>SystemOne</li><li><i class="sq" style="--c:var(--signal);border-radius:50%"></i>問題</li>';
}

// ---------------------------------------------------------------- 路由播放

function idleMap() {
  playToken++;
  map.speed = state.settings.speed;
  map.load(mode().graph(), { intro: true });
  state.trace = [];
  renderTrace();
  renderArrival(null);
  $('#replayBtn').disabled = true;
}

function ctxFor(q) { return { text: q.text, seed: hash(q.text) }; }

function addTrace(item) {
  state.trace.push(item);
  renderTrace();
}

function brainTrace(b) {
  const n = SIGNALS.length;
  if (b.error) {
    return { title: 'SystemOne 呼叫失敗，改用模擬訊號', detail: `${b.error.status ? `HTTP ${b.error.status}：` : ''}${b.error.message}`, tone: 'warn', time: b.latencyMs };
  }
  if (b.simulated) {
    return {
      title: '模擬訊號就緒',
      detail: state.cfg.hasKey ? `已在設定中開啟模擬模式，以本機規則回答 ${n} 個訊號問題。` : `伺服器未設定 API 金鑰，以本機規則模擬 SystemOne 回答 ${n} 個訊號問題。`,
      tone: 'brain', time: b.latencyMs,
    };
  }
  return { title: 'SystemOne 判斷完成', detail: `${b.response?.model ?? brainModel()} 回答了 ${n} 個訊號問題。`, tone: 'brain', time: b.latencyMs };
}

async function playRoute(q) {
  const m = mode();
  const run = ++playToken;
  state.currentQ = q.id;
  map.speed = state.settings.speed;
  // 沿路線移動的點帶著問題的開頭幾個字。
  map.cargo = truncate(q.text.replace(/\s+/g, ' ').trim(), 10);
  map.load(m.graph());
  $('#replayBtn').disabled = false;
  state.trace = [];
  addTrace({ title: '收到問題', detail: `「${truncate(q.text, 80)}」`, tone: 'info', time: 0 });
  renderArrival({ pending: true });
  markRoutes();
  renderPanels();

  const usesBrain = m.usesBrain !== false;
  await map.go('q', usesBrain ? 'brain' : 'engine');
  if (run !== playToken) return;

  if (usesBrain) {
    if (!q.brain) map.think('brain', true, '判斷中');
    const b = await q.brainPromise;
    if (run !== playToken) return;
    map.think('brain', false, b.error ? '改用模擬' : `${b.latencyMs} ms`);
    if (b.error) map.setNode('brain', { badge: { tone: 'warn', text: '改用模擬' } });
    addTrace(brainTrace(b));
  }

  const decision = m.decide(q.brain?.signals, state.controls[m.id], ctxFor(q));
  const ok = await map.play(decision.steps, (t) => { if (run === playToken) addTrace(t); });
  if (!ok || run !== playToken) return;
  renderArrival({ decision, q });
}

function decisionStats(decision, q) {
  const s = q.brain?.signals;
  if (decision.label) {
    const parts = ['llama', 'gpt5', 'reason', 'gpt5'].map((id) => estimate(id, s, q.text));
    return { p50: Math.max(MODELS.llama.p50, MODELS.gpt5.p50, MODELS.reason.p50) + MODELS.gpt5.p50, cost: parts.reduce((a, b) => a + b.cost, 0) };
  }
  return estimate(decision.model, s, q.text);
}

function renderArrival(arg) {
  const box = $('#arrival');
  if (!arg) {
    box.innerHTML = '<p class="arr-idle">送出問題後，這裡會顯示問題最後抵達的模型與理由。</p>';
    return;
  }
  if (arg.pending) {
    box.innerHTML = `<div class="arr-main arr-pending"><p class="arr-kicker">抵達</p>
      <div class="arr-dest"><span class="bullet t-pending" aria-hidden="true"></span><strong>路由中</strong><span class="arr-sub">${esc(mode().name)}正在決定去向</span></div></div>`;
    return;
  }
  const { decision, q } = arg;
  const m = MODELS[decision.model];
  const st = decisionStats(decision, q);
  const ex = tiered() ? execution(decision) : null;
  let sub = decision.label ? `由 ${MODELS.gpt5.name} 彙整三份答案` : `${m.role}，${m.where}`;
  if (ex?.virtual) sub = `示意模型，實際由 ${ex.label} ${ex.model} 回答`;
  box.innerHTML = `<div class="arr-main">
      <p class="arr-kicker">抵達</p>
      <div class="arr-dest">${bullet(tierOf(decision))}<strong>${esc(decision.label ?? m.name)}</strong><span class="arr-sub">${esc(sub)}</span></div>
      <p class="arr-reason">${esc(decision.reason)}</p>
    </div>
    <dl class="arr-stats">
      <div><dt>首字延遲</dt><dd>約 ${esc(formatSeconds(st.p50))}</dd></div>
      <div><dt>預估費用（示意）</dt><dd>${esc(formatCost(st.cost))}</dd></div>
    </dl>`;
}

// ---------------------------------------------------------------- 檢視器

// 只有剛加入的那一步播放進場動畫；其餘步驟維持原樣，內容不依賴動畫才看得見。
let traceShown = 0;

function renderTrace() {
  const panel = $('#panel-trace');
  const grew = state.trace.length > traceShown;
  traceShown = state.trace.length;
  if (!state.trace.length) { panel.innerHTML = '<p class="panel-empty">每一步路由判斷會依序列在這裡，像一條直式路線圖，並標出 SystemOne 的回覆時間。</p>'; return; }
  panel.innerHTML = `<ol class="trace">${state.trace.map((t, i) => `
    <li class="tt-${t.tone}${grew && i === state.trace.length - 1 ? ' is-new' : ''}" style="${t.tone === 'arrive' ? `--c:${lineVar(t.line)}` : ''}">
      <span class="t-stop" aria-hidden="true"></span>
      <div class="t-head"><span class="t-title">${esc(t.title)}</span>${t.time != null ? `<span class="t-time">${t.time} ms</span>` : ''}</div>
      ${t.detail ? `<p class="t-detail">${esc(t.detail)}</p>` : ''}
    </li>`).join('')}</ol>`;
  panel.scrollTop = panel.scrollHeight;
}

function renderSignals() {
  const panel = $('#panel-signals');
  const q = currentQuery();
  if (!q?.brain) {
    panel.innerHTML = `<p class="panel-empty">${q ? 'SystemOne 判斷中' : `送出問題後，這裡會列出 SystemOne 對 ${SIGNALS.length} 個訊號問題的回答。`}</p>`;
    return;
  }
  const used = new Set(mode().uses);
  const sig = q.brain.signals;
  const rows = [...SIGNALS].sort((a, b) => Number(used.has(b.key)) - Number(used.has(a.key)));
  const note = used.size ? `<p class="signals-note">${esc(mode().name)}使用其中 ${used.size} 個訊號，其餘淡化顯示。</p>` : '<p class="signals-note">規則路由不使用大腦訊號，以下僅供比較。</p>';
  panel.innerHTML = note + rows.map((s) => {
    const v = sig[s.key];
    let num = '', viz = '';
    if (s.type === 'noul') {
      num = v.p.toFixed(2);
      viz = `<div class="sig-bar"><i style="width:${pct(v.p)}"></i></div>`;
    } else if (s.type === 'choice') {
      num = pct(v.confidence);
      const top = Object.entries(v.probs).sort((a, b) => b[1] - a[1]).slice(0, 3);
      viz = `<div class="sig-opts">${top.map(([k, p]) => `<span class="${k === v.choice ? 'top' : ''}">${esc(s.options[k] ?? k)} ${pct(p)}</span>`).join('')}${v.corrected ? '<span class="sig-fix">字形修正</span>' : ''}</div>`;
    } else {
      const lvl = Math.round(v.level);
      num = s.levels[lvl];
      viz = `<div class="meter">${s.levels.map((_, i) => `<i class="${i <= lvl ? 'on' : ''}"></i>`).join('')}</div>`;
    }
    return `<div class="sig ${used.size && !used.has(s.key) ? 'is-unused' : ''}" title="${esc(s.q.instructions)}">
      <div class="sig-head"><span class="sig-label">${esc(s.label)}</span>${used.has(s.key) ? '<span class="sig-used">使用中</span>' : ''}<span class="sig-num">${esc(num)}</span></div>${viz}</div>`;
  }).join('');
}

function renderCompare() {
  const panel = $('#panel-compare');
  const q = currentQuery();
  if (!q?.brain) {
    panel.innerHTML = `<p class="panel-empty">${q ? '等待 SystemOne 回覆後，會列出同一個問題在每種策略下的去向。' : '送出問題後，可以比較 12 種策略各自把問題送到哪裡。'}</p>`;
    return;
  }
  const rows = decideAll(q.brain.signals, state.controls, ctxFor(q));
  const count = { low: 0, mid: 0, high: 0 };
  for (const r of rows) if (r.decision) count[tierOf(r.decision)]++;
  panel.innerHTML = `<p class="compare-sum">同一個問題在 ${rows.length} 種策略下：LOW ${count.low} 種、MID ${count.mid} 種、HIGH ${count.high} 種。點選切換策略。</p>
    <ul class="compare">${rows.map(({ mode: m, decision: d }) => {
      if (!d) return `<li><div class="cmp"><span></span><span class="cmp-mode">${esc(m.name)}：無法判斷</span></div></li>`;
      return `<li><button class="cmp" type="button" data-mode="${m.id}" aria-current="${m.id === state.modeId}">
        ${bullet(tierOf(d))}
        <span class="cmp-top"><span class="cmp-mode">${esc(m.name)}</span><span class="cmp-dest">${esc(d.label ?? MODELS[d.model].name)}</span></span>
        <span class="cmp-why">${esc(d.reason)}</span></button></li>`;
    }).join('')}</ul>`;
}

function highlight(obj) {
  const src = JSON.stringify(obj, null, 2) ?? '';
  return src.replace(/("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([^"\d-]+|-)/g, (m, str, colon, num) => {
    if (str) return colon ? `<span class="k">${esc(str)}</span>${colon}` : `<span class="s">${esc(str)}</span>`;
    if (num) return `<span class="n">${num}</span>`;
    return esc(m);
  });
}

function renderRaw() {
  const panel = $('#panel-raw');
  const q = currentQuery();
  if (!q?.brain) { panel.innerHTML = '<p class="panel-empty">送出問題後，這裡會顯示送往 SystemOne 的完整請求與回應 JSON。</p>'; return; }
  const b = q.brain;
  const note = b.error ? `<p class="raw-note">實際呼叫失敗（${esc(b.error.message)}），下方回應為模擬資料。</p>` : b.simulated ? '<p class="raw-note">模擬模式：未實際呼叫 API，回應由本機規則產生，格式與 SystemOne 相同。</p>' : '';
  panel.innerHTML = `<div class="raw">${note}
    <section><h3>請求 POST /v1/systemone<button class="copy" type="button" data-copy="request">複製</button></h3><pre>${highlight(b.request)}</pre></section>
    <section><h3>回應 ${b.latencyMs} ms<button class="copy" type="button" data-copy="response">複製</button></h3><pre>${highlight(b.response)}</pre></section>
  </div>`;
}

function renderPanels() {
  renderSignals();
  renderCompare();
  renderRaw();
}

function refreshDerived() {
  renderPanels();
  markRoutes();
}

// ---------------------------------------------------------------- 對話

const messagesEl = $('#messages');
const input = $('#input');
const sendBtn = $('#sendBtn');

function md(text) {
  if (window.marked && window.DOMPurify) return window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true, breaks: true }));
  return esc(text).replace(/\n/g, '<br>');
}

function renderEmpty() {
  messagesEl.innerHTML = `<div class="intro">
    <h3>問一個問題，<br>看它走哪條路線。</h3>
    <p>${tiered()
      ? `auto 會依右側選定的策略，把問題交給 LOW、MID 或 HIGH 模型回答；右側同步畫出 SystemOne 的判斷與經過的每一站。`
      : '右側會同步畫出 SystemOne 的判斷，以及問題經過的每一站。'}</p>
    ${EXAMPLE_GROUPS.map((g) => `<section class="ex-group" aria-label="${esc(g.name)}">
      <h4 class="ex-group-name">${esc(g.name)}</h4>
      <ul class="examples">${g.items.map((e) => `<li><button class="example" type="button" data-example="${EXAMPLES.indexOf(e)}">
        <span class="ex-kind">${esc(e.kind)}</span><span class="ex-text">${esc(e.text)}</span></button></li>`).join('')}</ul>
    </section>`).join('')}
  </div>`;
}

function routeHtml(q) {
  const m = mode();
  if (m.usesBrain !== false && !q.brain) return '<span class="bullet t-pending" aria-hidden="true"></span><span class="rl-mode">路由判斷中</span>';
  const d = m.decide(q.brain?.signals, state.controls[m.id], ctxFor(q));
  return `${bullet(tierOf(d))}<span class="rl-model">${esc(d.label ?? MODELS[d.model].name)}</span><span class="rl-mode">${esc(m.name)}</span>`;
}

function markRoutes() {
  for (const el of messagesEl.querySelectorAll('.route-line')) {
    const q = state.queries.get(Number(el.dataset.q));
    if (!q) continue;
    el.innerHTML = routeHtml(q);
    el.setAttribute('aria-pressed', String(q.id === state.currentQ));
    el.title = '在右側重播這個問題的路線';
  }
}

function appendMessage(msg) {
  if (!messagesEl.querySelector('.turn')) messagesEl.replaceChildren();
  if (msg.role === 'user') {
    const turn = document.createElement('article');
    turn.className = 'turn';
    turn.innerHTML = `<p class="q-text"></p><button class="route-line" type="button" data-q="${msg.qid}"></button>`;
    turn.querySelector('.q-text').textContent = msg.content;
    messagesEl.appendChild(turn);
    msg.el = turn;
  } else {
    const turn = messagesEl.querySelector('.turn:last-of-type');
    const el = document.createElement('div');
    el.className = 'a';
    el.innerHTML = '<details class="think" hidden><summary></summary><div class="think-body"></div></details><div class="md"></div><div class="bot-meta"></div>';
    turn.appendChild(el);
    msg.el = el;
    updateBot(msg);
  }
  markRoutes();
  scrollDown(true);
}

function scrollDown(force) {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  if (force || nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

let renderQueued = null;
function queueRender(msg) {
  if (renderQueued) return;
  renderQueued = requestAnimationFrame(() => { renderQueued = null; updateBot(msg); scrollDown(false); });
}

function errorNotice(err) {
  if (err.code === 'no_key') {
    return `<div class="notice"><strong>尚未設定 API 金鑰</strong>auto 需要 LiteLLM 金鑰。請在專案根目錄的 <code>.env</code> 填入 <code>LITELLM_API_KEY</code>，再重新啟動伺服器。右側的路由過程會以模擬訊號繼續示範。</div>`;
  }
  if (err.status === 400 && /invalid model name/i.test(err.message)) {
    const name = err.model ?? state.cfg.chatModel;
    const envVar = err.tier ? `LITELLM_CHAT_MODEL_${err.tier.toUpperCase()}` : 'CHAT_MODEL';
    return `<div class="notice"><strong>這把金鑰無法使用 ${esc(name)} 模型</strong>LiteLLM 回覆：${esc(err.message)}<br>請 LiteLLM 管理員為這把金鑰開放 <code>${esc(name)}</code>，或在 <code>.env</code> 把 <code>${envVar}</code> 改成可用的聊天模型後重新啟動伺服器。</div>`;
  }
  if (err.status === 401 || err.status === 403) {
    return `<div class="notice"><strong>API 金鑰無效（HTTP ${err.status}）</strong>請確認 <code>.env</code> 中的金鑰是否正確，修改後重新啟動伺服器。</div>`;
  }
  return `<div class="notice"><strong>auto 回覆失敗${err.status ? `（HTTP ${err.status}）` : ''}</strong>${esc(err.message)}</div>`;
}

function updateBot(msg) {
  if (msg.role !== 'assistant' || !msg.el) return;
  const body = msg.el.querySelector('.md');
  const meta = msg.el.querySelector('.bot-meta');
  renderThinking(msg);
  if (msg.status === 'error') {
    body.innerHTML = errorNotice(msg.error);
    meta.innerHTML = '';
    return;
  }
  if (msg.status === 'routing') {
    body.innerHTML = '<span class="waiting">等待 SystemOne 的路由決策</span>';
  } else if (!msg.content && msg.status === 'streaming') {
    body.innerHTML = msg.reasoning ? '' : '<span class="waiting">模型準備回答</span>';
  } else {
    body.innerHTML = md(msg.content || (msg.status === 'stopped' ? '（已停止）' : ''));
    body.classList.toggle('caret', msg.status === 'streaming');
  }
  const mt = msg.meta;
  const parts = [];
  if (mt.route) {
    parts.push(`<span>${esc(state.cfg.chatModel)} 依${esc(mt.route.modeName)}選擇 <strong>${esc(mt.route.label)}</strong>，由 <strong>${esc(mt.model ?? mt.route.model)}</strong> 回答</span>`);
    if (mt.route.virtual) parts.push(`<span>路由目標 ${esc(mt.route.target)} 為示意</span>`);
  } else if (mt.model) {
    parts.push(`<span>由 <strong>${esc(mt.model)}</strong> 回答</span>`);
  }
  if (mt.thinkStart != null && mt.ttft) parts.push(`<span>思考 ${esc(formatSeconds((mt.ttft - mt.thinkStart) / 1000))}</span>`);
  if (mt.ttft) parts.push(`<span>首字 ${esc(formatSeconds(mt.ttft / 1000))}</span>`);
  if (mt.total) parts.push(`<span>共 ${esc(formatSeconds(mt.total / 1000))}</span>`);
  if (mt.usage?.completion_tokens) parts.push(`<span>${mt.usage.completion_tokens} tokens</span>`);
  if (msg.status === 'stopped') parts.push('<span>已停止</span>');
  meta.innerHTML = parts.join('');
}

// 推理模型先串流思考過程：思考時展開並即時顯示，開始回答後自動收合。
function renderThinking(msg) {
  const box = msg.el.querySelector('.think');
  if (!msg.reasoning) { box.hidden = true; return; }
  box.hidden = false;
  const live = !msg.content && msg.status === 'streaming';
  const mt = msg.meta;
  if (live && !msg.thinkOpened) { box.open = true; msg.thinkOpened = true; }
  if (!live && msg.thinkOpened && !msg.thinkClosed) { box.open = false; msg.thinkClosed = true; }
  box.classList.toggle('is-live', live);
  const secs = live ? (performance.now() - msg.t0 - mt.thinkStart) / 1000 : ((mt.ttft ?? mt.total ?? 0) - mt.thinkStart) / 1000;
  box.querySelector('summary').textContent = live ? `思考中，已 ${Math.max(0, secs).toFixed(0)} 秒` : `思考過程，${formatSeconds(Math.max(0, secs))}`;
  const tb = box.querySelector('.think-body');
  const atBottom = tb.scrollHeight - tb.scrollTop - tb.clientHeight < 24;
  tb.textContent = msg.reasoning;
  if (live && atBottom) tb.scrollTop = tb.scrollHeight;
}

function setStreaming(on) {
  sendBtn.classList.toggle('is-stop', on);
  sendBtn.setAttribute('aria-label', on ? '停止回覆' : '送出');
  updateSendState();
}

function updateSendState() {
  sendBtn.disabled = !state.streaming && !input.value.trim();
}

async function streamChat(msg, q) {
  const history = state.messages
    .filter((m) => m !== msg && (m.role === 'user' || (m.role === 'assistant' && m.status === 'done' && m.content)))
    .map(({ role, content }) => ({ role, content }));
  const ac = new AbortController();
  state.streaming = ac;
  setStreaming(true);
  let t0 = performance.now();
  msg.t0 = t0;
  try {
    let tier;
    if (tiered()) {
      msg.status = 'routing';
      updateBot(msg);
      const { mode: m, decision, exec } = await q.routePromise;
      if (ac.signal.aborted) throw new DOMException('aborted', 'AbortError');
      tier = exec.tier;
      msg.meta.route = { modeName: m.name, target: decision.label ?? MODELS[decision.model].name, ...exec };
      msg.status = 'streaming';
      updateBot(msg);
      t0 = performance.now();
      msg.t0 = t0;
    }
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history, tier }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), { status: res.status, code: data?.error?.code });
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw Object.assign(new Error(j.error.message ?? '串流錯誤'), { status: j.error.code });
        if (j.model) msg.meta.model = j.model;
        if (j.usage) msg.meta.usage = j.usage;
        const d = j.choices?.[0]?.delta ?? {};
        const thought = d.reasoning_content ?? d.reasoning;
        if (thought) {
          msg.meta.thinkStart ??= performance.now() - t0;
          msg.reasoning = (msg.reasoning ?? '') + thought;
          queueRender(msg);
        }
        if (d.content) {
          msg.meta.ttft ??= performance.now() - t0;
          msg.content += d.content;
          queueRender(msg);
        }
      }
    }
    msg.status = 'done';
    msg.meta.total = performance.now() - t0;
  } catch (err) {
    if (err.name === 'AbortError') msg.status = 'stopped';
    else { msg.status = 'error'; msg.error = { message: err.message, status: err.status, code: err.code, model: msg.meta.route?.model, tier: msg.meta.route?.tier }; }
  } finally {
    state.streaming = null;
    setStreaming(false);
    updateBot(msg);
    scrollDown(false);
  }
}

async function send(text) {
  text = text.trim();
  if (!text || state.streaming) return;
  input.value = '';
  autoGrow();
  await configReady;
  const q = { id: ++qSeq, text, brain: null };
  q.brainPromise = askBrain(text, { simulate: simulate(), model: brainModel() }).then((b) => {
    q.brain = b;
    state.brainError = b.error ?? null;
    renderBrainStatus();
    if (q.id === state.currentQ) renderPanels();
    markRoutes();
    return b;
  });
  // 送出當下選定的策略決定 auto 交給哪一層模型；規則路由不必等大腦。
  q.routePromise = (async () => {
    const m = mode();
    const ctl = { ...state.controls[m.id] };
    const signals = m.usesBrain === false ? null : (await q.brainPromise).signals;
    const decision = m.decide(signals, ctl, ctxFor(q));
    return { mode: m, decision, exec: execution(decision) };
  })();
  state.queries.set(q.id, q);

  const user = { id: ++mSeq, role: 'user', content: text, qid: q.id };
  const bot = { id: ++mSeq, role: 'assistant', content: '', status: 'streaming', meta: {} };
  state.messages.push(user, bot);
  appendMessage(user);
  appendMessage(bot);
  updateSendState();

  playRoute(q);
  streamChat(bot, q);
}

function newChat() {
  state.streaming?.abort();
  state.messages = [];
  state.queries.clear();
  state.currentQ = null;
  renderEmpty();
  idleMap();
  renderPanels();
  input.focus();
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
}

// ---------------------------------------------------------------- 設定與狀態列

function renderBrainStatus() {
  const btn = $('#brainStatus');
  $('#brainModelLabel').textContent = brainModel();
  $('#chatModelLabel').textContent = state.cfg.chatModel;
  $('#chatModelNote').textContent = tiered() ? '由路由策略決定層級' : '';
  let st = 'live', label = '即時判斷';
  if (simulate()) { st = 'sim'; label = '模擬訊號'; }
  else if (state.brainError) { st = 'error'; label = '連線失敗'; }
  btn.dataset.state = st;
  $('#brainStateLabel').textContent = label;
}

function openSettings() {
  const dlg = $('#settings');
  $('#setBrainModel').value = brainModel();
  $('#setSimulate').checked = state.settings.simulate;
  for (const r of dlg.querySelectorAll('input[name="speed"]')) r.checked = Number(r.value) === state.settings.speed;
  $('#connInfo').innerHTML = `
    <dt>大腦端點</dt><dd>${esc(state.cfg.endpoint || '—')}</dd>
    <dt>大腦金鑰</dt><dd>${state.cfg.hasKey ? '<span class="ok">已在伺服器設定</span>' : '<span class="bad">未設定</span>：在 .env 填入 LITELLM_API_KEY 後重新啟動伺服器'}</dd>
    <dt>聊天端點</dt><dd>${esc(state.cfg.chatEndpoint || state.cfg.endpoint || '—')}</dd>
    <dt>聊天模型</dt><dd>${tiered()
      ? `${esc(state.cfg.chatModel)}，依路由決策選擇<br>LOW ${esc(TIER_MODELS.low)}<br>MID ${esc(TIER_MODELS.mid)}<br>HIGH ${esc(TIER_MODELS.high)}`
      : `${esc(state.cfg.chatModel)}`}</dd>`;
  dlg.showModal();
}

function closeSettings() {
  const dlg = $('#settings');
  const model = $('#setBrainModel').value.trim();
  state.settings.brainModel = model && model !== state.cfg.brainModel ? model : '';
  state.settings.simulate = $('#setSimulate').checked;
  const speed = dlg.querySelector('input[name="speed"]:checked');
  if (speed) state.settings.speed = Number(speed.value);
  map.speed = state.settings.speed;
  store.set('settings', state.settings);
  state.brainError = null;
  renderBrainStatus();
}

function effectiveDark() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function renderThemeIcon() {
  const dark = effectiveDark();
  const label = dark ? '切換淺色模式' : '切換深色模式';
  $('#themeBtn').setAttribute('aria-label', label);
  $('#themeBtn').title = label;
  $('#themeBtn svg').innerHTML = dark
    ? '<circle cx="10" cy="10" r="3.5"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/>'
    : '<path d="M16.5 12.2A7 7 0 0 1 7.8 3.5a7 7 0 1 0 8.7 8.7z"/>';
}

// ---------------------------------------------------------------- 事件

function bindTabs() {
  const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
    }
    store.set('tab', tab.id);
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = tabs[(i + d + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  });
  const saved = tabs.find((t) => t.id === store.get('tab', 'tab-trace'));
  if (saved) select(saved);
}

function bind() {
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.streaming) state.streaming.abort();
    else send(input.value);
  });
  input.addEventListener('input', () => { autoGrow(); updateSendState(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!state.streaming) send(input.value);
    }
  });

  messagesEl.addEventListener('click', (e) => {
    const ex = e.target.closest('[data-example]');
    if (ex) { send(EXAMPLES[Number(ex.dataset.example)].text); return; }
    const line = e.target.closest('.route-line');
    if (line) {
      const q = state.queries.get(Number(line.dataset.q));
      if (q) { showPane('router'); playRoute(q); }
    }
  });

  const strategies = $('#strategies');
  strategies.addEventListener('click', (e) => {
    const b = e.target.closest('.strat');
    if (b) selectMode(b.dataset.mode);
  });
  strategies.addEventListener('keydown', (e) => {
    const items = [...strategies.querySelectorAll('.strat')];
    const i = items.indexOf(document.activeElement);
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (i < 0 || !d) return;
    e.preventDefault();
    items[(i + d + items.length) % items.length].focus();
  });

  $('#panel-compare').addEventListener('click', (e) => {
    const row = e.target.closest('.cmp[data-mode]');
    if (row) selectMode(row.dataset.mode);
  });
  $('#panel-raw').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    const q = currentQuery();
    if (!b || !q?.brain) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(q.brain[b.dataset.copy], null, 2));
      b.textContent = '已複製';
    } catch {
      b.textContent = '無法複製';
    }
    setTimeout(() => { b.textContent = '複製'; }, 1400);
  });

  $('#replayBtn').addEventListener('click', () => { const q = currentQuery(); if (q) playRoute(q); });
  $('#newChatBtn').addEventListener('click', newChat);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#brainStatus').addEventListener('click', openSettings);
  $('#settings').addEventListener('close', closeSettings);
  $('#themeBtn').addEventListener('click', () => {
    const next = effectiveDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('router-demo:theme', next); } catch { /* 略過 */ }
    renderThemeIcon();
    map.layout();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderThemeIcon);

  for (const b of document.querySelectorAll('.pane-switch button')) b.addEventListener('click', () => showPane(b.dataset.pane));

  bindZoom();
}

// 平移縮放只有 React Flow 版的路線圖才有。
// 按鈕用 aria-disabled 表示不可用，按到極限時鍵盤焦點才不會消失。
function bindZoom() {
  if (!map.zoomBy) return;
  const set = (sel, off) => $(sel).setAttribute('aria-disabled', String(off));
  map.onView = (v) => {
    $('#mapZoom').hidden = !v.interactive;
    set('#zoomInBtn', !v.canZoomIn);
    set('#zoomOutBtn', !v.canZoomOut);
    set('#zoomResetBtn', !v.moved);
  };
  map.onView(map.viewState());
  const on = (sel, fn) => $(sel).addEventListener('click', (e) => {
    if (e.currentTarget.getAttribute('aria-disabled') !== 'true') fn();
  });
  on('#zoomInBtn', () => map.zoomBy(1));
  on('#zoomOutBtn', () => map.zoomBy(-1));
  on('#zoomResetBtn', () => map.resetView(true));
}

function showPane(name) {
  $('.panes').dataset.active = name;
  for (const b of document.querySelectorAll('.pane-switch button')) b.setAttribute('aria-selected', String(b.dataset.pane === name));
  if (name === 'router') requestAnimationFrame(() => map.layout());
}

// ---------------------------------------------------------------- 啟動

// 伺服器設定（金鑰、三層模型）載入前不送出問題，避免誤判成模擬模式。
let configReady;

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) state.cfg = { ...state.cfg, ...(await res.json()) };
  } catch { /* 伺服器未提供設定時使用預設值 */ }
  if (tiered()) {
    applyTiers(state.cfg.chatTiers);
    if (!state.messages.length) { renderEmpty(); idleMap(); }
  }
  renderBrainStatus();
}

function init() {
  renderStrategies();
  renderLegend();
  renderModeHead();
  renderEmpty();
  renderThemeIcon();
  bindTabs();
  bind();
  idleMap();
  renderPanels();
  configReady = loadConfig();
  input.focus();
}

init();
