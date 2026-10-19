import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(root, '../memora_core/static');

// KaTeX 的 CSS 要内联字体（桌面离线，不允许外部请求）
async function katexCss() {
  let css = await fs.readFile(path.join(root, 'node_modules/katex/dist/katex.min.css'), 'utf8');
  const names = [...new Set([...css.matchAll(/url\(fonts\/([^)]+)\)/g)].map((m) => m[1]))];
  for (const name of names) {
    const raw = await fs.readFile(path.join(root, 'node_modules/katex/dist/fonts', name));
    const mime = name.endsWith('.woff2') ? 'font/woff2' : name.endsWith('.woff') ? 'font/woff' : 'font/ttf';
    css = css.replaceAll('url(fonts/' + name + ')', 'url(data:' + mime + ';base64,' + raw.toString('base64') + ')');
  }
  return css;
}

await fs.mkdir(out, { recursive: true });
await fs.mkdir(path.join(out, 'brain'), { recursive: true });

// 入口按存在与否分别构建：T7 只负责 app，brain 由 T8 落地，缺一个不能拖垮另一个。
const entries = {};
if (await fs.access('src/app/main.ts').then(() => true, () => false)) entries.app = 'src/app/main.ts';
if (await fs.access('src/brain/main.ts').then(() => true, () => false)) entries.brain = 'src/brain/main.ts';

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: entries,
  bundle: true,
  outdir: out,
  format: 'iife',
  target: 'es2020',
  minify: true,
  sourcemap: false,
  legalComments: 'eof',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
  // CSS：main.ts 里的 `import './style.css'` 会被抽成 app.css；字体与图片内联，保持零外部请求。
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

const css = await katexCss();
await fs.writeFile(path.join(out, 'katex.css'), css);

const index = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'">
<title>memora-core · 记忆中枢</title>
<link rel="stylesheet" href="/katex.css">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="mem-root"></div>
<script src="/app.js"></script>
</body>
</html>
`;
await fs.writeFile(path.join(out, 'index.html'), index);
// 主应用挂 #mem-root（app/main.ts 硬性要求）；脑图页换成 #mem-brain（brain/main.ts 的挂载点）。
await fs.writeFile(path.join(out, 'brain.html'),
  index.replace('id="mem-root"', 'id="mem-brain"')
       .replace('src="/app.js"', 'src="/brain.js"')
       .replace('<title>', '<title>脑图 · '));
console.log('built', Object.keys(result.metafile ? result.metafile.outputs : {}).length, 'outputs ->', out);