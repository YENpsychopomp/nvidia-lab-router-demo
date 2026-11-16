// 產生 public/vendor/flow-kit.js 與 public/vendor/xyflow.css。
// 只有升級 React 或 React Flow 版本時才需要重新執行：npm install && npm run build
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../public/vendor');
const pkg = async (name) => JSON.parse(await readFile(path.join(here, 'node_modules', name, 'package.json'), 'utf8')).version;

await mkdir(out, { recursive: true });
await build({
  entryPoints: [path.join(here, 'entry.js')],
  outfile: path.join(out, 'flow-kit.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: `/* flow-kit: react ${await pkg('react')}, react-dom ${await pkg('react-dom')}, @xyflow/react ${await pkg('@xyflow/react')} (MIT). Built by tools/flow-kit. */` },
});
await copyFile(path.join(here, 'node_modules/@xyflow/react/dist/base.css'), path.join(out, 'xyflow.css'));
const css = await readFile(path.join(out, 'xyflow.css'), 'utf8');
await writeFile(path.join(out, 'xyflow.css'), `/* @xyflow/react ${await pkg('@xyflow/react')} base.css (MIT) */\n${css}`);
console.log('built', out);
