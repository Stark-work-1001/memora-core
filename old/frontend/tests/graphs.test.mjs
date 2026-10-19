import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
async function load(path){const result=await build({entryPoints:[path],bundle:true,format:'esm',platform:'node',write:false,define:{__PLUGIN_VERSION__:'"1.0.0"',__PLUGIN_LOCALE__:'"zh"',__PLUGIN_STRINGS__:'undefined'},plugins:[{name:'empty-dictionary',setup(b){b.onResolve({filter:/^virtual:/},a=>({path:a.path,namespace:'empty'}));b.onLoad({filter:/.*/,namespace:'empty'},()=>({contents:'export default {title:"",sections:[],nodes:[],edges:[]}',loader:'js'}));}}]});return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));}
test('both copied Markdown renderers escape HTML and reject executable link schemes',async()=>{for(const vendor of ['dictionary-graph','original-dev']){const m=await load(`vendor/${vendor}/standalone/src/core/markdown.ts`);const html=m.renderMarkdown('<script>bad()</script> [click](javascript:bad) [safe](https://example.com)');assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));assert.ok(html.includes('href="https://example.com"'));}});
test('dictionary graph preserves explicit cross references',async()=>{const m=await load('vendor/dictionary-graph/src/model/graph.ts');const graph=m.buildNoteGraph('# Knowledge\n## Terms\n### Memory\nStores facts. [[Embedding]]\n### Embedding\nVector meaning.','Memora');assert.ok(graph.nodes.some(n=>n.title==='Memory'));assert.ok(graph.edges.length>=1);});
test('sanitized copied Rust WASM still compiles without embedded home path',async()=>{const source=await readFile('vendor/original-dev/src/physics/generated/wasm-asset.ts','utf8');const encoded=source.match(/["']([A-Za-z0-9+/=]{1000,})["']/)[1];const bytes=Buffer.from(encoded,'base64');assert.ok(!bytes.includes(Buffer.from('C:'+String.fromCharCode(92)+'Users')));assert.ok(await WebAssembly.compile(bytes));});

test('graph search supports Chinese, aliases in bodies, and stable title-first ranking',async()=>{const m=await load('graph-workbench.ts');const entries=[{id:'a',title:'Other',body:'Memory 中文 来源',section:'Tools'},{id:'b',title:'Memory 中文',body:'document',section:'Knowledge'}];assert.deepEqual(m.searchEntries(entries,'Ｍｅｍｏｒｙ 中文').map(e=>e.id),['b','a']);assert.deepEqual(m.searchEntries(entries,'来源').map(e=>e.id),['a']);assert.equal(m.searchEntries(entries,'does-not-exist').length,0);});

test('outline inspector receives quoted version content instead of an empty heading',async()=>{const m=await load('vendor/original-dev/src/model/markdown-parser.ts');const tree=m.parseOutline('# Memora\n\n## Documents\n\n### Agent guide\n> audience: agent\n> Published version content\n> ## quoted heading\n\n### Other\n> Different note',{basename:'Memora'});const children=tree.root.children.flatMap(n=>[n,...n.children.flatMap(c=>[c,...c.children])]);const guide=children.find(n=>n.text==='Agent guide');assert.ok(guide?.note.includes('Published version content'));assert.ok(!children.some(n=>n.text==='quoted heading'));});

test('dictionary best-view framing keeps the selected local cluster inside portrait and wide viewports',async()=>{
  const {OrbitCamera}=await load('vendor/dictionary-graph/src/view/orbit-camera.ts');
  const {Vector3}=await import('three');
  const points=[new Vector3(-60,0,0),new Vector3(60,0,0),new Vector3(0,40,20)];
  for(const viewport of [{width:300,height:800},{width:1200,height:500}]){
    const camera=new OrbitCamera();camera.setAspect(viewport.width/viewport.height);
    camera.frameAll(points,new Vector3(),90,viewport,0);camera.update(16,performance.now()+20);
    camera.camera.updateMatrixWorld();
    for(const point of points){const p=point.clone().project(camera.camera);assert.ok(Math.abs(p.x)<1&&Math.abs(p.y)<1&&p.z<1,JSON.stringify(p));}
  }
});
