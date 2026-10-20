import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(root, '../memora_core/static');

// KaTeX 的 CSS 要内联字体（桌面离线，不允许外部请求）。
// 只保留 woff2：Chromium / Electron 永远优先取 woff2，woff 与 ttf 只是被下载却用不上的体积
// （1.0.0 三种格式全内联，katex.css 1.46 MB，其中 woff 405 KB、ttf 685 KB 从未被使用）。
async function katexCss() {
  let css = await fs.readFile(path.join(root, 'node_modules/katex/dist/katex.min.css'), 'utf8');
  css = css.replace(/,\s*url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, '');
  if (/url\(fonts\/[^)]+\.(?:woff|ttf)\)/.test(css)) {
    throw new Error('katex.min.css 的 @font-face 格式变了：仍有 woff/ttf 引用，请更新 build.mjs 的过滤规则');
  }
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

// 入口按存在与否分别构建：app 与 brain 缺一个不能拖垮另一个。
// 路径相对 build.mjs 所在目录判断（1.0.0 相对 cwd，从仓库根运行时两个入口都"不存在"）。
const exists = (rel) => fs.access(path.join(root, rel)).then(() => true, () => false);
const entries = {};
if (await exists('src/app/main.ts')) entries.app = 'src/app/main.ts';
if (await exists('src/brain/main.ts')) entries.brain = 'src/brain/main.ts';
if (!Object.keys(entries).length) throw new Error('找不到任何入口（src/app/main.ts / src/brain/main.ts）');

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: entries,
  bundle: true,
  outdir: out,
  format: 'iife',
  target: 'es2020',
  minify: true,
  sourcemap: false,
  metafile: true,
  legalComments: 'eof',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
  // CSS：main.ts 里的 `import './style.css'` 会被抽成 app.css；字体与图片内联，保持零外部请求。
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

const css = await katexCss();
await fs.writeFile(path.join(out, 'katex.css'), css);

// CSP 只能写 <meta> 支持的指令：frame-ancestors 在 meta 里会被忽略并在控制台报错，
// 它由服务端响应头（frame-ancestors 'self'）负责。
// <link rel="icon" href="data:,">：后端不提供 /favicon.ico，否则每次打开页面都有一条 404 控制台错误。
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
  + "font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:";

function page({ title, mount, styles, script }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<link rel="icon" href="data:,">
<title>${title}</title>
${styles.map((href) => `<link rel="stylesheet" href="${href}">\n`).join('')}</head>
<body>
<div id="${mount}"></div>
<script src="${script}"></script>
</body>
</html>
`;
}

// 主应用挂 #mem-root（app/main.ts 硬性要求）。katex.css 不再阻塞首屏：
// markdown.ts 第一次真正渲染公式时才按需插入 <link href="/katex.css">。
await fs.writeFile(path.join(out, 'index.html'),
  page({ title: 'memora-core · 记忆中枢', mount: 'mem-root', styles: ['/app.css'], script: '/app.js' }));
// 脑图页挂 #mem-brain；样式全部由 brain.js 注入（brain/style.ts），既不用 KaTeX 也不用 app.css。
await fs.writeFile(path.join(out, 'brain.html'),
  page({ title: '脑图 · memora-core · 记忆中枢', mount: 'mem-brain', styles: [], script: '/brain.js' }));

const outputs = Object.keys(result.metafile.outputs);
console.log('built', outputs.length + 3, 'outputs ->', out);
for (const file of [...outputs.map((name) => path.basename(name)), 'katex.css', 'index.html', 'brain.html']) {
  const stat = await fs.stat(path.join(out, file));
  console.log('  ' + file.padEnd(12) + String(stat.size).padStart(9) + ' B');
}