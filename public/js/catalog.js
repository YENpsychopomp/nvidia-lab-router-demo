// 路由目標的模型目錄（示意用）。名稱、延遲與單價可依實際部署調整。
// 地端模型一律選用歐美開源模型：Google Gemma、Meta Llama、Mistral、OpenAI gpt-oss，以及以 Llama 為基礎的 TAIDE。
// price：每百萬 tokens 的 [輸入, 輸出] 美元單價；p50：首字延遲（秒）；quality：1–5 主觀品質分數。
export const MODELS = {
  gemma:  { tier: 'low', name: 'Gemma 3 4B',          role: '地端小模型',   where: '地端邊緣', line: 'edge',   cloud: false, quality: 2.0, p50: 0.4, price: [0.02, 0.04] },
  taide:  { tier: 'low', name: 'Llama-3.1-TAIDE 8B',  role: '繁中在地模型', where: '地端邊緣', line: 'edge',   cloud: false, quality: 2.6, p50: 0.7, price: [0.03, 0.06] },
  llama:  { tier: 'mid', name: 'Llama 3.3 70B',       role: '地端大模型',   where: '地端機房', line: 'dc',     cloud: false, quality: 3.6, p50: 2.0, price: [0.25, 0.40] },
  multi:  { tier: 'mid', name: 'Gemma 4 31B',         role: '多語模型',     where: '地端機房', line: 'dc',     cloud: false, quality: 3.5, p50: 1.6, price: [0.12, 0.30] },
  coder:  { tier: 'mid', name: 'Devstral Small 24B',  role: '程式專家',     where: '地端機房', line: 'expert', cloud: false, quality: 3.8, p50: 1.5, price: [0.10, 0.30] },
  reason: { tier: 'mid', name: 'gpt-oss-120b',        role: '推理專家',     where: '地端機房', line: 'expert', cloud: false, quality: 4.2, p50: 12,  price: [0.15, 0.60] },
  med:    { tier: 'mid', name: 'MedGemma 27B',        role: '醫療專家',     where: '地端機房', line: 'expert', cloud: false, quality: 3.8, p50: 1.8, price: [0.15, 0.30] },
  mini:   { tier: 'high', name: 'GPT-5 mini',          role: '雲端輕量模型', where: '雲端',     line: 'cloud',  cloud: true,  quality: 4.1, p50: 1.6, price: [0.25, 2.00] },
  gpt5:   { tier: 'high', name: 'GPT-5',               role: '雲端旗艦模型', where: '雲端',     line: 'cloud',  cloud: true,  quality: 5.0, p50: 6,   price: [1.25, 10.0] },
  search: { tier: 'high', name: 'GPT-5 + 網路搜尋',     role: '雲端即時資料', where: '雲端',     line: 'cloud',  cloud: true,  quality: 5.0, p50: 9,   price: [1.25, 10.0] },
};

// 三個實際執行的聊天模型（LOW / MID / HIGH）分別對應路線圖上的三個主要站點；
// 其餘專家模型為示意，實際由所屬層級的模型回答。
export const TIER_SLOT = { low: 'gemma', mid: 'llama', high: 'gpt5' };
export const TIER_LABEL = { low: 'LOW', mid: 'MID', high: 'HIGH' };
export const TIER_MODELS = { low: null, mid: null, high: null };

export function applyTiers(tiers) {
  if (!tiers) return;
  for (const [tier, id] of Object.entries(TIER_SLOT)) {
    TIER_MODELS[tier] = tiers[tier];
    MODELS[id].name = tiers[tier];
    MODELS[id].real = true;
  }
}

// 路由決策實際由哪一層、哪個模型執行。
export function execution(decision) {
  const tier = decision.label ? 'high' : MODELS[decision.model]?.tier ?? 'mid';
  return { tier, label: TIER_LABEL[tier], model: TIER_MODELS[tier], virtual: !decision.label && !MODELS[decision.model]?.real };
}

export const LINES = [
  { id: 'edge',   label: '地端邊緣' },
  { id: 'dc',     label: '地端機房' },
  { id: 'expert', label: '地端專家' },
  { id: 'cloud',  label: '雲端' },
];

export const lineVar = (line) => (line ? `var(--line-${line})` : 'var(--ink-2)');

// 依問題長度與難度粗估 tokens 與費用。
export function estimate(modelId, signals, text) {
  const m = MODELS[modelId];
  if (!m) return null;
  const inTok = Math.max(16, Math.round([...text].length * 1.2)) + 40;
  const lvl = signals ? Math.round(signals.complexity.level) : 1;
  let outTok = [80, 260, 520, 820, 1200][Math.max(0, Math.min(4, lvl))];
  if (signals && signals.long_output.p >= 0.5) outTok = Math.max(outTok, 1600);
  const cost = (inTok * m.price[0] + outTok * m.price[1]) / 1e6;
  return { inTok, outTok, cost, p50: m.p50 };
}

export function formatCost(usd) {
  if (usd == null) return '—';
  if (usd < 0.0001) return '< $0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export function formatSeconds(s) {
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} 秒`;
}
