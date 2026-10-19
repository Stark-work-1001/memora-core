import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
const root=path.dirname(fileURLToPath(import.meta.url));
const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const output=path.resolve(root,'../memora/static/brain');
const mindRoot=path.join(root,'vendor/original-dev');
const worker=await esbuild.build({entryPoints:[path.join(mindRoot,'src/physics/worker.ts')],bundle:true,write:false,format:'iife',target:'es2020',minify:true,define:{'import.meta.url':'"embedded:memora-physics"'}});
let katexCss=await fs.readFile(path.join(root,'node_modules/katex/dist/katex.min.css'),'utf8');
const fontNames=[...new Set([...katexCss.matchAll(/url\(fonts\/([^)]+)\)/g)].map(m=>m[1]))];
for(const name of fontNames){const raw=await fs.readFile(path.join(root,'node_modules/katex/dist/fonts',name));const mime=name.endsWith('.woff2')?'font/woff2':name.endsWith('.woff')?'font/woff':'font/ttf';katexCss=katexCss.replaceAll('url(fonts/'+name+')','url(data:'+mime+';base64,'+raw.toString('base64')+')');}
const emptyDictionary={title:'Memora',attribution:'本地已审核记忆',source:'memory.sqlite3',sections:[],nodes:[],edges:[]};
const virtual={name:'memora-virtual',setup(build){build.onResolve({filter:/^virtual:/},args=>({path:args.path,namespace:'memora'}));build.onLoad({filter:/.*/,namespace:'memora'},args=>({contents:'export default '+JSON.stringify(args.path==='virtual:physics-worker'?worker.outputFiles[0].text:args.path==='virtual:katex-css'?katexCss:emptyDictionary),loader:'js'}));}};
// Three 3D brain types, all built from the same renderer: dictionary (语义关系, the original
// spring-layout view), matt (星云关系图, the same renderer with the reference site's baked nebula
// layout installed) and outline (层级脑图, the copied mind-map app). The order is the order the
// workbench lists them in; it does not affect the output.
for(const [name,vendor] of [['dictionary','dictionary-graph'],['matt','dictionary-graph'],['outline','original-dev']]){
  const destination=path.join(output,name);await fs.mkdir(destination,{recursive:true});
  await esbuild.build({absWorkingDir:root,entryPoints:[name+'.ts'],bundle:true,outfile:path.join(destination,'app.js'),format:'iife',target:'es2020',minify:true,legalComments:'eof',plugins:[virtual],define:{__PLUGIN_VERSION__:JSON.stringify(version),__PLUGIN_LOCALE__:'"zh"',__PLUGIN_STRINGS__:'undefined','process.env.NODE_ENV':'"production"'}});
  const css=await fs.readFile(path.join(root,'vendor',vendor,'standalone/styles.css'),'utf8');
  const workbenchCss=await fs.readFile(path.join(root,'graph-workbench.css'),'utf8');
  await fs.writeFile(path.join(destination,'styles.css'),':root{--sa-bg:#f7f7f5;--sa-ink:#1a1a19;--sa-muted:#6a6a66;--sa-faint:#9a9a96;--sa-line:#e3e3df;--sa-panel:#fff;--sa-accent:#286e58;}\n'+css+'\n'+workbenchCss);
  await fs.writeFile(path.join(destination,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memora · '+name+'</title><link rel="stylesheet" href="styles.css"></head><body><script src="app.js"></script></body></html>');
  console.log('Built Memora 3D '+name);
}
const plane=path.join(output,'plane');await fs.mkdir(plane,{recursive:true});
await esbuild.build({absWorkingDir:root,entryPoints:['plane.ts'],bundle:true,outfile:path.join(plane,'app.js'),target:'es2020',minify:true});
await fs.writeFile(path.join(plane,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memora · 2D</title><link rel="stylesheet" href="styles.css"></head><body><script src="app.js"></script></body></html>');
await fs.copyFile(path.join(root,'plane.css'),path.join(plane,'styles.css'));
// The DAG canvas is a top-level view, not a brain view: it resolves beside `output`, not under it.
const dag=path.resolve(root,'../memora/static/dag');await fs.mkdir(dag,{recursive:true});
await esbuild.build({absWorkingDir:root,entryPoints:['dag-main.ts'],bundle:true,outfile:path.join(dag,'app.js'),format:'iife',target:'es2020',minify:true,legalComments:'eof'});
await fs.copyFile(path.join(root,'dag.css'),path.join(dag,'styles.css'));
await fs.copyFile(path.join(root,'dag.html'),path.join(dag,'index.html'));
console.log('Built Memora workflow DAG canvas -> static/dag');
