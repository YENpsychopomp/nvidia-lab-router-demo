// SystemOne 路由大腦：一次送出所有路由訊號問題，再把回答整理成各策略共用的訊號。

export const SIGNALS = [
  {
    key: 'complexity', label: '任務難度', type: 'score',
    levels: ['寒暄', '簡單', '中等', '困難', '專家'],
    q: {
      type: 'score',
      instructions: 'How difficult is it to answer this user message well?',
      criteria: [
        'trivial: greeting, small talk, or a one-line fact',
        'easy: common knowledge with a short answer',
        'moderate: needs a structured multi-paragraph explanation',
        'hard: needs multi-step reasoning, careful analysis, or expert knowledge',
        'expert: research-level, open-ended, or high-precision professional work',
      ],
    },
  },
  {
    key: 'domain', label: '問題領域', type: 'choice',
    options: { coding: '程式', math: '數學', legal: '法律', medical: '醫療', finance: '財經', translation: '翻譯', creative: '創作', knowledge: '一般知識', chitchat: '閒聊' },
    q: {
      type: 'choice',
      instructions: 'Which domain does this message mainly belong to? Choose coding only when the user wants code written, reviewed, or debugged.',
      criteria: {
        coding: 'writing, reviewing, or debugging actual code, scripts, SQL queries, or API calls',
        math: 'mathematics, proofs, calculation, statistics',
        legal: 'law, contracts, regulations, compliance',
        medical: 'health, symptoms, medicine, clinical questions',
        finance: 'finance, accounting, investment, tax, stock market',
        translation: 'translating text between languages',
        creative: 'creative writing, stories, poems, marketing copy',
        knowledge: 'general, scientific, or technical-concept questions, explanations, comparisons, and architecture discussions that do not ask for code',
        chitchat: 'greetings, small talk, casual conversation',
      },
    },
  },
  {
    key: 'language', label: '使用語言', type: 'choice',
    options: { 'zh-TW': '繁體中文', 'zh-CN': '簡體中文', en: '英文', ja: '日文', other: '其他' },
    q: {
      type: 'choice',
      instructions: 'What language is the user writing in?',
      criteria: { 'zh-TW': 'Traditional Chinese', 'zh-CN': 'Simplified Chinese', en: 'English', ja: 'Japanese', other: 'any other language' },
    },
  },
  {
    key: 'urgency', label: '回覆時效', type: 'choice',
    options: { realtime: '即時', standard: '一般', deep: '深度' },
    q: {
      type: 'choice',
      instructions: 'What response speed does the user most likely expect?',
      criteria: {
        realtime: 'casual chat, expects an instant reply',
        standard: 'normal question, a few seconds is fine',
        deep: 'complex task, answer quality matters more than speed',
      },
    },
  },
  {
    key: 'sensitivity', label: '資料敏感度', type: 'choice',
    options: { public: '公開', internal: '內部', confidential: '機密' },
    q: {
      type: 'choice',
      instructions: 'How sensitive is the data contained in this message?',
      criteria: {
        public: 'no personal or confidential data',
        internal: 'internal business information without personal identifiers',
        confidential: 'personal identifiers, medical records, credentials, or trade secrets',
      },
    },
  },
  { key: 'contains_pii', label: '含個人資料', type: 'noul', q: { type: 'noul', instructions: 'Does the message contain personally identifiable information such as national ID numbers, phone numbers, home addresses, account numbers, passwords, or medical records tied to a person?' } },
  { key: 'needs_reasoning', label: '需要多步推理', type: 'noul', q: { type: 'noul', instructions: 'Does answering require multi-step reasoning, math, planning, or careful logic?' } },
  { key: 'needs_fresh', label: '需要即時資訊', type: 'noul', q: { type: 'noul', instructions: 'Does answering require up-to-date information or a live web search, such as news, prices, weather, or today\'s events?' } },
  { key: 'high_stakes', label: '錯誤代價高', type: 'noul', q: { type: 'noul', instructions: 'Could a wrong answer cause real harm, such as medical, legal, financial, or safety consequences?' } },
  { key: 'small_ok', label: '小模型可勝任', type: 'noul', q: { type: 'noul', instructions: 'Is this message simple enough (greeting, small talk, a short rewrite or translation, a single well-known fact) that a tiny 4B model would answer it about as well as GPT-5?' } },
  { key: 'large_ok', label: '70B 模型可勝任', type: 'noul', q: { type: 'noul', instructions: 'Open-source 70B models handle general knowledge, everyday coding and writing well, but are weaker than frontier models on research-level analysis, novel multi-step reasoning, system design and recent facts. Would a 70B model very likely give a fully correct, high-quality answer to this message?' } },
  { key: 'strong_gain', label: '旗艦模型明顯較好', type: 'noul', q: { type: 'noul', instructions: 'Would GPT-5 give a clearly better answer than a 70B open-source model for this message, for example because it needs deep expertise, nuanced analysis, research-level reasoning, or recent knowledge?' } },
  { key: 'long_output', label: '需要長篇輸出', type: 'noul', q: { type: 'noul', instructions: 'Does the user ask for a long output, such as a full document, a long article, or a large code file?' } },
];

export const QUESTIONS = Object.fromEntries(SIGNALS.map((s) => [s.key, s.q]));
const SIG = Object.fromEntries(SIGNALS.map((s) => [s.key, s]));

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 解析 SystemOne 回答 ----------

function parseChoice(a, labels) {
  const raw = a?.probabilities ?? {};
  const probs = {};
  let total = 0;
  for (const l of labels) { probs[l] = clamp01(Number(raw[l] ?? 0)); total += probs[l]; }
  if (total === 0 && a?.choice in probs) probs[a.choice] = clamp01(a.confidence ?? 1);
  let choice = labels.includes(a?.choice) ? a.choice : labels.reduce((b, l) => (probs[l] > probs[b] ? l : b), labels[0]);
  return { choice, confidence: clamp01(a?.confidence ?? probs[choice]), probs };
}

function parseScore(a, n) {
  const keys = Object.keys(a?.legend ?? a?.probabilities ?? {}).map(Number).filter(Number.isFinite);
  const base = keys.length ? Math.min(...keys) : 0;
  const raw = Number(a?.score ?? 0);
  const level = Math.max(0, Math.min(n - 1, raw - base));
  const probs = Array.from({ length: n }, (_, i) => clamp01(Number(a?.probabilities?.[String(i + base)] ?? 0)));
  return { level, raw, confidence: clamp01(a?.confidence ?? probs[Math.round(level)] ?? 0), probs };
}

export function parseSignals(response) {
  const answers = response?.answers ?? {};
  const out = {};
  for (const s of SIGNALS) {
    const a = answers[s.key];
    if (s.type === 'noul') out[s.key] = { p: clamp01(Number(a?.noul ?? a?.probability ?? 0.5)), missing: !a };
    else if (s.type === 'choice') out[s.key] = { ...parseChoice(a, Object.keys(s.q.criteria)), missing: !a };
    else out[s.key] = { ...parseScore(a, s.q.criteria.length), missing: !a };
  }
  return out;
}

// SystemOne 不太能分辨繁簡字形；文字中有明確的繁體或簡體字時，以字形修正中文的判斷。
export function refineLanguage(signals, text) {
  const lang = signals.language;
  const zh = (lang.probs['zh-TW'] ?? 0) + (lang.probs['zh-CN'] ?? 0);
  if (!lang.choice.startsWith('zh') && zh < 0.5) return signals;
  const trad = (text.match(TRAD) || []).length;
  const simp = (text.match(SIMP) || []).length;
  if (trad === simp) return signals;
  const to = trad > simp ? 'zh-TW' : 'zh-CN';
  const script = { trad, simp };
  if (to === lang.choice) { lang.script = script; return signals; }
  signals.language = {
    ...lang,
    choice: to,
    confidence: zh,
    probs: { ...lang.probs, 'zh-TW': to === 'zh-TW' ? zh : 0, 'zh-CN': to === 'zh-CN' ? zh : 0 },
    script,
    corrected: { from: lang.choice },
  };
  return signals;
}

// ---------- 模擬大腦：沒有金鑰或離線展示時使用 ----------

const RE = {
  coding: /(程式|代碼|代码|python|javascript|typescript|java\b|c\+\+|golang|rust|sql|api|bug|debug|function|函式|函數|演算法|算法|regex|正則|前端|後端|docker|git\b|lru|cache|code|class\b)/i,
  math: /(證明|证明|計算|计算|方程|微積分|積分|導數|機率|概率|矩陣|數學|数学|根號|質數|無理數|prove|proof|equation|integral|\d+\s*[+\-*/^]\s*\d+)/i,
  legal: /(法律|合約|契約|條款|訴訟|律師|法規|違法|著作權|個資法|勞基法|legal|contract|lawsuit)/i,
  medical: /(醫療|醫生|症狀|藥|劑量|診斷|病歷|治療|疼痛|發燒|血壓|medical|symptom|dose|diagnos)/i,
  finance: /(股價|股票|投資|基金|財報|稅|會計|利率|匯率|貸款|etf|stock|invest|tax|finance)/i,
  translation: /(翻譯|翻译|譯成|翻成|translate|怎麼說)/i,
  creative: /(寫一首|詩|故事|小說|文案|歌詞|劇本|slogan|poem|story|創作)/i,
  chitchat: /(^\s*(hi|hello|hey|你好|嗨|哈囉|早安|午安|晚安|謝謝|thanks)|心情|聊聊|無聊|推薦一首|笑話)/i,
};
const PII = /([A-Z][12]\d{8}|09\d{2}-?\d{3}-?\d{3}|[\w.+-]+@[\w-]+\.[\w.]+|\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}|身分證|身份證|病歷|密碼|帳號|住址|地址|薪資|生日|健保卡)/i;
const INTERNAL = /(公司內部|內部|機密|客戶名單|營收|專案代號|未公開|confidential|internal)/i;
const FRESH = /(最新|即時|股價|天氣|新聞|比分|匯率|最近.{0,6}(消息|動態|發生)|今天.{0,4}(幾號|日期)|20(2[5-9])|today|latest|current|news|weather|price)/i;
const STAKES = /(劑量|診斷|手術|訴訟|投資建議|安全|用藥|法律責任)/;
const HARD = /(比較|分析|設計|架構|推導|證明|策略|優缺點|研究|評估|規劃|為什麼|原理|權衡|trade-?off|analy|compare|design|architecture|why)/i;
const DEEP = /(研究方向|論文|系統設計|深入|全面|完整|詳細)/;
const LONG = /(完整|全文|報告|文章|長篇|詳細|\d{3,}\s*字|申請書|essay|full|detailed|教學)/i;
const TRAD = /[這個們說會為時來對發麼後嗎請寫學與種實關開體點現還長問題數計機電語頭經濟醫療譯證號無雲網頁區國樂歡覺讓聽錢價應較構優統設檔碼單複雜節據庫變處務員業產動圖書車東見認識歷讀試測環報導際費貴買賣錯聲輕憶戲劇氣灣愛華萬億幾從進過該]/g;
const SIMP = /[这个们说会为时来对发么后吗请写学与种实关开体点现还长问题数计机电语头经济医疗译证号无云网页区国乐欢觉让听钱价应较构优统设档码单复杂节据库变处务员业产动图书车东见认识历读试测环报导际费贵买卖错声轻忆戏剧气湾爱华万亿几从进过该]/g;

function softmaxLevels(center, n, spread = 0.55) {
  const w = Array.from({ length: n }, (_, i) => Math.exp(-((i - center) ** 2) / spread));
  const t = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / t);
}

function choiceAnswer(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const probabilities = Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, +(v / total).toFixed(3)]));
  const choice = Object.keys(probabilities).reduce((b, k) => (probabilities[k] > probabilities[b] ? k : b));
  return { type: 'choice', choice, confidence: probabilities[choice], probabilities };
}

export function simulateBrain(text) {
  const r = rng(hash(text));
  const j = (v, a = 0.05) => +clamp01(v + (r() - 0.5) * 2 * a).toFixed(3);
  const noul = (v, a) => ({ type: 'noul', noul: j(v, a) });

  const hit = Object.fromEntries(Object.entries(RE).map(([k, re]) => [k, re.test(text)]));
  const kana = /[぀-ヿ]/.test(text);
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  const trad = (text.match(TRAD) || []).length;
  const simp = (text.match(SIMP) || []).length;
  let lang = 'other';
  if (kana) lang = 'ja';
  else if (cjk > 0 && cjk >= latin * 0.25) lang = simp > trad ? 'zh-CN' : 'zh-TW';
  else if (latin > 0) lang = 'en';

  const order = ['translation', 'coding', 'math', 'medical', 'legal', 'finance', 'creative', 'chitchat'];
  const primary = order.find((k) => hit[k]);
  const dw = { coding: 0.08, math: 0.08, legal: 0.06, medical: 0.06, finance: 0.06, translation: 0.06, creative: 0.08, knowledge: primary ? 0.4 : 2.2, chitchat: 0.1 };
  for (const k of order) if (hit[k]) dw[k] += k === primary ? 3 : 0.9;

  const len = [...text].length;
  let c = len < 14 ? 0 : len < 40 ? 1 : len < 90 ? 2 : 3;
  if (HARD.test(text)) c += 1;
  if (DEEP.test(text)) c += 1;
  if (primary === 'chitchat') c = Math.min(c, 1);
  if (primary === 'translation') c = Math.min(c, 2);
  if (primary === 'math' || primary === 'coding') c = Math.max(c, 2);
  c = Math.max(0, Math.min(4, c));
  const cp = softmaxLevels(c, 5);

  const pii = PII.test(text);
  const internal = INTERNAL.test(text);
  const sens = pii ? { public: 0.03, internal: 0.12, confidential: 0.85 } : internal ? { public: 0.15, internal: 0.75, confidential: 0.1 } : { public: 0.9, internal: 0.08, confidential: 0.02 };
  const urg = primary === 'chitchat' || c === 0 ? { realtime: 0.78, standard: 0.18, deep: 0.04 } : c >= 3 ? { realtime: 0.05, standard: 0.3, deep: 0.65 } : { realtime: 0.15, standard: 0.72, deep: 0.13 };
  const tech = primary === 'coding' || primary === 'math';

  const answers = {
    complexity: {
      type: 'score', score: c, confidence: +cp[c].toFixed(3),
      legend: Object.fromEntries(SIG.complexity.q.criteria.map((t, i) => [String(i), t])),
      probabilities: Object.fromEntries(cp.map((p, i) => [String(i), +p.toFixed(3)])),
    },
    domain: choiceAnswer(dw),
    language: choiceAnswer({ 'zh-TW': 0.03, 'zh-CN': 0.03, en: 0.03, ja: 0.02, other: 0.02, [lang]: 1 }),
    urgency: choiceAnswer(urg),
    sensitivity: choiceAnswer(sens),
    contains_pii: noul(pii ? 0.93 : 0.04, 0.03),
    needs_reasoning: noul(tech || c >= 3 ? 0.82 : c >= 2 ? 0.45 : 0.12),
    needs_fresh: noul(FRESH.test(text) ? 0.88 : 0.06, 0.04),
    high_stakes: noul(hit.medical || hit.legal || hit.finance || STAKES.test(text) ? 0.78 : 0.1),
    small_ok: noul([0.9, 0.62, 0.25, 0.05, 0.02][c] - (tech ? 0.15 : 0)),
    large_ok: noul([0.98, 0.95, 0.85, 0.35, 0.08][c] - (tech ? 0.05 : 0)),
    strong_gain: noul([0.02, 0.08, 0.25, 0.55, 0.8][c]),
    long_output: noul(LONG.test(text) ? 0.78 : 0.14),
  };
  return { model: 'simulated', answers, usage: { input_tokens: 0, output_tokens: 0 } };
}

// ---------- 呼叫 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function askBrain(text, { simulate, model }) {
  const request = { model, questions: QUESTIONS, state: text };
  if (!simulate) {
    try {
      const res = await fetch('/api/brain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), { status: res.status, code: data?.error?.code });
      return { simulated: false, request: data.request ?? request, response: data.response, latencyMs: data.latencyMs, signals: refineLanguage(parseSignals(data.response), text) };
    } catch (err) {
      const fallback = await simulated(text, request);
      return { ...fallback, error: { message: err.message, status: err.status, code: err.code } };
    }
  }
  return simulated(text, request);
}

async function simulated(text, request) {
  const t0 = performance.now();
  await sleep(650 + (hash(text) % 500));
  const response = simulateBrain(text);
  return { simulated: true, request, response, latencyMs: Math.round(performance.now() - t0), signals: refineLanguage(parseSignals(response), text) };
}
