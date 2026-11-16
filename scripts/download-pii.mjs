// 下載本機去識別化用的中文 PII 模型（約 870 MB）到 models/openmed-pii-zh。
// 用法：npm run pii:download
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'OpenMed/OpenMed-PII-Chinese-BigMed-Large-278M-v1-onnx-android';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'models', 'openmed-pii-zh');
// [倉庫中的檔名, 本機檔名]；transformers.js 以 onnx/model_quantized.onnx 載入 int8 版本。
const FILES = [
  ['config.json', 'config.json'],
  ['tokenizer.json', 'tokenizer.json'],
  ['tokenizer_config.json', 'tokenizer_config.json'],
  ['README.md', 'README.md'],
  ['model_int8.onnx', 'onnx/model_quantized.onnx'],
];

mkdirSync(path.join(DIR, 'onnx'), { recursive: true });
for (const [remote, local] of FILES) {
  const dest = path.join(DIR, local);
  if (existsSync(dest) && statSync(dest).size > 0) { console.log(`已存在  ${local}`); continue; }
  const res = await fetch(`https://huggingface.co/${REPO}/resolve/main/${remote}`);
  if (!res.ok) throw new Error(`下載 ${remote} 失敗：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let shown = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    got += c.length;
    if (total > 50e6 && got - shown > 50e6) { shown = got; process.stdout.write(`\r下載中  ${local} ${Math.round(got / 1e6)} / ${Math.round(total / 1e6)} MB`); }
  });
  // 先寫到暫存檔，完整下載後才改名，中斷時不會留下不完整的模型。
  await pipeline(body, createWriteStream(`${dest}.part`));
  renameSync(`${dest}.part`, dest);
  console.log(`${total > 50e6 ? '\n' : ''}完成    ${local}`);
}
console.log(`模型已就緒：${path.relative(ROOT, DIR)}。重新啟動伺服器即可使用。`);
