// 本機伺服器：提供靜態網頁，並把 /api/* 代理到 LiteLLM（金鑰只留在伺服器端）。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initPii, piiStatus, deidentify, detect } from './pii.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv(path.join(ROOT, '.env'));

const cfg = {
  port: Number(process.env.PORT) || 5180,
  baseUrl: (process.env.LITELLM_BASE_URL || 'https://eric51.iai.nkust.edu.tw/uclazure/v1').replace(/\/+$/, ''),
  apiKey: process.env.LITELLM_API_KEY || '',
  brainModel: process.env.BRAIN_MODEL || 'Microsoft-Decision-1',
  chatModel: process.env.CHAT_MODEL || 'auto',
  // 未設定時使用預設提示；在 .env 寫 CHAT_SYSTEM_PROMPT= （留空）即可關閉。
  systemPrompt: process.env.CHAT_SYSTEM_PROMPT ?? '請使用與使用者相同的語言回答。使用者以中文提問時，一律使用繁體中文與台灣用語。',
};

// 聊天可以走另一個端點；設定了 LOW / MID / HIGH 三個模型時，auto 會依路由決策挑選其中一個。
const chat = {
  baseUrl: (process.env.LITELLM_CHAT_BASE_URL || cfg.baseUrl).replace(/\/+$/, ''),
  apiKey: process.env.LITELLM_CHAT_API_KEY || cfg.apiKey,
  tiers: {
    low: process.env.LITELLM_CHAT_MODEL_LOW || '',
    mid: process.env.LITELLM_CHAT_MODEL_MID || '',
    high: process.env.LITELLM_CHAT_MODEL_HIGH || '',
  },
};
const hasTiers = Boolean(chat.tiers.low && chat.tiers.mid && chat.tiers.high);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('請求內容過大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function upstreamHeaders(key = cfg.apiKey) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-litellm-api-key': key,
    authorization: `Bearer ${key}`,
  };
}

function upstreamMessage(data, status) {
  const e = data?.error ?? data?.detail ?? data;
  const msg = typeof e === 'string' ? e : e?.message ?? e?.msg ?? JSON.stringify(e).slice(0, 300);
  return msg || `HTTP ${status}`;
}

// 去識別化後的內容裡，個資已換成〔類別編號〕代號；請模型照原樣保留代號，不要猜測原值。
const DEID_PROMPT = '使用者訊息中形如〔姓名1〕、〔身分證號1〕的文字，是在本機去識別化後的個資代號。回答時請照原樣保留這些代號，不要猜測或補上原始內容。';

const NO_KEY = { error: { code: 'no_key', message: '伺服器尚未設定 LITELLM_API_KEY。請在 .env 填入金鑰後重新啟動。' } };

async function handleBrain(req, res) {
  if (!cfg.apiKey) return sendJson(res, 503, NO_KEY);
  const body = JSON.parse((await readBody(req)) || '{}');
  // SystemOne 在雲端：問題送出前一律先在本機遮罩個資。代號仍保留「這裡有身分證號」的資訊，
  // 所以大腦依然判斷得出含個資，只是看不到原值。
  const { messages: [masked], report } = await deidentify([{ role: 'user', content: String(body.state ?? '') }]);
  const payload = { model: body.model || cfg.brainModel, questions: body.questions, state: masked.content };
  const t0 = performance.now();
  try {
    const up = await fetch(`${cfg.baseUrl}/systemone`, {
      method: 'POST',
      headers: upstreamHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await up.text();
    const latencyMs = Math.round(performance.now() - t0);
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!up.ok) {
      return sendJson(res, up.status, { error: { code: 'upstream', status: up.status, message: upstreamMessage(data, up.status) }, latencyMs });
    }
    sendJson(res, 200, { request: payload, response: data, latencyMs, deid: report });
  } catch (err) {
    sendJson(res, 502, { error: { code: 'network', message: `無法連線到 SystemOne：${err.message}` } });
  }
}

async function handleChat(req, res) {
  if (!chat.apiKey) return sendJson(res, 503, NO_KEY);
  const body = JSON.parse((await readBody(req)) || '{}');
  const model = hasTiers ? chat.tiers[body.tier] || chat.tiers.mid : cfg.chatModel;
  // 路由決定送往雲端、且策略要求去識別化時，整段對話（含歷史）在轉送前先遮罩。
  let messages = Array.isArray(body.messages) ? body.messages : [];
  let deid = null;
  if (body.deidentify) {
    ({ messages, report: deid } = await deidentify(messages));
  }
  const system = [cfg.systemPrompt, deid && DEID_PROMPT].filter(Boolean).join('\n');
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    const up = await fetch(`${chat.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: upstreamHeaders(chat.apiKey),
      body: JSON.stringify({ model, messages: system ? [{ role: 'system', content: system }, ...messages] : messages, stream: true }),
      signal: ac.signal,
    });
    if (!up.ok) {
      const text = await up.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return sendJson(res, up.status, { error: { code: 'upstream', status: up.status, message: upstreamMessage(data, up.status) } });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 第一個事件告訴瀏覽器實際送出的內容遮罩了哪些地方。
    if (deid) res.write(`data: ${JSON.stringify({ deid })}\n\n`);
    for await (const chunk of up.body) res.write(chunk);
    res.end();
  } catch (err) {
    if (ac.signal.aborted) return;
    if (!res.headersSent) sendJson(res, 502, { error: { code: 'network', message: `無法連線到 auto 模型：${err.message}` } });
    else res.end();
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('找不到檔案');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, {
        brainModel: cfg.brainModel,
        chatModel: cfg.chatModel,
        hasKey: Boolean(cfg.apiKey),
        endpoint: cfg.baseUrl,
        hasChatKey: Boolean(chat.apiKey),
        chatEndpoint: chat.baseUrl,
        chatTiers: hasTiers ? chat.tiers : null,
        pii: piiStatus(),
      });
    }
    if (pathname === '/api/brain' && req.method === 'POST') return await handleBrain(req, res);
    if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (pathname === '/api/pii' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = String(body.text ?? '');
      return sendJson(res, 200, { status: piiStatus(), entities: await detect(text), ...(await deidentify([{ role: 'user', content: text }])).report });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);
    res.writeHead(405); res.end();
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: { code: 'server', message: err.message } });
  }
});

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`連接埠 ${cfg.port} 已被占用，可能是另一個 Router demo 還在執行。`);
  console.error(`  查看占用的程式：lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN`);
  console.error(`  或改用其他連接埠：PORT=${cfg.port + 1} npm start`);
  process.exit(1);
});

server.listen(cfg.port, () => {
  console.log(`Router demo running at http://localhost:${cfg.port}`);
  console.log(`  endpoint   ${cfg.baseUrl}`);
  console.log(`  brain      ${cfg.brainModel}`);
  console.log(`  chat       ${chat.baseUrl}`);
  console.log(`  chat model ${hasTiers ? `${cfg.chatModel} → LOW ${chat.tiers.low} / MID ${chat.tiers.mid} / HIGH ${chat.tiers.high}` : cfg.chatModel}`);
  console.log(`  api key    ${cfg.apiKey ? 'set' : 'missing (brain runs in simulated mode)'}`);
  initPii(ROOT).then(() => {
    const st = piiStatus();
    console.log(`  pii        ${st.state === 'ready' ? `${st.model} (loaded in ${st.loadMs} ms)` : `rules only: ${st.error}`}`);
  });
});
