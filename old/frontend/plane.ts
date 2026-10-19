/** Original 2D projection for the same memory/typed hierarchy data. No reference-site content. */
import { semanticLayout, CATEGORY_COLORS } from './semantic-layout';
import { rememberMemory, rememberedMemory } from './brain-selection';
interface Item { id:string; content:string; category:string; source:string; x:number; y:number }
interface Link { a:string; b:string; relation:string }
const params=new URLSearchParams(location.search),project=params.get('project')||'default',outline=params.get('mode')==='outline';
const root=document.createElement('main');root.className='plane';document.body.append(root);
const bar=document.createElement('header');bar.append(document.createTextNode(outline?'层级脑图 · 2D':'词义关系 · 2D'));root.append(bar);
const search=document.createElement('input');search.placeholder='搜索词条、来源…';search.setAttribute('aria-label','搜索二维脑图');
const layout=document.createElement('select');layout.setAttribute('aria-label','二维脑图布局');for(const [id,title] of [['semantic','关系聚类'],['layer','层级分层'],['radial','径向'],['grid','网格']]){const o=document.createElement('option');o.value=id;o.textContent=title;layout.append(o);}layout.value=outline?'layer':'semantic';
const reset=document.createElement('button');reset.textContent='全览';const flow=document.createElement('button');flow.textContent='流动：开';bar.append(search,layout,reset,flow);
const stage=document.createElement('div');stage.className='plane-stage';root.append(stage);
const canvas=document.createElement('canvas');canvas.setAttribute('aria-label','可拖动、缩放的二维记忆关系图');stage.append(canvas);
const ctx=canvas.getContext('2d')!;const panel=document.createElement('aside');panel.className='plane-panel';stage.append(panel);
const list=document.createElement('div');list.className='plane-results';root.append(list);
let nodes:Item[]=[],links:Link[]=[],selected='',width=800,height=600,scale=1,ox=0,oy=0,animation=0;
let runningFlow=!matchMedia('(prefers-reduced-motion: reduce)').matches;flow.textContent='流动：'+(runningFlow?'开':'关');
const byId=new Map<string,Item>();let active=new Set<string>();
/* The same category titles the 3D dictionary builds its sections from (memory-source.ts), so the
   grouping labels in the 2D hierarchy are the ones a reader already saw in the other views. */
const CATEGORY_TITLES:Record<string,string>={fact:'事实与词义',knowledge:'知识库',preference:'用户习惯',decision:'项目决策',procedure:'工具与步骤',lesson:'经验教训'};
function fit(ids?:Set<string>){const points=ids?nodes.filter(n=>ids.has(n.id)):nodes;if(!points.length)return;
  const minX=Math.min(...points.map(n=>n.x))-100,maxX=Math.max(...points.map(n=>n.x))+200,minY=Math.min(...points.map(n=>n.y))-70,maxY=Math.max(...points.map(n=>n.y))+70;
  const targetScale=Math.min((width-(selected?Math.min(320,width*.35):0))/(maxX-minX),height/(maxY-minY),2),targetX=(width-(selected?Math.min(320,width*.35):0))/2-(minX+maxX)/2*targetScale,targetY=height/2-(minY+maxY)/2*targetScale;
  const from={scale,ox,oy},start=performance.now();cancelAnimationFrame(animation);
  function tween(t:number){const f=matchMedia('(prefers-reduced-motion: reduce)').matches?1:Math.min(1,(t-start)/600),e=1-(1-f)**3;scale=from.scale+(targetScale-from.scale)*e;ox=from.ox+(targetX-from.ox)*e;oy=from.oy+(targetY-from.oy)*e;draw(t);if(f<1)animation=requestAnimationFrame(tween);}
  animation=requestAnimationFrame(tween);
}
/* Level seeds: the row a node is drawn on when the stored hierarchy does not define enough
   levels (see rowsOnly below). Also carries the grouping anchor's own row. */
const seeds=new Map<string,number>();
/** True when the visible levels come from the category rows rather than from stored links. */
let rowsOnly=false;
function arrange(){const depth=new Map<string,number>(nodes.map(n=>[n.id,seeds.get(n.id)??0]));
  if(layout.value==='semantic'){
    const positions=semanticLayout(nodes,links);for(const n of nodes)Object.assign(n,positions.get(n.id));
    selected='';active.clear();panel.hidden=true;fit();return;
  }
  // Bounded relaxation also handles semantic cycles without asserting they are a DAG.
  // Row mode skips it: there the row IS the level, and letting a single stored sequence link
  // pull its target into another category's row would draw a two-row detour for one arrow.
  if(outline&&!rowsOnly){const stored=links.filter(e=>e.relation!=='category');
    for(let round=0;round<Math.min(12,nodes.length);round++){let changed=false;for(const e of stored){const a=depth.get(e.a)||0,b=depth.get(e.b)||0;if(b<a+1){depth.set(e.b,Math.min(12,a+1));changed=true;}}if(!changed)break;}}
  // In row mode the anchor is drawn left of its members on the same row: members start at
  // slot 1 so the anchor's label never sits under the first member's.
  const counts=new Map<number,number>();
  if(rowsOnly)for(const n of nodes)if(n.id.startsWith('category:')){const level=depth.get(n.id)||0;counts.set(level,1);}
  nodes.forEach((n,i)=>{const level=depth.get(n.id)||0,slot=counts.get(level)||0;counts.set(level,slot+1);
    if(layout.value==='radial'){const theta=i/Math.max(1,nodes.length)*Math.PI*2,r=outline?100+level*110:Math.max(170,nodes.length*12);n.x=Math.cos(theta)*r;n.y=Math.sin(theta)*r;}
    else if(layout.value==='grid'){const cols=Math.max(1,Math.ceil(Math.sqrt(nodes.length)));n.x=(i%cols)*260;n.y=Math.floor(i/cols)*130;}
    else if(rowsOnly){n.x=slot*260;n.y=level*160;}
    else {n.x=outline?slot*260:i%Math.max(1,Math.ceil(Math.sqrt(nodes.length)))*260;n.y=outline?level*160:Math.floor(i/Math.max(1,Math.ceil(Math.sqrt(nodes.length))))*150;}
  });selected='';active.clear();panel.hidden=true;fit();}
function focus(id:string){rememberMemory(id);selected=id;active=new Set([id]);for(const e of links){if(e.a===id)active.add(e.b);if(e.b===id)active.add(e.a);}const n=byId.get(id)!;panel.replaceChildren();panel.hidden=false;const h=document.createElement('h2');h.textContent=n.content.split('\n')[0].slice(0,100);const p=document.createElement('p');p.textContent=n.content;const meta=document.createElement('small');meta.textContent=n.category+' · '+n.source+'\nID: '+n.id;panel.append(h,p,meta);
  for(const e of links.filter(e=>e.a===id||e.b===id)){const b=document.createElement('button');const target=e.a===id?e.b:e.a;b.textContent=(e.a===id?'→ ':'← ')+e.relation+' · '+byId.get(target)?.content.slice(0,35);b.onclick=()=>focus(target);panel.append(b);}fit(active);}
function draw(t=performance.now()){ctx.clearRect(0,0,width,height);ctx.fillStyle='#f7f7f5';ctx.fillRect(0,0,width,height);ctx.save();ctx.translate(ox,oy);ctx.scale(scale,scale);
  for(const e of links){const a=byId.get(e.a),b=byId.get(e.b);if(!a||!b)continue;const hot=e.a===selected||e.b===selected;ctx.strokeStyle=hot?'#1d7959':selected?'#dadbd6':'#9daba2';ctx.lineWidth=(hot?2:1)/scale;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    if(outline){const angle=Math.atan2(b.y-a.y,b.x-a.x),x=b.x-Math.cos(angle)*12,y=b.y-Math.sin(angle)*12;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x-Math.cos(angle-.45)*12,y-Math.sin(angle-.45)*12);ctx.lineTo(x-Math.cos(angle+.45)*12,y-Math.sin(angle+.45)*12);ctx.closePath();ctx.fillStyle=hot?'#1d7959':'#9daba2';ctx.fill();
      if(runningFlow){const f=(t/3000)%1;ctx.beginPath();ctx.arc(a.x+(b.x-a.x)*f,a.y+(b.y-a.y)*f,4/scale,0,Math.PI*2);ctx.fillStyle='#1d7959';ctx.fill();}}
  }
  const occupied:Array<{x:number;y:number;w:number;h:number}>=[];
  const ordered=[...nodes].sort((a,b)=>Number(b.id===selected)-Number(a.id===selected)||Number(active.has(b.id))-Number(active.has(a.id)));
  const degrees=new Map<string,number>();for(const e of links){degrees.set(e.a,(degrees.get(e.a)||0)+1);degrees.set(e.b,(degrees.get(e.b)||0)+1);}
  for(const n of ordered){const anchor=n.id.startsWith('category:');const hot=!selected||active.has(n.id);
    const radius=anchor?4:n.id===selected?13:7+Math.min(8,Math.sqrt(degrees.get(n.id)||0)*2);
    ctx.fillStyle=hot?(CATEGORY_COLORS[n.category]||'#5c6b62'):'#cdd3ce';
    ctx.beginPath();ctx.arc(n.x,n.y,radius,0,Math.PI*2);ctx.fill();
    ctx.font=`${n.id===selected?'600':anchor?'600':'400'} ${Math.max(10,13/scale)}px sans-serif`;
    // Anchors name a row, not a memory, so they are drawn apart from the member labels.
    const label=n.content.split('\n')[0].slice(0,28),x=(n.x+radius+8)*scale+ox,y=n.y*scale+oy;
    const box={x,y:y-12,w:ctx.measureText(label).width*scale,h:17};
    const overlap=occupied.some(b=>box.x<b.x+b.w&&box.x+box.w>b.x&&box.y<b.y+b.h&&box.y+box.h>b.y);
    if(n.id===selected||active.has(n.id)||!overlap){ctx.fillStyle=hot?'#24332c':'#8b9690';ctx.fillText(label,n.x+radius+8,n.y+(anchor?-8:5));occupied.push(box);}}
  ctx.restore();}
new ResizeObserver(()=>{width=stage.clientWidth;height=stage.clientHeight;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=width*dpr;canvas.height=height*dpr;canvas.style.width=width+'px';canvas.style.height=height+'px';ctx.setTransform(dpr,0,0,dpr,0,0);
  // The graph may already be laid out: a resize must re-frame it for the NEW stage size, or
  // the fit stays at whatever the previous (often default) dimensions allowed.
  if(nodes.length){cancelAnimationFrame(animation);fit(selected?active:undefined);}
  draw();}).observe(stage);
let pointer:{x:number;y:number;ox:number;oy:number}|null=null,moved=false;
canvas.onpointerdown=e=>{pointer={x:e.offsetX,y:e.offsetY,ox,oy};moved=false;canvas.setPointerCapture(e.pointerId);cancelAnimationFrame(animation);};
canvas.onpointermove=e=>{if(!pointer)return;const dx=e.offsetX-pointer.x,dy=e.offsetY-pointer.y;if(Math.hypot(dx,dy)>4)moved=true;if(moved){ox=pointer.ox+dx;oy=pointer.oy+dy;draw();}};
canvas.onpointerup=e=>{if(pointer&&!moved){const x=(e.offsetX-ox)/scale,y=(e.offsetY-oy)/scale;const hit=nodes.filter(n=>Math.hypot(n.x-x,n.y-y)<20/scale).sort((a,b)=>Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y))[0];if(hit)focus(hit.id);}pointer=null;};
canvas.addEventListener('wheel',e=>{e.preventDefault();cancelAnimationFrame(animation);const prior=scale;scale=Math.max(.08,Math.min(8,scale*Math.exp(-e.deltaY*.001)));ox=e.offsetX-(e.offsetX-ox)*scale/prior;oy=e.offsetY-(e.offsetY-oy)*scale/prior;draw();},{passive:false});
layout.onchange=arrange;reset.onclick=()=>{selected='';active.clear();panel.hidden=true;fit();};flow.onclick=()=>{runningFlow=!runningFlow;flow.textContent='流动：'+(runningFlow?'开':'关');draw();};
search.oninput=()=>{list.replaceChildren();if(!search.value.trim())return;const q=search.value.toLowerCase();for(const n of nodes.filter(n=>(n.content+' '+n.source).toLowerCase().includes(q)).slice(0,30)){const b=document.createElement('button');b.textContent=n.content.slice(0,80);b.onclick=()=>focus(n.id);list.append(b);}};
setInterval(()=>{if(runningFlow&&outline&&!document.hidden)draw();},50);
/* Observation hook for the acceptance run: the canvas is the only place the layout exists, so a
   check that "the map is not one flat line" has to read the world coordinates and transform rather
   than try to infer them from pixels. Read-only; it changes nothing about what is drawn. */
(window as any).memoraPlane={nodes:()=>nodes.map(n=>({id:n.id,x:n.x,y:n.y,category:n.category})),links:()=>links.map(l=>({a:l.a,b:l.b,relation:l.relation})),transform:()=>({scale,ox,oy,width,height}),selected:()=>selected};
fetch('/api/agent/map?project='+encodeURIComponent(project)
  // The 2D view must honour the same preview flag as the 3D views, or the toggle
  // leaves this one showing an empty stage.
  +(params.get('preview')==='1'?'&preview=1':'')).then(r=>{if(!r.ok)throw new Error('数据读取失败');return r.json();}).then(g=>{nodes=g.nodes.map((n:Item)=>({...n,x:0,y:0}));nodes.forEach(n=>byId.set(n.id,n));links=outline?g.hierarchy.map((h:any)=>({a:h.parent,b:h.child,relation:h.kind})):g.edges;
  // The hierarchy view draws its edges from stored hierarchy links. A project whose
  // hierarchy is sparse (or, before any relationship is stored, absent) would then show a
  // single flat row with a couple of stray lines, however many memories it has. So the
  // category grouping the 3D views already use becomes real structure here: one anchor per
  // category, anchored edges to its members, and the anchor's row seeds the level so the
  // members do not all collapse back onto level 0. Stored hierarchy links stay untouched
  // and are drawn alongside; when they already reach most nodes nothing is synthesised,
  // so a real deep hierarchy is never overridden by the categories.
  if(outline){const reached=new Set(links.flatMap(e=>[e.a,e.b]));
    rowsOnly=reached.size<nodes.length*0.6;
    if(rowsOnly){const categories=[...new Set(nodes.map(n=>n.category))];
      const rowOf=new Map<string,number>();categories.forEach((category,row)=>rowOf.set(category,row));
      // Every memory takes its category's row, and each row gets one anchor drawn to its left
      // of the members on that same row. The anchor is what makes the grouping visible as a
      // connection; the row is what stops 14 unconnected terms from stacking into one line.
      for(const n of nodes)seeds.set(n.id,rowOf.get(n.category)??0);
      categories.forEach(category=>{const id='category:'+category,row=rowOf.get(category)!;
        const n={id,content:CATEGORY_TITLES[category]||category,category:'分类',source:'结构分组，非语义关系',x:0,y:0};
        nodes.unshift(n);byId.set(id,n);seeds.set(id,row);
        for(const child of nodes.filter(x=>x.category===category&&x.id!==id))links.push({a:id,b:child.id,relation:'category'});});}}
  // The stage may not have been measured yet when the data arrives (the fetch can resolve
  // before the first ResizeObserver callback), and a fit against the 800x600 defaults would
  // centre the whole map around a stale origin. Measure first, then lay out and fit.
  if(stage.clientWidth){width=stage.clientWidth;height=stage.clientHeight;}
  arrange();
  const saved=rememberedMemory();if(saved&&byId.has(saved))focus(saved);
  if(!nodes.length)panel.append(document.createTextNode('尚无已审核的记忆，请先添加或导入并审核。'));}).catch(e=>{panel.textContent=String(e);panel.hidden=false;});
