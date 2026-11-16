// 個資偵測與去識別化：在伺服器本機執行，原文不會送到任何外部服務。
//
// 兩種偵測器取聯集：
//   1. PII 模型：OpenMed-PII-Chinese-BigMed-Large-278M（XLM-RoBERTa 標記分類，int8 ONNX），
//      以 transformers.js 在本機推論，負責姓名、地址、帳號、生日這類格式不固定的個資。
//   2. 規則：台灣身分證、手機與市話、Email、信用卡號這類格式固定的欄位。
// 模型或 @huggingface/transformers 不存在時只用規則，並在狀態中註明。
import path from 'node:path';
import { existsSync } from 'node:fs';

export const MODEL_NAME = 'OpenMed-PII-Chinese-BigMed-Large-278M';
const MODEL_ID = 'openmed-pii-zh';
const CHUNK = 300;        // 每次推論的字數上限，避免超過模型的 512 tokens
const MIN_SCORE = 0.5;

// 模型標籤 → 遮罩類別。日期、金額、職稱、性別這類單獨無法識別個人的標籤不遮。
const CATEGORY = {
  FIRSTNAME: '姓名', MIDDLENAME: '姓名', LASTNAME: '姓名', PREFIX: null,
  PHONE: '電話', EMAIL: 'Email', SSN: '身分證號',
  CREDITCARD: '卡號', CVV: '卡號', BANKACCOUNT: '帳號', IBAN: '帳號', BIC: '帳號', ACCOUNTNAME: '帳號',
  STREET: '地址', BUILDINGNUMBER: '地址', SECONDARYADDRESS: '地址', CITY: '地址', COUNTY: '地址', STATE: null, ZIPCODE: '地址',
  DATEOFBIRTH: '生日', AGE: '年齡', PASSWORD: '密碼', PIN: '密碼', USERNAME: '帳號名稱',
  IPADDRESS: 'IP', MACADDRESS: '裝置識別碼', IMEI: '裝置識別碼', VIN: '車牌', VRM: '車牌', GPSCOORDINATES: '位置',
  BITCOINADDRESS: '錢包地址', ETHEREUMADDRESS: '錢包地址', LITECOINADDRESS: '錢包地址', MASKEDNUMBER: '帳號',
};
// 日期本身不算個資；前面緊接「生日、出生」時才當成生日遮罩。
CATEGORY.DATE = '_date';
// 相鄰時合併成一段（例如「王」「小明」、「三民區建工路」「415 號」）。
const MERGE = new Set(['姓名', '地址', '帳號']);

const RULES = [
  { category: '身分證號', re: /(?<![A-Za-z0-9])[A-Z][12A-D89]\d{8}(?!\d)/g },
  { category: '電話', re: /(?<!\d)09\d{2}[-\s]?\d{3}[-\s]?\d{3}(?!\d)/g },
  { category: '電話', re: /(?<!\d)\(?0\d{1,2}\)?[-\s]?\d{3,4}[-\s]?\d{4}(?!\d)/g },
  { category: 'Email', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { category: '卡號', re: /(?<!\d)(?:\d{4}[-\s]?){3}\d{4}(?!\d)/g },
  // 銀行帳號：緊接在「帳戶、帳號」之後的一串數字
  { category: '帳號', re: /(?<=(?:帳戶|帳號|账户|账号|戶頭)(?:是|為|:|：)?\s*)\d[\d-]{6,20}\d/g },
  // 台灣地址：縣市＋鄉鎮市區＋路街＋門牌號
  { category: '地址', re: /(?:台北|臺北|新北|桃園|台中|臺中|台南|臺南|高雄|基隆|新竹|嘉義|苗栗|彰化|南投|雲林|屏東|宜蘭|花蓮|台東|臺東|澎湖|金門|連江)[縣市][一-鿿]{1,3}[區鄉鎮市][一-鿿\d]{1,8}?[路街道](?:[一二三四五六七八九十\d]+段)?(?:\s*\d+\s*巷)?(?:\s*\d+\s*弄)?\s*\d+(?:之\d+)?\s*號(?:\s*\d+\s*樓)?/g },
  // 生日：「生日、出生日期」之後的日期
  { category: '生日', re: /(?<=(?:生日|出生日期|出生於|出生)(?:是|為|:|：)?\s*)(?:\d{2,4}\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2}\s*日?|民國\s*\d{2,3}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/g },
];

const state = { engine: 'rules', state: 'off', error: null, loadMs: null };
let loading = null;
let tokenizer = null;
let model = null;
let labels = null;
const cache = new Map();

export function piiStatus() {
  return { model: MODEL_NAME, ...state };
}

// 啟動時在背景載入；不會阻擋伺服器啟動。
export function initPii(root) {
  const dir = path.join(root, 'models', MODEL_ID);
  if (!existsSync(path.join(dir, 'onnx', 'model_quantized.onnx'))) {
    state.state = 'missing';
    state.error = `找不到模型檔，請執行 npm run pii:download（${path.relative(root, dir)}）`;
    return Promise.resolve(false);
  }
  state.state = 'loading';
  const t0 = performance.now();
  loading = (async () => {
    try {
      const tf = await import('@huggingface/transformers');
      tf.env.allowRemoteModels = false;
      tf.env.localModelPath = path.dirname(dir) + path.sep;
      tokenizer = await tf.AutoTokenizer.from_pretrained(MODEL_ID);
      model = await tf.AutoModelForTokenClassification.from_pretrained(MODEL_ID, { dtype: 'q8' });
      labels = model.config.id2label;
      state.engine = 'model';
      state.state = 'ready';
      state.loadMs = Math.round(performance.now() - t0);
      return true;
    } catch (err) {
      state.state = 'error';
      state.error = err.code === 'ERR_MODULE_NOT_FOUND' ? '未安裝 @huggingface/transformers，請執行 npm install' : err.message;
      return false;
    }
  })();
  return loading;
}

// ---------------------------------------------------------------- 偵測

function ruleSpans(text) {
  const out = [];
  for (const r of RULES) {
    for (const m of text.matchAll(r.re)) out.push({ start: m.index, end: m.index + m[0].length, category: r.category, source: 'rule', score: 1 });
  }
  return out;
}

// 依句號、換行把長文切成不超過 CHUNK 字的片段。
function chunks(text) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK);
    if (end < text.length) {
      const cut = Math.max(...['。', '！', '？', '\n', '；'].map((c) => text.lastIndexOf(c, end - 1)));
      if (cut > start + CHUNK / 2) end = cut + 1;
    }
    out.push([start, text.slice(start, end)]);
    start = end;
  }
  return out;
}

// XLM-R 的分詞會做 NFKC 正規化（全形標點變半形），所以先建立正規化文字與原文位置的對照。
function normalized(text) {
  let norm = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const n = text[i].normalize('NFKC');
    for (let k = 0; k < n.length; k++) map.push(i);
    norm += n;
  }
  return { norm, map };
}

// 這個模型逐字標註，而且同一類的機率會分散在 B- 與 I- 兩個標籤上（例如「陳」B-LASTNAME、
// 「美」「玲」B-FIRSTNAME）。所以先把每個字的機率依「遮罩類別」加總，再把相鄰同類的字合併成一段。
async function modelSpans(text) {
  const out = [];
  for (const [offset, part] of chunks(text)) {
    const enc = await tokenizer(part, { truncation: true, max_length: 512 });
    const { logits } = await model(enc);
    const [, len, n] = logits.dims;
    const data = logits.data;
    const ids = Array.from(enc.input_ids.data, Number);
    const { norm, map } = normalized(part);
    let cursor = 0;
    let cur = null;
    for (let t = 0; t < len; t++) {
      const piece = tokenizer.decode([ids[t]], { skip_special_tokens: true }).normalize('NFKC').trim();
      if (!piece) continue;
      const at = norm.indexOf(piece, cursor);
      if (at < 0 || at - cursor > 12) continue;
      cursor = at + piece.length;
      const start = offset + map[at];
      const end = offset + map[at + piece.length - 1] + 1;
      let max = -Infinity;
      for (let j = 0; j < n; j++) max = Math.max(max, data[t * n + j]);
      let sum = 0;
      const mass = {};
      for (let j = 0; j < n; j++) {
        const p = Math.exp(data[t * n + j] - max);
        sum += p;
        const label = labels[j];
        if (label === 'O') continue;
        const cat = CATEGORY[label.slice(2)] ?? '_other';
        mass[cat] = (mass[cat] ?? 0) + p;
      }
      let cat = null, best = 0;
      for (const [k, v] of Object.entries(mass)) if (v > best) { best = v; cat = k; }
      const score = best / sum;
      if (!cat || score < 0.5 || cat === '_other') { cur = null; continue; }
      if (cur && cur.category === cat && start - cur.end <= 1) {
        cur.end = end;
        cur.scores.push(score);
      } else {
        cur = { start, end, category: cat, scores: [score] };
        out.push(cur);
      }
    }
  }
  return out
    .map((s) => {
      let category = s.category;
      if (category === '_date') category = /(生日|出生)[^，。,\n]{0,6}$/.test(text.slice(Math.max(0, s.start - 10), s.start)) ? '生日' : null;
      return { start: s.start, end: s.end, category, source: 'model', score: s.scores.reduce((a, b) => a + b, 0) / s.scores.length };
    })
    .filter((s) => s.category && s.score >= MIN_SCORE);
}

function resolve(text, spans) {
  // 規則先佔位；模型的結果與規則重疊時以規則為準。
  spans.sort((a, b) => (a.source === b.source ? a.start - b.start || b.end - a.end : a.source === 'rule' ? -1 : 1));
  const kept = [];
  for (const s of spans) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  kept.sort((a, b) => a.start - b.start);
  // 相鄰的姓名、地址片段合併
  const merged = [];
  for (const s of kept) {
    const prev = merged.at(-1);
    if (prev && prev.category === s.category && MERGE.has(s.category) && /^[\s,，、]?$/.test(text.slice(prev.end, s.start))) {
      prev.end = s.end;
      prev.score = Math.min(prev.score, s.score);
      if (prev.source !== s.source) prev.source = 'both';
    } else merged.push({ ...s });
  }
  return merged;
}

export async function detect(text) {
  if (cache.has(text)) return cache.get(text);
  if (loading) await loading;
  let spans = ruleSpans(text);
  if (state.state === 'ready') spans = spans.concat(await modelSpans(text));
  const out = resolve(text, spans).map((s) => ({ ...s, text: text.slice(s.start, s.end) }));
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(text, out);
  return out;
}

// ---------------------------------------------------------------- 去識別化

// 把整段對話去識別化。同一個值在整段對話中對應同一個代號（例如〔姓名1〕），
// 模型仍看得出「這兩處指的是同一個人」，但看不到原始內容。
export async function deidentify(messages) {
  const t0 = performance.now();
  const codes = new Map();
  const counters = {};
  const code = (category, value) => {
    const k = `${category}\u0000${value}`;
    if (!codes.has(k)) codes.set(k, `〔${category}${(counters[category] = (counters[category] ?? 0) + 1)}〕`);
    return codes.get(k);
  };
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const out = [];
  let history = 0;
  let current = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (typeof m.content !== 'string' || !m.content) { out.push(m); continue; }
    const spans = await detect(m.content);
    let masked = '';
    let at = 0;
    for (const s of spans) {
      masked += m.content.slice(at, s.start) + code(s.category, s.text);
      at = s.end;
    }
    masked += m.content.slice(at);
    out.push({ ...m, content: masked });
    if (i === lastUser) {
      current = { text: masked, entities: spans.map((s) => ({ category: s.category, code: code(s.category, s.text), source: s.source, score: +s.score.toFixed(3) })) };
    } else history += spans.length;
  }
  return {
    messages: out,
    report: {
      engine: state.state === 'ready' ? 'model' : 'rules',
      model: state.state === 'ready' ? MODEL_NAME : null,
      note: state.state === 'ready' ? null : state.error ?? 'PII 模型尚未載入',
      current,
      historyMasked: history,
      ms: Math.round(performance.now() - t0),
    },
  };
}
