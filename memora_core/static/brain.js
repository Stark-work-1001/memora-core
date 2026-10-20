"use strict";(()=>{var Sl=String.raw`/* 记忆脑图叠加层样式。
   深色 + 青绿主色，等宽数字，卡片化；UI 全部由 brain.js 注入，不依赖任何外部样式表。
   1080p 以下自动收缩内边距，1280×800 起可用。 */

/* 挂载点（#mem-brain / #mem-root / 自造节点）必须撑满视口：.mem-brain-root 的
   height:100% 以它为参照。挂载点高度为 auto 时整棵树塌成 0 高、画布不可见——
   1.0.0 发布的脑图页就是这样（tests/brain-render.test.mjs 的拾取断言因此失败）。 */
.mem-brain-host {
  position: relative;
  width: 100%;
  height: 100%;
}

/* 盒模型自带：brain.html 不再加载 app.css（脑图用不到它的任何规则），
   原先靠 app.css 的全局 box-sizing: border-box 才排对的面板宽高在这里自己声明。 */
.mem-brain-host,
.mem-brain-host *,
.mem-brain-host *::before,
.mem-brain-host *::after {
  box-sizing: border-box;
}

.mem-brain-root {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #070b12;
  color: #d8e6f2;
  font: 13px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
  user-select: none;
  -webkit-font-smoothing: antialiased;
}

.mem-brain-root canvas.mem-brain-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
  cursor: grab;
}

.mem-brain-root canvas.mem-brain-canvas:active { cursor: grabbing; }

.mem-brain-ui {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
}

.mem-brain-ui > * { pointer-events: auto; }

/* ---------- 顶栏 ---------- */

.mem-topbar {
  position: absolute;
  top: 12px;
  left: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.mem-group {
  display: inline-flex;
  background: rgba(10, 18, 28, 0.86);
  border: 1px solid rgba(96, 160, 200, 0.22);
  border-radius: 9px;
  overflow: hidden;
  backdrop-filter: blur(8px);
}

.mem-group button {
  appearance: none;
  border: 0;
  background: transparent;
  color: #9fb6cc;
  padding: 7px 13px;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
  white-space: nowrap;
}

.mem-group button:hover { background: rgba(74, 163, 223, 0.14); color: #d6ecff; }

.mem-group button.is-active {
  background: linear-gradient(180deg, rgba(62, 207, 142, 0.28), rgba(74, 163, 223, 0.28));
  color: #eafcff;
  box-shadow: inset 0 -2px 0 #3ecf8e;
}

.mem-group button.is-active.is-active--alt { box-shadow: inset 0 -2px 0 #b07cf0; }

.mem-spacer { flex: 1 1 auto; min-width: 8px; }

/* ---------- 搜索 ---------- */

.mem-searchbox { position: relative; }

.mem-searchbox input {
  width: 220px;
  padding: 7px 11px;
  border-radius: 9px;
  border: 1px solid rgba(96, 160, 200, 0.22);
  background: rgba(10, 18, 28, 0.86);
  color: #e2f0ff;
  font: inherit;
  font-size: 12.5px;
  outline: none;
  backdrop-filter: blur(8px);
}

.mem-searchbox input:focus { border-color: rgba(62, 207, 142, 0.6); box-shadow: 0 0 0 2px rgba(62, 207, 142, 0.16); }
.mem-searchbox input::placeholder { color: #5d7590; }

.mem-search-list {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 300px;
  max-height: 320px;
  overflow: auto;
  background: rgba(9, 16, 25, 0.97);
  border: 1px solid rgba(96, 160, 200, 0.26);
  border-radius: 9px;
  display: none;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
}

.mem-search-list.is-open { display: block; }

.mem-search-list button {
  display: flex;
  width: 100%;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 11px;
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(80, 120, 160, 0.12);
  color: #d8e6f2;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.mem-search-list button:hover { background: rgba(74, 163, 223, 0.16); }
.mem-search-list button b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mem-search-list button span { color: #6d87a0; font-size: 11.5px; flex: 0 0 auto; }

/* ---------- 过滤面板（右上） ---------- */

.mem-filter {
  position: absolute;
  top: 58px;
  right: 12px;
  width: 208px;
  padding: 11px;
  background: rgba(10, 18, 28, 0.86);
  border: 1px solid rgba(96, 160, 200, 0.22);
  border-radius: 9px;
  backdrop-filter: blur(8px);
}

.mem-filter-title { font-size: 11.5px; letter-spacing: 0.08em; color: #6d87a0; text-transform: uppercase; margin-bottom: 8px; }

.mem-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 9px; }

.mem-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid rgba(96, 160, 200, 0.3);
  background: rgba(74, 163, 223, 0.1);
  color: #c7dcee;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: opacity 120ms ease;
}

.mem-chip i { width: 7px; height: 7px; border-radius: 50%; display: block; }
.mem-chip.is-off { opacity: 0.32; filter: grayscale(1); }

.mem-filter-row { margin-top: 7px; }
.mem-filter-row label { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: #8ba3ba; }

.mem-filter-row select {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(96, 160, 200, 0.24);
  background: rgba(7, 13, 21, 0.9);
  color: #d8e6f2;
  font: inherit;
  font-size: 12px;
  outline: none;
}

/* ---------- 水印 / loading ---------- */

.mem-watermark {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) rotate(-18deg);
  font-size: 72px;
  font-weight: 800;
  letter-spacing: 0.12em;
  color: rgba(126, 198, 240, 0.07);
  pointer-events: none;
  white-space: nowrap;
  text-shadow: 0 0 24px rgba(74, 163, 223, 0.12);
}

.mem-loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 9px 18px;
  border-radius: 999px;
  background: rgba(10, 18, 28, 0.92);
  border: 1px solid rgba(62, 207, 142, 0.35);
  color: #9ff0c8;
  font-size: 12.5px;
  letter-spacing: 0.04em;
}

/* ---------- mini-map（左下） ---------- */

.mem-minimap-wrap {
  position: absolute;
  left: 12px;
  bottom: 40px;
  padding: 3px;
  border-radius: 9px;
  background: rgba(10, 18, 28, 0.86);
  border: 1px solid rgba(96, 160, 200, 0.22);
  backdrop-filter: blur(8px);
}

.mem-minimap { display: block; width: 160px; height: 160px; border-radius: 6px; cursor: crosshair; }

/* ---------- 统计（右下） ---------- */

.mem-stats {
  position: absolute;
  right: 12px;
  bottom: 40px;
  min-width: 168px;
  padding: 9px 11px;
  background: rgba(10, 18, 28, 0.86);
  border: 1px solid rgba(96, 160, 200, 0.22);
  border-radius: 9px;
  backdrop-filter: blur(8px);
  font-variant-numeric: tabular-nums;
}

.mem-stats div { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; line-height: 1.75; color: #8ba3ba; }
.mem-stats b { color: #d8e6f2; font-weight: 600; font-variant-numeric: tabular-nums; }
.mem-stats b.is-warn { color: #ffb454; }

/* ---------- 图例 ---------- */

.mem-legend {
  position: absolute;
  left: 12px;
  top: 58px;
  max-width: 168px;
  padding: 9px 11px;
  background: rgba(10, 18, 28, 0.8);
  border: 1px solid rgba(96, 160, 200, 0.18);
  border-radius: 9px;
  backdrop-filter: blur(8px);
  font-size: 11.5px;
}

.mem-legend-row { display: flex; align-items: center; gap: 7px; padding: 1.5px 0; color: #9fb6cc; }
.mem-legend-row i { width: 8px; height: 8px; border-radius: 50%; display: block; flex: 0 0 auto; }
.mem-muted { color: #6d87a0; font-size: 11.5px; }

/* ---------- 状态栏 ---------- */

.mem-statusbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  background: linear-gradient(180deg, rgba(7, 11, 18, 0), rgba(7, 11, 18, 0.9));
  color: #7590a8;
  font-size: 11.5px;
  pointer-events: none;
}

.mem-note { color: #5d7590; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 1280px) {
  .mem-filter { width: 184px; }
  .mem-searchbox input { width: 168px; }
  .mem-legend { max-width: 140px; }
}

@media (prefers-reduced-motion: reduce) {
  .mem-group button, .mem-chip { transition: none; }
}`;function ia(s=document){if(s.getElementById("mem-brain-styles"))return;let e=s.createElement("style");e.id="mem-brain-styles",e.textContent=Sl,s.head.appendChild(e)}var wl=0,sa=1,El=2;var Fc=1,Al=2,$e=3,yn=0,Ee=1,Qe=2;var gn=0,di=1,Bn=2,ra=3,oa=4,Tl=5,In=100,Cl=101,Rl=102,aa=103,ca=104,Pl=200,Ll=201,Il=202,Dl=203,jr=204,Qr=205,Ul=206,Nl=207,Fl=208,Ol=209,Bl=210,zl=211,kl=212,Vl=213,Hl=214,Gl=0,Wl=1,Xl=2,Us=3,ql=4,Yl=5,Zl=6,Jl=7,Oc=0,Kl=1,$l=2,_n=0,jl=1,Ql=2,th=3,eh=4,nh=5,ih=6;var Bc=300,mi=301,gi=302,to=303,eo=304,nr=306,no=1e3,ke=1001,io=1002,be=1003,la=1004;var xr=1005;var Ie=1006,sh=1007;var Vi=1008;var vn=1009,rh=1010,oh=1011,ko=1012,zc=1013,pn=1014,mn=1015,Hi=1016,kc=1017,Vc=1018,Nn=1020,ah=1021,Ve=1023,ch=1024,lh=1025,Fn=1026,_i=1027,hh=1028,Hc=1029,uh=1030,Gc=1031,Wc=1033,yr=33776,Mr=33777,br=33778,Sr=33779,ha=35840,ua=35841,da=35842,fa=35843,Xc=36196,pa=37492,ma=37496,ga=37808,_a=37809,va=37810,xa=37811,ya=37812,Ma=37813,ba=37814,Sa=37815,wa=37816,Ea=37817,Aa=37818,Ta=37819,Ca=37820,Ra=37821,wr=36492,Pa=36494,La=36495,dh=36283,Ia=36284,Da=36285,Ua=36286;var Ns=2300,Fs=2301,Er=2302,Na=2400,Fa=2401,Oa=2402;var qc=3e3,On=3001,fh=3200,ph=3201,mh=0,gh=1,De="",oe="srgb",nn="srgb-linear",Vo="display-p3",ir="display-p3-linear",Os="linear",Qt="srgb",Bs="rec709",zs="p3";var Hn=7680;var Ba=519,_h=512,vh=513,xh=514,Yc=515,yh=516,Mh=517,bh=518,Sh=519,so=35044,Ho=35048;var za="300 es",ro=1035,en=2e3,ks=2001,Mn=class{addEventListener(t,e){this._listeners===void 0&&(this._listeners={});let n=this._listeners;n[t]===void 0&&(n[t]=[]),n[t].indexOf(e)===-1&&n[t].push(e)}hasEventListener(t,e){if(this._listeners===void 0)return!1;let n=this._listeners;return n[t]!==void 0&&n[t].indexOf(e)!==-1}removeEventListener(t,e){if(this._listeners===void 0)return;let i=this._listeners[t];if(i!==void 0){let r=i.indexOf(e);r!==-1&&i.splice(r,1)}}dispatchEvent(t){if(this._listeners===void 0)return;let n=this._listeners[t.type];if(n!==void 0){t.target=this;let i=n.slice(0);for(let r=0,o=i.length;r<o;r++)i[r].call(this,t);t.target=null}}},ge=["00","01","02","03","04","05","06","07","08","09","0a","0b","0c","0d","0e","0f","10","11","12","13","14","15","16","17","18","19","1a","1b","1c","1d","1e","1f","20","21","22","23","24","25","26","27","28","29","2a","2b","2c","2d","2e","2f","30","31","32","33","34","35","36","37","38","39","3a","3b","3c","3d","3e","3f","40","41","42","43","44","45","46","47","48","49","4a","4b","4c","4d","4e","4f","50","51","52","53","54","55","56","57","58","59","5a","5b","5c","5d","5e","5f","60","61","62","63","64","65","66","67","68","69","6a","6b","6c","6d","6e","6f","70","71","72","73","74","75","76","77","78","79","7a","7b","7c","7d","7e","7f","80","81","82","83","84","85","86","87","88","89","8a","8b","8c","8d","8e","8f","90","91","92","93","94","95","96","97","98","99","9a","9b","9c","9d","9e","9f","a0","a1","a2","a3","a4","a5","a6","a7","a8","a9","aa","ab","ac","ad","ae","af","b0","b1","b2","b3","b4","b5","b6","b7","b8","b9","ba","bb","bc","bd","be","bf","c0","c1","c2","c3","c4","c5","c6","c7","c8","c9","ca","cb","cc","cd","ce","cf","d0","d1","d2","d3","d4","d5","d6","d7","d8","d9","da","db","dc","dd","de","df","e0","e1","e2","e3","e4","e5","e6","e7","e8","e9","ea","eb","ec","ed","ee","ef","f0","f1","f2","f3","f4","f5","f6","f7","f8","f9","fa","fb","fc","fd","fe","ff"];var Ar=Math.PI/180,oo=180/Math.PI;function xn(){let s=Math.random()*4294967295|0,t=Math.random()*4294967295|0,e=Math.random()*4294967295|0,n=Math.random()*4294967295|0;return(ge[s&255]+ge[s>>8&255]+ge[s>>16&255]+ge[s>>24&255]+"-"+ge[t&255]+ge[t>>8&255]+"-"+ge[t>>16&15|64]+ge[t>>24&255]+"-"+ge[e&63|128]+ge[e>>8&255]+"-"+ge[e>>16&255]+ge[e>>24&255]+ge[n&255]+ge[n>>8&255]+ge[n>>16&255]+ge[n>>24&255]).toLowerCase()}function we(s,t,e){return Math.max(t,Math.min(e,s))}function wh(s,t){return(s%t+t)%t}function Tr(s,t,e){return(1-e)*s+e*t}function ka(s){return(s&s-1)===0&&s!==0}function ao(s){return Math.pow(2,Math.floor(Math.log(s)/Math.LN2))}function tn(s,t){switch(t.constructor){case Float32Array:return s;case Uint32Array:return s/4294967295;case Uint16Array:return s/65535;case Uint8Array:return s/255;case Int32Array:return Math.max(s/2147483647,-1);case Int16Array:return Math.max(s/32767,-1);case Int8Array:return Math.max(s/127,-1);default:throw new Error("Invalid component type.")}}function Yt(s,t){switch(t.constructor){case Float32Array:return s;case Uint32Array:return Math.round(s*4294967295);case Uint16Array:return Math.round(s*65535);case Uint8Array:return Math.round(s*255);case Int32Array:return Math.round(s*2147483647);case Int16Array:return Math.round(s*32767);case Int8Array:return Math.round(s*127);default:throw new Error("Invalid component type.")}}var Lt=class s{constructor(t=0,e=0){s.prototype.isVector2=!0,this.x=t,this.y=e}get width(){return this.x}set width(t){this.x=t}get height(){return this.y}set height(t){this.y=t}set(t,e){return this.x=t,this.y=e,this}setScalar(t){return this.x=t,this.y=t,this}setX(t){return this.x=t,this}setY(t){return this.y=t,this}setComponent(t,e){switch(t){case 0:this.x=e;break;case 1:this.y=e;break;default:throw new Error("index is out of range: "+t)}return this}getComponent(t){switch(t){case 0:return this.x;case 1:return this.y;default:throw new Error("index is out of range: "+t)}}clone(){return new this.constructor(this.x,this.y)}copy(t){return this.x=t.x,this.y=t.y,this}add(t){return this.x+=t.x,this.y+=t.y,this}addScalar(t){return this.x+=t,this.y+=t,this}addVectors(t,e){return this.x=t.x+e.x,this.y=t.y+e.y,this}addScaledVector(t,e){return this.x+=t.x*e,this.y+=t.y*e,this}sub(t){return this.x-=t.x,this.y-=t.y,this}subScalar(t){return this.x-=t,this.y-=t,this}subVectors(t,e){return this.x=t.x-e.x,this.y=t.y-e.y,this}multiply(t){return this.x*=t.x,this.y*=t.y,this}multiplyScalar(t){return this.x*=t,this.y*=t,this}divide(t){return this.x/=t.x,this.y/=t.y,this}divideScalar(t){return this.multiplyScalar(1/t)}applyMatrix3(t){let e=this.x,n=this.y,i=t.elements;return this.x=i[0]*e+i[3]*n+i[6],this.y=i[1]*e+i[4]*n+i[7],this}min(t){return this.x=Math.min(this.x,t.x),this.y=Math.min(this.y,t.y),this}max(t){return this.x=Math.max(this.x,t.x),this.y=Math.max(this.y,t.y),this}clamp(t,e){return this.x=Math.max(t.x,Math.min(e.x,this.x)),this.y=Math.max(t.y,Math.min(e.y,this.y)),this}clampScalar(t,e){return this.x=Math.max(t,Math.min(e,this.x)),this.y=Math.max(t,Math.min(e,this.y)),this}clampLength(t,e){let n=this.length();return this.divideScalar(n||1).multiplyScalar(Math.max(t,Math.min(e,n)))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this}negate(){return this.x=-this.x,this.y=-this.y,this}dot(t){return this.x*t.x+this.y*t.y}cross(t){return this.x*t.y-this.y*t.x}lengthSq(){return this.x*this.x+this.y*this.y}length(){return Math.sqrt(this.x*this.x+this.y*this.y)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)}normalize(){return this.divideScalar(this.length()||1)}angle(){return Math.atan2(-this.y,-this.x)+Math.PI}angleTo(t){let e=Math.sqrt(this.lengthSq()*t.lengthSq());if(e===0)return Math.PI/2;let n=this.dot(t)/e;return Math.acos(we(n,-1,1))}distanceTo(t){return Math.sqrt(this.distanceToSquared(t))}distanceToSquared(t){let e=this.x-t.x,n=this.y-t.y;return e*e+n*n}manhattanDistanceTo(t){return Math.abs(this.x-t.x)+Math.abs(this.y-t.y)}setLength(t){return this.normalize().multiplyScalar(t)}lerp(t,e){return this.x+=(t.x-this.x)*e,this.y+=(t.y-this.y)*e,this}lerpVectors(t,e,n){return this.x=t.x+(e.x-t.x)*n,this.y=t.y+(e.y-t.y)*n,this}equals(t){return t.x===this.x&&t.y===this.y}fromArray(t,e=0){return this.x=t[e],this.y=t[e+1],this}toArray(t=[],e=0){return t[e]=this.x,t[e+1]=this.y,t}fromBufferAttribute(t,e){return this.x=t.getX(e),this.y=t.getY(e),this}rotateAround(t,e){let n=Math.cos(e),i=Math.sin(e),r=this.x-t.x,o=this.y-t.y;return this.x=r*n-o*i+t.x,this.y=r*i+o*n+t.y,this}random(){return this.x=Math.random(),this.y=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y}},Gt=class s{constructor(t,e,n,i,r,o,a,c,l){s.prototype.isMatrix3=!0,this.elements=[1,0,0,0,1,0,0,0,1],t!==void 0&&this.set(t,e,n,i,r,o,a,c,l)}set(t,e,n,i,r,o,a,c,l){let h=this.elements;return h[0]=t,h[1]=i,h[2]=a,h[3]=e,h[4]=r,h[5]=c,h[6]=n,h[7]=o,h[8]=l,this}identity(){return this.set(1,0,0,0,1,0,0,0,1),this}copy(t){let e=this.elements,n=t.elements;return e[0]=n[0],e[1]=n[1],e[2]=n[2],e[3]=n[3],e[4]=n[4],e[5]=n[5],e[6]=n[6],e[7]=n[7],e[8]=n[8],this}extractBasis(t,e,n){return t.setFromMatrix3Column(this,0),e.setFromMatrix3Column(this,1),n.setFromMatrix3Column(this,2),this}setFromMatrix4(t){let e=t.elements;return this.set(e[0],e[4],e[8],e[1],e[5],e[9],e[2],e[6],e[10]),this}multiply(t){return this.multiplyMatrices(this,t)}premultiply(t){return this.multiplyMatrices(t,this)}multiplyMatrices(t,e){let n=t.elements,i=e.elements,r=this.elements,o=n[0],a=n[3],c=n[6],l=n[1],h=n[4],u=n[7],d=n[2],m=n[5],v=n[8],x=i[0],p=i[3],f=i[6],g=i[1],_=i[4],b=i[7],S=i[2],T=i[5],C=i[8];return r[0]=o*x+a*g+c*S,r[3]=o*p+a*_+c*T,r[6]=o*f+a*b+c*C,r[1]=l*x+h*g+u*S,r[4]=l*p+h*_+u*T,r[7]=l*f+h*b+u*C,r[2]=d*x+m*g+v*S,r[5]=d*p+m*_+v*T,r[8]=d*f+m*b+v*C,this}multiplyScalar(t){let e=this.elements;return e[0]*=t,e[3]*=t,e[6]*=t,e[1]*=t,e[4]*=t,e[7]*=t,e[2]*=t,e[5]*=t,e[8]*=t,this}determinant(){let t=this.elements,e=t[0],n=t[1],i=t[2],r=t[3],o=t[4],a=t[5],c=t[6],l=t[7],h=t[8];return e*o*h-e*a*l-n*r*h+n*a*c+i*r*l-i*o*c}invert(){let t=this.elements,e=t[0],n=t[1],i=t[2],r=t[3],o=t[4],a=t[5],c=t[6],l=t[7],h=t[8],u=h*o-a*l,d=a*c-h*r,m=l*r-o*c,v=e*u+n*d+i*m;if(v===0)return this.set(0,0,0,0,0,0,0,0,0);let x=1/v;return t[0]=u*x,t[1]=(i*l-h*n)*x,t[2]=(a*n-i*o)*x,t[3]=d*x,t[4]=(h*e-i*c)*x,t[5]=(i*r-a*e)*x,t[6]=m*x,t[7]=(n*c-l*e)*x,t[8]=(o*e-n*r)*x,this}transpose(){let t,e=this.elements;return t=e[1],e[1]=e[3],e[3]=t,t=e[2],e[2]=e[6],e[6]=t,t=e[5],e[5]=e[7],e[7]=t,this}getNormalMatrix(t){return this.setFromMatrix4(t).invert().transpose()}transposeIntoArray(t){let e=this.elements;return t[0]=e[0],t[1]=e[3],t[2]=e[6],t[3]=e[1],t[4]=e[4],t[5]=e[7],t[6]=e[2],t[7]=e[5],t[8]=e[8],this}setUvTransform(t,e,n,i,r,o,a){let c=Math.cos(r),l=Math.sin(r);return this.set(n*c,n*l,-n*(c*o+l*a)+o+t,-i*l,i*c,-i*(-l*o+c*a)+a+e,0,0,1),this}scale(t,e){return this.premultiply(Cr.makeScale(t,e)),this}rotate(t){return this.premultiply(Cr.makeRotation(-t)),this}translate(t,e){return this.premultiply(Cr.makeTranslation(t,e)),this}makeTranslation(t,e){return t.isVector2?this.set(1,0,t.x,0,1,t.y,0,0,1):this.set(1,0,t,0,1,e,0,0,1),this}makeRotation(t){let e=Math.cos(t),n=Math.sin(t);return this.set(e,-n,0,n,e,0,0,0,1),this}makeScale(t,e){return this.set(t,0,0,0,e,0,0,0,1),this}equals(t){let e=this.elements,n=t.elements;for(let i=0;i<9;i++)if(e[i]!==n[i])return!1;return!0}fromArray(t,e=0){for(let n=0;n<9;n++)this.elements[n]=t[n+e];return this}toArray(t=[],e=0){let n=this.elements;return t[e]=n[0],t[e+1]=n[1],t[e+2]=n[2],t[e+3]=n[3],t[e+4]=n[4],t[e+5]=n[5],t[e+6]=n[6],t[e+7]=n[7],t[e+8]=n[8],t}clone(){return new this.constructor().fromArray(this.elements)}},Cr=new Gt;function Zc(s){for(let t=s.length-1;t>=0;--t)if(s[t]>=65535)return!0;return!1}function Vs(s){return document.createElementNS("http://www.w3.org/1999/xhtml",s)}function Eh(){let s=Vs("canvas");return s.style.display="block",s}var Va={};function zi(s){s in Va||(Va[s]=!0,console.warn(s))}var Ha=new Gt().set(.8224621,.177538,0,.0331941,.9668058,0,.0170827,.0723974,.9105199),Ga=new Gt().set(1.2249401,-.2249404,0,-.0420569,1.0420571,0,-.0196376,-.0786361,1.0982735),ss={[nn]:{transfer:Os,primaries:Bs,toReference:s=>s,fromReference:s=>s},[oe]:{transfer:Qt,primaries:Bs,toReference:s=>s.convertSRGBToLinear(),fromReference:s=>s.convertLinearToSRGB()},[ir]:{transfer:Os,primaries:zs,toReference:s=>s.applyMatrix3(Ga),fromReference:s=>s.applyMatrix3(Ha)},[Vo]:{transfer:Qt,primaries:zs,toReference:s=>s.convertSRGBToLinear().applyMatrix3(Ga),fromReference:s=>s.applyMatrix3(Ha).convertLinearToSRGB()}},Ah=new Set([nn,ir]),qt={enabled:!0,_workingColorSpace:nn,get workingColorSpace(){return this._workingColorSpace},set workingColorSpace(s){if(!Ah.has(s))throw new Error(`Unsupported working color space, "${s}".`);this._workingColorSpace=s},convert:function(s,t,e){if(this.enabled===!1||t===e||!t||!e)return s;let n=ss[t].toReference,i=ss[e].fromReference;return i(n(s))},fromWorkingColorSpace:function(s,t){return this.convert(s,this._workingColorSpace,t)},toWorkingColorSpace:function(s,t){return this.convert(s,t,this._workingColorSpace)},getPrimaries:function(s){return ss[s].primaries},getTransfer:function(s){return s===De?Os:ss[s].transfer}};function fi(s){return s<.04045?s*.0773993808:Math.pow(s*.9478672986+.0521327014,2.4)}function Rr(s){return s<.0031308?s*12.92:1.055*Math.pow(s,.41666)-.055}var Gn,Hs=class{static getDataURL(t){if(/^data:/i.test(t.src)||typeof HTMLCanvasElement>"u")return t.src;let e;if(t instanceof HTMLCanvasElement)e=t;else{Gn===void 0&&(Gn=Vs("canvas")),Gn.width=t.width,Gn.height=t.height;let n=Gn.getContext("2d");t instanceof ImageData?n.putImageData(t,0,0):n.drawImage(t,0,0,t.width,t.height),e=Gn}return e.width>2048||e.height>2048?(console.warn("THREE.ImageUtils.getDataURL: Image converted to jpg for performance reasons",t),e.toDataURL("image/jpeg",.6)):e.toDataURL("image/png")}static sRGBToLinear(t){if(typeof HTMLImageElement<"u"&&t instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&t instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&t instanceof ImageBitmap){let e=Vs("canvas");e.width=t.width,e.height=t.height;let n=e.getContext("2d");n.drawImage(t,0,0,t.width,t.height);let i=n.getImageData(0,0,t.width,t.height),r=i.data;for(let o=0;o<r.length;o++)r[o]=fi(r[o]/255)*255;return n.putImageData(i,0,0),e}else if(t.data){let e=t.data.slice(0);for(let n=0;n<e.length;n++)e instanceof Uint8Array||e instanceof Uint8ClampedArray?e[n]=Math.floor(fi(e[n]/255)*255):e[n]=fi(e[n]);return{data:e,width:t.width,height:t.height}}else return console.warn("THREE.ImageUtils.sRGBToLinear(): Unsupported image type. No color space conversion applied."),t}},Th=0,Gs=class{constructor(t=null){this.isSource=!0,Object.defineProperty(this,"id",{value:Th++}),this.uuid=xn(),this.data=t,this.version=0}set needsUpdate(t){t===!0&&this.version++}toJSON(t){let e=t===void 0||typeof t=="string";if(!e&&t.images[this.uuid]!==void 0)return t.images[this.uuid];let n={uuid:this.uuid,url:""},i=this.data;if(i!==null){let r;if(Array.isArray(i)){r=[];for(let o=0,a=i.length;o<a;o++)i[o].isDataTexture?r.push(Pr(i[o].image)):r.push(Pr(i[o]))}else r=Pr(i);n.url=r}return e||(t.images[this.uuid]=n),n}};function Pr(s){return typeof HTMLImageElement<"u"&&s instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&s instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&s instanceof ImageBitmap?Hs.getDataURL(s):s.data?{data:Array.from(s.data),width:s.width,height:s.height,type:s.data.constructor.name}:(console.warn("THREE.Texture: Unable to serialize Texture."),{})}var Ch=0,Ne=class s extends Mn{constructor(t=s.DEFAULT_IMAGE,e=s.DEFAULT_MAPPING,n=ke,i=ke,r=Ie,o=Vi,a=Ve,c=vn,l=s.DEFAULT_ANISOTROPY,h=De){super(),this.isTexture=!0,Object.defineProperty(this,"id",{value:Ch++}),this.uuid=xn(),this.name="",this.source=new Gs(t),this.mipmaps=[],this.mapping=e,this.channel=0,this.wrapS=n,this.wrapT=i,this.magFilter=r,this.minFilter=o,this.anisotropy=l,this.format=a,this.internalFormat=null,this.type=c,this.offset=new Lt(0,0),this.repeat=new Lt(1,1),this.center=new Lt(0,0),this.rotation=0,this.matrixAutoUpdate=!0,this.matrix=new Gt,this.generateMipmaps=!0,this.premultiplyAlpha=!1,this.flipY=!0,this.unpackAlignment=4,typeof h=="string"?this.colorSpace=h:(zi("THREE.Texture: Property .encoding has been replaced by .colorSpace."),this.colorSpace=h===On?oe:De),this.userData={},this.version=0,this.onUpdate=null,this.isRenderTargetTexture=!1,this.needsPMREMUpdate=!1}get image(){return this.source.data}set image(t=null){this.source.data=t}updateMatrix(){this.matrix.setUvTransform(this.offset.x,this.offset.y,this.repeat.x,this.repeat.y,this.rotation,this.center.x,this.center.y)}clone(){return new this.constructor().copy(this)}copy(t){return this.name=t.name,this.source=t.source,this.mipmaps=t.mipmaps.slice(0),this.mapping=t.mapping,this.channel=t.channel,this.wrapS=t.wrapS,this.wrapT=t.wrapT,this.magFilter=t.magFilter,this.minFilter=t.minFilter,this.anisotropy=t.anisotropy,this.format=t.format,this.internalFormat=t.internalFormat,this.type=t.type,this.offset.copy(t.offset),this.repeat.copy(t.repeat),this.center.copy(t.center),this.rotation=t.rotation,this.matrixAutoUpdate=t.matrixAutoUpdate,this.matrix.copy(t.matrix),this.generateMipmaps=t.generateMipmaps,this.premultiplyAlpha=t.premultiplyAlpha,this.flipY=t.flipY,this.unpackAlignment=t.unpackAlignment,this.colorSpace=t.colorSpace,this.userData=JSON.parse(JSON.stringify(t.userData)),this.needsUpdate=!0,this}toJSON(t){let e=t===void 0||typeof t=="string";if(!e&&t.textures[this.uuid]!==void 0)return t.textures[this.uuid];let n={metadata:{version:4.6,type:"Texture",generator:"Texture.toJSON"},uuid:this.uuid,name:this.name,image:this.source.toJSON(t).uuid,mapping:this.mapping,channel:this.channel,repeat:[this.repeat.x,this.repeat.y],offset:[this.offset.x,this.offset.y],center:[this.center.x,this.center.y],rotation:this.rotation,wrap:[this.wrapS,this.wrapT],format:this.format,internalFormat:this.internalFormat,type:this.type,colorSpace:this.colorSpace,minFilter:this.minFilter,magFilter:this.magFilter,anisotropy:this.anisotropy,flipY:this.flipY,generateMipmaps:this.generateMipmaps,premultiplyAlpha:this.premultiplyAlpha,unpackAlignment:this.unpackAlignment};return Object.keys(this.userData).length>0&&(n.userData=this.userData),e||(t.textures[this.uuid]=n),n}dispose(){this.dispatchEvent({type:"dispose"})}transformUv(t){if(this.mapping!==Bc)return t;if(t.applyMatrix3(this.matrix),t.x<0||t.x>1)switch(this.wrapS){case no:t.x=t.x-Math.floor(t.x);break;case ke:t.x=t.x<0?0:1;break;case io:Math.abs(Math.floor(t.x)%2)===1?t.x=Math.ceil(t.x)-t.x:t.x=t.x-Math.floor(t.x);break}if(t.y<0||t.y>1)switch(this.wrapT){case no:t.y=t.y-Math.floor(t.y);break;case ke:t.y=t.y<0?0:1;break;case io:Math.abs(Math.floor(t.y)%2)===1?t.y=Math.ceil(t.y)-t.y:t.y=t.y-Math.floor(t.y);break}return this.flipY&&(t.y=1-t.y),t}set needsUpdate(t){t===!0&&(this.version++,this.source.needsUpdate=!0)}get encoding(){return zi("THREE.Texture: Property .encoding has been replaced by .colorSpace."),this.colorSpace===oe?On:qc}set encoding(t){zi("THREE.Texture: Property .encoding has been replaced by .colorSpace."),this.colorSpace=t===On?oe:De}};Ne.DEFAULT_IMAGE=null;Ne.DEFAULT_MAPPING=Bc;Ne.DEFAULT_ANISOTROPY=1;var de=class s{constructor(t=0,e=0,n=0,i=1){s.prototype.isVector4=!0,this.x=t,this.y=e,this.z=n,this.w=i}get width(){return this.z}set width(t){this.z=t}get height(){return this.w}set height(t){this.w=t}set(t,e,n,i){return this.x=t,this.y=e,this.z=n,this.w=i,this}setScalar(t){return this.x=t,this.y=t,this.z=t,this.w=t,this}setX(t){return this.x=t,this}setY(t){return this.y=t,this}setZ(t){return this.z=t,this}setW(t){return this.w=t,this}setComponent(t,e){switch(t){case 0:this.x=e;break;case 1:this.y=e;break;case 2:this.z=e;break;case 3:this.w=e;break;default:throw new Error("index is out of range: "+t)}return this}getComponent(t){switch(t){case 0:return this.x;case 1:return this.y;case 2:return this.z;case 3:return this.w;default:throw new Error("index is out of range: "+t)}}clone(){return new this.constructor(this.x,this.y,this.z,this.w)}copy(t){return this.x=t.x,this.y=t.y,this.z=t.z,this.w=t.w!==void 0?t.w:1,this}add(t){return this.x+=t.x,this.y+=t.y,this.z+=t.z,this.w+=t.w,this}addScalar(t){return this.x+=t,this.y+=t,this.z+=t,this.w+=t,this}addVectors(t,e){return this.x=t.x+e.x,this.y=t.y+e.y,this.z=t.z+e.z,this.w=t.w+e.w,this}addScaledVector(t,e){return this.x+=t.x*e,this.y+=t.y*e,this.z+=t.z*e,this.w+=t.w*e,this}sub(t){return this.x-=t.x,this.y-=t.y,this.z-=t.z,this.w-=t.w,this}subScalar(t){return this.x-=t,this.y-=t,this.z-=t,this.w-=t,this}subVectors(t,e){return this.x=t.x-e.x,this.y=t.y-e.y,this.z=t.z-e.z,this.w=t.w-e.w,this}multiply(t){return this.x*=t.x,this.y*=t.y,this.z*=t.z,this.w*=t.w,this}multiplyScalar(t){return this.x*=t,this.y*=t,this.z*=t,this.w*=t,this}applyMatrix4(t){let e=this.x,n=this.y,i=this.z,r=this.w,o=t.elements;return this.x=o[0]*e+o[4]*n+o[8]*i+o[12]*r,this.y=o[1]*e+o[5]*n+o[9]*i+o[13]*r,this.z=o[2]*e+o[6]*n+o[10]*i+o[14]*r,this.w=o[3]*e+o[7]*n+o[11]*i+o[15]*r,this}divideScalar(t){return this.multiplyScalar(1/t)}setAxisAngleFromQuaternion(t){this.w=2*Math.acos(t.w);let e=Math.sqrt(1-t.w*t.w);return e<1e-4?(this.x=1,this.y=0,this.z=0):(this.x=t.x/e,this.y=t.y/e,this.z=t.z/e),this}setAxisAngleFromRotationMatrix(t){let e,n,i,r,c=t.elements,l=c[0],h=c[4],u=c[8],d=c[1],m=c[5],v=c[9],x=c[2],p=c[6],f=c[10];if(Math.abs(h-d)<.01&&Math.abs(u-x)<.01&&Math.abs(v-p)<.01){if(Math.abs(h+d)<.1&&Math.abs(u+x)<.1&&Math.abs(v+p)<.1&&Math.abs(l+m+f-3)<.1)return this.set(1,0,0,0),this;e=Math.PI;let _=(l+1)/2,b=(m+1)/2,S=(f+1)/2,T=(h+d)/4,C=(u+x)/4,P=(v+p)/4;return _>b&&_>S?_<.01?(n=0,i=.707106781,r=.707106781):(n=Math.sqrt(_),i=T/n,r=C/n):b>S?b<.01?(n=.707106781,i=0,r=.707106781):(i=Math.sqrt(b),n=T/i,r=P/i):S<.01?(n=.707106781,i=.707106781,r=0):(r=Math.sqrt(S),n=C/r,i=P/r),this.set(n,i,r,e),this}let g=Math.sqrt((p-v)*(p-v)+(u-x)*(u-x)+(d-h)*(d-h));return Math.abs(g)<.001&&(g=1),this.x=(p-v)/g,this.y=(u-x)/g,this.z=(d-h)/g,this.w=Math.acos((l+m+f-1)/2),this}min(t){return this.x=Math.min(this.x,t.x),this.y=Math.min(this.y,t.y),this.z=Math.min(this.z,t.z),this.w=Math.min(this.w,t.w),this}max(t){return this.x=Math.max(this.x,t.x),this.y=Math.max(this.y,t.y),this.z=Math.max(this.z,t.z),this.w=Math.max(this.w,t.w),this}clamp(t,e){return this.x=Math.max(t.x,Math.min(e.x,this.x)),this.y=Math.max(t.y,Math.min(e.y,this.y)),this.z=Math.max(t.z,Math.min(e.z,this.z)),this.w=Math.max(t.w,Math.min(e.w,this.w)),this}clampScalar(t,e){return this.x=Math.max(t,Math.min(e,this.x)),this.y=Math.max(t,Math.min(e,this.y)),this.z=Math.max(t,Math.min(e,this.z)),this.w=Math.max(t,Math.min(e,this.w)),this}clampLength(t,e){let n=this.length();return this.divideScalar(n||1).multiplyScalar(Math.max(t,Math.min(e,n)))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this.w=Math.floor(this.w),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this.w=Math.ceil(this.w),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this.w=Math.round(this.w),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this.w=Math.trunc(this.w),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this.w=-this.w,this}dot(t){return this.x*t.x+this.y*t.y+this.z*t.z+this.w*t.w}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)+Math.abs(this.w)}normalize(){return this.divideScalar(this.length()||1)}setLength(t){return this.normalize().multiplyScalar(t)}lerp(t,e){return this.x+=(t.x-this.x)*e,this.y+=(t.y-this.y)*e,this.z+=(t.z-this.z)*e,this.w+=(t.w-this.w)*e,this}lerpVectors(t,e,n){return this.x=t.x+(e.x-t.x)*n,this.y=t.y+(e.y-t.y)*n,this.z=t.z+(e.z-t.z)*n,this.w=t.w+(e.w-t.w)*n,this}equals(t){return t.x===this.x&&t.y===this.y&&t.z===this.z&&t.w===this.w}fromArray(t,e=0){return this.x=t[e],this.y=t[e+1],this.z=t[e+2],this.w=t[e+3],this}toArray(t=[],e=0){return t[e]=this.x,t[e+1]=this.y,t[e+2]=this.z,t[e+3]=this.w,t}fromBufferAttribute(t,e){return this.x=t.getX(e),this.y=t.getY(e),this.z=t.getZ(e),this.w=t.getW(e),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this.w=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z,yield this.w}},co=class extends Mn{constructor(t=1,e=1,n={}){super(),this.isRenderTarget=!0,this.width=t,this.height=e,this.depth=1,this.scissor=new de(0,0,t,e),this.scissorTest=!1,this.viewport=new de(0,0,t,e);let i={width:t,height:e,depth:1};n.encoding!==void 0&&(zi("THREE.WebGLRenderTarget: option.encoding has been replaced by option.colorSpace."),n.colorSpace=n.encoding===On?oe:De),n=Object.assign({generateMipmaps:!1,internalFormat:null,minFilter:Ie,depthBuffer:!0,stencilBuffer:!1,depthTexture:null,samples:0},n),this.texture=new Ne(i,n.mapping,n.wrapS,n.wrapT,n.magFilter,n.minFilter,n.format,n.type,n.anisotropy,n.colorSpace),this.texture.isRenderTargetTexture=!0,this.texture.flipY=!1,this.texture.generateMipmaps=n.generateMipmaps,this.texture.internalFormat=n.internalFormat,this.depthBuffer=n.depthBuffer,this.stencilBuffer=n.stencilBuffer,this.depthTexture=n.depthTexture,this.samples=n.samples}setSize(t,e,n=1){(this.width!==t||this.height!==e||this.depth!==n)&&(this.width=t,this.height=e,this.depth=n,this.texture.image.width=t,this.texture.image.height=e,this.texture.image.depth=n,this.dispose()),this.viewport.set(0,0,t,e),this.scissor.set(0,0,t,e)}clone(){return new this.constructor().copy(this)}copy(t){this.width=t.width,this.height=t.height,this.depth=t.depth,this.scissor.copy(t.scissor),this.scissorTest=t.scissorTest,this.viewport.copy(t.viewport),this.texture=t.texture.clone(),this.texture.isRenderTargetTexture=!0;let e=Object.assign({},t.texture.image);return this.texture.source=new Gs(e),this.depthBuffer=t.depthBuffer,this.stencilBuffer=t.stencilBuffer,t.depthTexture!==null&&(this.depthTexture=t.depthTexture.clone()),this.samples=t.samples,this}dispose(){this.dispatchEvent({type:"dispose"})}},sn=class extends co{constructor(t=1,e=1,n={}){super(t,e,n),this.isWebGLRenderTarget=!0}},Ws=class extends Ne{constructor(t=null,e=1,n=1,i=1){super(null),this.isDataArrayTexture=!0,this.image={data:t,width:e,height:n,depth:i},this.magFilter=be,this.minFilter=be,this.wrapR=ke,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}};var lo=class extends Ne{constructor(t=null,e=1,n=1,i=1){super(null),this.isData3DTexture=!0,this.image={data:t,width:e,height:n,depth:i},this.magFilter=be,this.minFilter=be,this.wrapR=ke,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}};var bn=class{constructor(t=0,e=0,n=0,i=1){this.isQuaternion=!0,this._x=t,this._y=e,this._z=n,this._w=i}static slerpFlat(t,e,n,i,r,o,a){let c=n[i+0],l=n[i+1],h=n[i+2],u=n[i+3],d=r[o+0],m=r[o+1],v=r[o+2],x=r[o+3];if(a===0){t[e+0]=c,t[e+1]=l,t[e+2]=h,t[e+3]=u;return}if(a===1){t[e+0]=d,t[e+1]=m,t[e+2]=v,t[e+3]=x;return}if(u!==x||c!==d||l!==m||h!==v){let p=1-a,f=c*d+l*m+h*v+u*x,g=f>=0?1:-1,_=1-f*f;if(_>Number.EPSILON){let S=Math.sqrt(_),T=Math.atan2(S,f*g);p=Math.sin(p*T)/S,a=Math.sin(a*T)/S}let b=a*g;if(c=c*p+d*b,l=l*p+m*b,h=h*p+v*b,u=u*p+x*b,p===1-a){let S=1/Math.sqrt(c*c+l*l+h*h+u*u);c*=S,l*=S,h*=S,u*=S}}t[e]=c,t[e+1]=l,t[e+2]=h,t[e+3]=u}static multiplyQuaternionsFlat(t,e,n,i,r,o){let a=n[i],c=n[i+1],l=n[i+2],h=n[i+3],u=r[o],d=r[o+1],m=r[o+2],v=r[o+3];return t[e]=a*v+h*u+c*m-l*d,t[e+1]=c*v+h*d+l*u-a*m,t[e+2]=l*v+h*m+a*d-c*u,t[e+3]=h*v-a*u-c*d-l*m,t}get x(){return this._x}set x(t){this._x=t,this._onChangeCallback()}get y(){return this._y}set y(t){this._y=t,this._onChangeCallback()}get z(){return this._z}set z(t){this._z=t,this._onChangeCallback()}get w(){return this._w}set w(t){this._w=t,this._onChangeCallback()}set(t,e,n,i){return this._x=t,this._y=e,this._z=n,this._w=i,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._w)}copy(t){return this._x=t.x,this._y=t.y,this._z=t.z,this._w=t.w,this._onChangeCallback(),this}setFromEuler(t,e=!0){let n=t._x,i=t._y,r=t._z,o=t._order,a=Math.cos,c=Math.sin,l=a(n/2),h=a(i/2),u=a(r/2),d=c(n/2),m=c(i/2),v=c(r/2);switch(o){case"XYZ":this._x=d*h*u+l*m*v,this._y=l*m*u-d*h*v,this._z=l*h*v+d*m*u,this._w=l*h*u-d*m*v;break;case"YXZ":this._x=d*h*u+l*m*v,this._y=l*m*u-d*h*v,this._z=l*h*v-d*m*u,this._w=l*h*u+d*m*v;break;case"ZXY":this._x=d*h*u-l*m*v,this._y=l*m*u+d*h*v,this._z=l*h*v+d*m*u,this._w=l*h*u-d*m*v;break;case"ZYX":this._x=d*h*u-l*m*v,this._y=l*m*u+d*h*v,this._z=l*h*v-d*m*u,this._w=l*h*u+d*m*v;break;case"YZX":this._x=d*h*u+l*m*v,this._y=l*m*u+d*h*v,this._z=l*h*v-d*m*u,this._w=l*h*u-d*m*v;break;case"XZY":this._x=d*h*u-l*m*v,this._y=l*m*u-d*h*v,this._z=l*h*v+d*m*u,this._w=l*h*u+d*m*v;break;default:console.warn("THREE.Quaternion: .setFromEuler() encountered an unknown order: "+o)}return e===!0&&this._onChangeCallback(),this}setFromAxisAngle(t,e){let n=e/2,i=Math.sin(n);return this._x=t.x*i,this._y=t.y*i,this._z=t.z*i,this._w=Math.cos(n),this._onChangeCallback(),this}setFromRotationMatrix(t){let e=t.elements,n=e[0],i=e[4],r=e[8],o=e[1],a=e[5],c=e[9],l=e[2],h=e[6],u=e[10],d=n+a+u;if(d>0){let m=.5/Math.sqrt(d+1);this._w=.25/m,this._x=(h-c)*m,this._y=(r-l)*m,this._z=(o-i)*m}else if(n>a&&n>u){let m=2*Math.sqrt(1+n-a-u);this._w=(h-c)/m,this._x=.25*m,this._y=(i+o)/m,this._z=(r+l)/m}else if(a>u){let m=2*Math.sqrt(1+a-n-u);this._w=(r-l)/m,this._x=(i+o)/m,this._y=.25*m,this._z=(c+h)/m}else{let m=2*Math.sqrt(1+u-n-a);this._w=(o-i)/m,this._x=(r+l)/m,this._y=(c+h)/m,this._z=.25*m}return this._onChangeCallback(),this}setFromUnitVectors(t,e){let n=t.dot(e)+1;return n<Number.EPSILON?(n=0,Math.abs(t.x)>Math.abs(t.z)?(this._x=-t.y,this._y=t.x,this._z=0,this._w=n):(this._x=0,this._y=-t.z,this._z=t.y,this._w=n)):(this._x=t.y*e.z-t.z*e.y,this._y=t.z*e.x-t.x*e.z,this._z=t.x*e.y-t.y*e.x,this._w=n),this.normalize()}angleTo(t){return 2*Math.acos(Math.abs(we(this.dot(t),-1,1)))}rotateTowards(t,e){let n=this.angleTo(t);if(n===0)return this;let i=Math.min(1,e/n);return this.slerp(t,i),this}identity(){return this.set(0,0,0,1)}invert(){return this.conjugate()}conjugate(){return this._x*=-1,this._y*=-1,this._z*=-1,this._onChangeCallback(),this}dot(t){return this._x*t._x+this._y*t._y+this._z*t._z+this._w*t._w}lengthSq(){return this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w}length(){return Math.sqrt(this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w)}normalize(){let t=this.length();return t===0?(this._x=0,this._y=0,this._z=0,this._w=1):(t=1/t,this._x=this._x*t,this._y=this._y*t,this._z=this._z*t,this._w=this._w*t),this._onChangeCallback(),this}multiply(t){return this.multiplyQuaternions(this,t)}premultiply(t){return this.multiplyQuaternions(t,this)}multiplyQuaternions(t,e){let n=t._x,i=t._y,r=t._z,o=t._w,a=e._x,c=e._y,l=e._z,h=e._w;return this._x=n*h+o*a+i*l-r*c,this._y=i*h+o*c+r*a-n*l,this._z=r*h+o*l+n*c-i*a,this._w=o*h-n*a-i*c-r*l,this._onChangeCallback(),this}slerp(t,e){if(e===0)return this;if(e===1)return this.copy(t);let n=this._x,i=this._y,r=this._z,o=this._w,a=o*t._w+n*t._x+i*t._y+r*t._z;if(a<0?(this._w=-t._w,this._x=-t._x,this._y=-t._y,this._z=-t._z,a=-a):this.copy(t),a>=1)return this._w=o,this._x=n,this._y=i,this._z=r,this;let c=1-a*a;if(c<=Number.EPSILON){let m=1-e;return this._w=m*o+e*this._w,this._x=m*n+e*this._x,this._y=m*i+e*this._y,this._z=m*r+e*this._z,this.normalize(),this}let l=Math.sqrt(c),h=Math.atan2(l,a),u=Math.sin((1-e)*h)/l,d=Math.sin(e*h)/l;return this._w=o*u+this._w*d,this._x=n*u+this._x*d,this._y=i*u+this._y*d,this._z=r*u+this._z*d,this._onChangeCallback(),this}slerpQuaternions(t,e,n){return this.copy(t).slerp(e,n)}random(){let t=Math.random(),e=Math.sqrt(1-t),n=Math.sqrt(t),i=2*Math.PI*Math.random(),r=2*Math.PI*Math.random();return this.set(e*Math.cos(i),n*Math.sin(r),n*Math.cos(r),e*Math.sin(i))}equals(t){return t._x===this._x&&t._y===this._y&&t._z===this._z&&t._w===this._w}fromArray(t,e=0){return this._x=t[e],this._y=t[e+1],this._z=t[e+2],this._w=t[e+3],this._onChangeCallback(),this}toArray(t=[],e=0){return t[e]=this._x,t[e+1]=this._y,t[e+2]=this._z,t[e+3]=this._w,t}fromBufferAttribute(t,e){return this._x=t.getX(e),this._y=t.getY(e),this._z=t.getZ(e),this._w=t.getW(e),this._onChangeCallback(),this}toJSON(){return this.toArray()}_onChange(t){return this._onChangeCallback=t,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._w}},L=class s{constructor(t=0,e=0,n=0){s.prototype.isVector3=!0,this.x=t,this.y=e,this.z=n}set(t,e,n){return n===void 0&&(n=this.z),this.x=t,this.y=e,this.z=n,this}setScalar(t){return this.x=t,this.y=t,this.z=t,this}setX(t){return this.x=t,this}setY(t){return this.y=t,this}setZ(t){return this.z=t,this}setComponent(t,e){switch(t){case 0:this.x=e;break;case 1:this.y=e;break;case 2:this.z=e;break;default:throw new Error("index is out of range: "+t)}return this}getComponent(t){switch(t){case 0:return this.x;case 1:return this.y;case 2:return this.z;default:throw new Error("index is out of range: "+t)}}clone(){return new this.constructor(this.x,this.y,this.z)}copy(t){return this.x=t.x,this.y=t.y,this.z=t.z,this}add(t){return this.x+=t.x,this.y+=t.y,this.z+=t.z,this}addScalar(t){return this.x+=t,this.y+=t,this.z+=t,this}addVectors(t,e){return this.x=t.x+e.x,this.y=t.y+e.y,this.z=t.z+e.z,this}addScaledVector(t,e){return this.x+=t.x*e,this.y+=t.y*e,this.z+=t.z*e,this}sub(t){return this.x-=t.x,this.y-=t.y,this.z-=t.z,this}subScalar(t){return this.x-=t,this.y-=t,this.z-=t,this}subVectors(t,e){return this.x=t.x-e.x,this.y=t.y-e.y,this.z=t.z-e.z,this}multiply(t){return this.x*=t.x,this.y*=t.y,this.z*=t.z,this}multiplyScalar(t){return this.x*=t,this.y*=t,this.z*=t,this}multiplyVectors(t,e){return this.x=t.x*e.x,this.y=t.y*e.y,this.z=t.z*e.z,this}applyEuler(t){return this.applyQuaternion(Wa.setFromEuler(t))}applyAxisAngle(t,e){return this.applyQuaternion(Wa.setFromAxisAngle(t,e))}applyMatrix3(t){let e=this.x,n=this.y,i=this.z,r=t.elements;return this.x=r[0]*e+r[3]*n+r[6]*i,this.y=r[1]*e+r[4]*n+r[7]*i,this.z=r[2]*e+r[5]*n+r[8]*i,this}applyNormalMatrix(t){return this.applyMatrix3(t).normalize()}applyMatrix4(t){let e=this.x,n=this.y,i=this.z,r=t.elements,o=1/(r[3]*e+r[7]*n+r[11]*i+r[15]);return this.x=(r[0]*e+r[4]*n+r[8]*i+r[12])*o,this.y=(r[1]*e+r[5]*n+r[9]*i+r[13])*o,this.z=(r[2]*e+r[6]*n+r[10]*i+r[14])*o,this}applyQuaternion(t){let e=this.x,n=this.y,i=this.z,r=t.x,o=t.y,a=t.z,c=t.w,l=2*(o*i-a*n),h=2*(a*e-r*i),u=2*(r*n-o*e);return this.x=e+c*l+o*u-a*h,this.y=n+c*h+a*l-r*u,this.z=i+c*u+r*h-o*l,this}project(t){return this.applyMatrix4(t.matrixWorldInverse).applyMatrix4(t.projectionMatrix)}unproject(t){return this.applyMatrix4(t.projectionMatrixInverse).applyMatrix4(t.matrixWorld)}transformDirection(t){let e=this.x,n=this.y,i=this.z,r=t.elements;return this.x=r[0]*e+r[4]*n+r[8]*i,this.y=r[1]*e+r[5]*n+r[9]*i,this.z=r[2]*e+r[6]*n+r[10]*i,this.normalize()}divide(t){return this.x/=t.x,this.y/=t.y,this.z/=t.z,this}divideScalar(t){return this.multiplyScalar(1/t)}min(t){return this.x=Math.min(this.x,t.x),this.y=Math.min(this.y,t.y),this.z=Math.min(this.z,t.z),this}max(t){return this.x=Math.max(this.x,t.x),this.y=Math.max(this.y,t.y),this.z=Math.max(this.z,t.z),this}clamp(t,e){return this.x=Math.max(t.x,Math.min(e.x,this.x)),this.y=Math.max(t.y,Math.min(e.y,this.y)),this.z=Math.max(t.z,Math.min(e.z,this.z)),this}clampScalar(t,e){return this.x=Math.max(t,Math.min(e,this.x)),this.y=Math.max(t,Math.min(e,this.y)),this.z=Math.max(t,Math.min(e,this.z)),this}clampLength(t,e){let n=this.length();return this.divideScalar(n||1).multiplyScalar(Math.max(t,Math.min(e,n)))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this}dot(t){return this.x*t.x+this.y*t.y+this.z*t.z}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)}normalize(){return this.divideScalar(this.length()||1)}setLength(t){return this.normalize().multiplyScalar(t)}lerp(t,e){return this.x+=(t.x-this.x)*e,this.y+=(t.y-this.y)*e,this.z+=(t.z-this.z)*e,this}lerpVectors(t,e,n){return this.x=t.x+(e.x-t.x)*n,this.y=t.y+(e.y-t.y)*n,this.z=t.z+(e.z-t.z)*n,this}cross(t){return this.crossVectors(this,t)}crossVectors(t,e){let n=t.x,i=t.y,r=t.z,o=e.x,a=e.y,c=e.z;return this.x=i*c-r*a,this.y=r*o-n*c,this.z=n*a-i*o,this}projectOnVector(t){let e=t.lengthSq();if(e===0)return this.set(0,0,0);let n=t.dot(this)/e;return this.copy(t).multiplyScalar(n)}projectOnPlane(t){return Lr.copy(this).projectOnVector(t),this.sub(Lr)}reflect(t){return this.sub(Lr.copy(t).multiplyScalar(2*this.dot(t)))}angleTo(t){let e=Math.sqrt(this.lengthSq()*t.lengthSq());if(e===0)return Math.PI/2;let n=this.dot(t)/e;return Math.acos(we(n,-1,1))}distanceTo(t){return Math.sqrt(this.distanceToSquared(t))}distanceToSquared(t){let e=this.x-t.x,n=this.y-t.y,i=this.z-t.z;return e*e+n*n+i*i}manhattanDistanceTo(t){return Math.abs(this.x-t.x)+Math.abs(this.y-t.y)+Math.abs(this.z-t.z)}setFromSpherical(t){return this.setFromSphericalCoords(t.radius,t.phi,t.theta)}setFromSphericalCoords(t,e,n){let i=Math.sin(e)*t;return this.x=i*Math.sin(n),this.y=Math.cos(e)*t,this.z=i*Math.cos(n),this}setFromCylindrical(t){return this.setFromCylindricalCoords(t.radius,t.theta,t.y)}setFromCylindricalCoords(t,e,n){return this.x=t*Math.sin(e),this.y=n,this.z=t*Math.cos(e),this}setFromMatrixPosition(t){let e=t.elements;return this.x=e[12],this.y=e[13],this.z=e[14],this}setFromMatrixScale(t){let e=this.setFromMatrixColumn(t,0).length(),n=this.setFromMatrixColumn(t,1).length(),i=this.setFromMatrixColumn(t,2).length();return this.x=e,this.y=n,this.z=i,this}setFromMatrixColumn(t,e){return this.fromArray(t.elements,e*4)}setFromMatrix3Column(t,e){return this.fromArray(t.elements,e*3)}setFromEuler(t){return this.x=t._x,this.y=t._y,this.z=t._z,this}setFromColor(t){return this.x=t.r,this.y=t.g,this.z=t.b,this}equals(t){return t.x===this.x&&t.y===this.y&&t.z===this.z}fromArray(t,e=0){return this.x=t[e],this.y=t[e+1],this.z=t[e+2],this}toArray(t=[],e=0){return t[e]=this.x,t[e+1]=this.y,t[e+2]=this.z,t}fromBufferAttribute(t,e){return this.x=t.getX(e),this.y=t.getY(e),this.z=t.getZ(e),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this}randomDirection(){let t=(Math.random()-.5)*2,e=Math.random()*Math.PI*2,n=Math.sqrt(1-t**2);return this.x=n*Math.cos(e),this.y=n*Math.sin(e),this.z=t,this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z}},Lr=new L,Wa=new bn,rn=class{constructor(t=new L(1/0,1/0,1/0),e=new L(-1/0,-1/0,-1/0)){this.isBox3=!0,this.min=t,this.max=e}set(t,e){return this.min.copy(t),this.max.copy(e),this}setFromArray(t){this.makeEmpty();for(let e=0,n=t.length;e<n;e+=3)this.expandByPoint(Oe.fromArray(t,e));return this}setFromBufferAttribute(t){this.makeEmpty();for(let e=0,n=t.count;e<n;e++)this.expandByPoint(Oe.fromBufferAttribute(t,e));return this}setFromPoints(t){this.makeEmpty();for(let e=0,n=t.length;e<n;e++)this.expandByPoint(t[e]);return this}setFromCenterAndSize(t,e){let n=Oe.copy(e).multiplyScalar(.5);return this.min.copy(t).sub(n),this.max.copy(t).add(n),this}setFromObject(t,e=!1){return this.makeEmpty(),this.expandByObject(t,e)}clone(){return new this.constructor().copy(this)}copy(t){return this.min.copy(t.min),this.max.copy(t.max),this}makeEmpty(){return this.min.x=this.min.y=this.min.z=1/0,this.max.x=this.max.y=this.max.z=-1/0,this}isEmpty(){return this.max.x<this.min.x||this.max.y<this.min.y||this.max.z<this.min.z}getCenter(t){return this.isEmpty()?t.set(0,0,0):t.addVectors(this.min,this.max).multiplyScalar(.5)}getSize(t){return this.isEmpty()?t.set(0,0,0):t.subVectors(this.max,this.min)}expandByPoint(t){return this.min.min(t),this.max.max(t),this}expandByVector(t){return this.min.sub(t),this.max.add(t),this}expandByScalar(t){return this.min.addScalar(-t),this.max.addScalar(t),this}expandByObject(t,e=!1){t.updateWorldMatrix(!1,!1);let n=t.geometry;if(n!==void 0){let r=n.getAttribute("position");if(e===!0&&r!==void 0&&t.isInstancedMesh!==!0)for(let o=0,a=r.count;o<a;o++)t.isMesh===!0?t.getVertexPosition(o,Oe):Oe.fromBufferAttribute(r,o),Oe.applyMatrix4(t.matrixWorld),this.expandByPoint(Oe);else t.boundingBox!==void 0?(t.boundingBox===null&&t.computeBoundingBox(),rs.copy(t.boundingBox)):(n.boundingBox===null&&n.computeBoundingBox(),rs.copy(n.boundingBox)),rs.applyMatrix4(t.matrixWorld),this.union(rs)}let i=t.children;for(let r=0,o=i.length;r<o;r++)this.expandByObject(i[r],e);return this}containsPoint(t){return!(t.x<this.min.x||t.x>this.max.x||t.y<this.min.y||t.y>this.max.y||t.z<this.min.z||t.z>this.max.z)}containsBox(t){return this.min.x<=t.min.x&&t.max.x<=this.max.x&&this.min.y<=t.min.y&&t.max.y<=this.max.y&&this.min.z<=t.min.z&&t.max.z<=this.max.z}getParameter(t,e){return e.set((t.x-this.min.x)/(this.max.x-this.min.x),(t.y-this.min.y)/(this.max.y-this.min.y),(t.z-this.min.z)/(this.max.z-this.min.z))}intersectsBox(t){return!(t.max.x<this.min.x||t.min.x>this.max.x||t.max.y<this.min.y||t.min.y>this.max.y||t.max.z<this.min.z||t.min.z>this.max.z)}intersectsSphere(t){return this.clampPoint(t.center,Oe),Oe.distanceToSquared(t.center)<=t.radius*t.radius}intersectsPlane(t){let e,n;return t.normal.x>0?(e=t.normal.x*this.min.x,n=t.normal.x*this.max.x):(e=t.normal.x*this.max.x,n=t.normal.x*this.min.x),t.normal.y>0?(e+=t.normal.y*this.min.y,n+=t.normal.y*this.max.y):(e+=t.normal.y*this.max.y,n+=t.normal.y*this.min.y),t.normal.z>0?(e+=t.normal.z*this.min.z,n+=t.normal.z*this.max.z):(e+=t.normal.z*this.max.z,n+=t.normal.z*this.min.z),e<=-t.constant&&n>=-t.constant}intersectsTriangle(t){if(this.isEmpty())return!1;this.getCenter(Pi),os.subVectors(this.max,Pi),Wn.subVectors(t.a,Pi),Xn.subVectors(t.b,Pi),qn.subVectors(t.c,Pi),ln.subVectors(Xn,Wn),hn.subVectors(qn,Xn),Tn.subVectors(Wn,qn);let e=[0,-ln.z,ln.y,0,-hn.z,hn.y,0,-Tn.z,Tn.y,ln.z,0,-ln.x,hn.z,0,-hn.x,Tn.z,0,-Tn.x,-ln.y,ln.x,0,-hn.y,hn.x,0,-Tn.y,Tn.x,0];return!Ir(e,Wn,Xn,qn,os)||(e=[1,0,0,0,1,0,0,0,1],!Ir(e,Wn,Xn,qn,os))?!1:(as.crossVectors(ln,hn),e=[as.x,as.y,as.z],Ir(e,Wn,Xn,qn,os))}clampPoint(t,e){return e.copy(t).clamp(this.min,this.max)}distanceToPoint(t){return this.clampPoint(t,Oe).distanceTo(t)}getBoundingSphere(t){return this.isEmpty()?t.makeEmpty():(this.getCenter(t.center),t.radius=this.getSize(Oe).length()*.5),t}intersect(t){return this.min.max(t.min),this.max.min(t.max),this.isEmpty()&&this.makeEmpty(),this}union(t){return this.min.min(t.min),this.max.max(t.max),this}applyMatrix4(t){return this.isEmpty()?this:(qe[0].set(this.min.x,this.min.y,this.min.z).applyMatrix4(t),qe[1].set(this.min.x,this.min.y,this.max.z).applyMatrix4(t),qe[2].set(this.min.x,this.max.y,this.min.z).applyMatrix4(t),qe[3].set(this.min.x,this.max.y,this.max.z).applyMatrix4(t),qe[4].set(this.max.x,this.min.y,this.min.z).applyMatrix4(t),qe[5].set(this.max.x,this.min.y,this.max.z).applyMatrix4(t),qe[6].set(this.max.x,this.max.y,this.min.z).applyMatrix4(t),qe[7].set(this.max.x,this.max.y,this.max.z).applyMatrix4(t),this.setFromPoints(qe),this)}translate(t){return this.min.add(t),this.max.add(t),this}equals(t){return t.min.equals(this.min)&&t.max.equals(this.max)}},qe=[new L,new L,new L,new L,new L,new L,new L,new L],Oe=new L,rs=new rn,Wn=new L,Xn=new L,qn=new L,ln=new L,hn=new L,Tn=new L,Pi=new L,os=new L,as=new L,Cn=new L;function Ir(s,t,e,n,i){for(let r=0,o=s.length-3;r<=o;r+=3){Cn.fromArray(s,r);let a=i.x*Math.abs(Cn.x)+i.y*Math.abs(Cn.y)+i.z*Math.abs(Cn.z),c=t.dot(Cn),l=e.dot(Cn),h=n.dot(Cn);if(Math.max(-Math.max(c,l,h),Math.min(c,l,h))>a)return!1}return!0}var Rh=new rn,Li=new L,Dr=new L,on=class{constructor(t=new L,e=-1){this.isSphere=!0,this.center=t,this.radius=e}set(t,e){return this.center.copy(t),this.radius=e,this}setFromPoints(t,e){let n=this.center;e!==void 0?n.copy(e):Rh.setFromPoints(t).getCenter(n);let i=0;for(let r=0,o=t.length;r<o;r++)i=Math.max(i,n.distanceToSquared(t[r]));return this.radius=Math.sqrt(i),this}copy(t){return this.center.copy(t.center),this.radius=t.radius,this}isEmpty(){return this.radius<0}makeEmpty(){return this.center.set(0,0,0),this.radius=-1,this}containsPoint(t){return t.distanceToSquared(this.center)<=this.radius*this.radius}distanceToPoint(t){return t.distanceTo(this.center)-this.radius}intersectsSphere(t){let e=this.radius+t.radius;return t.center.distanceToSquared(this.center)<=e*e}intersectsBox(t){return t.intersectsSphere(this)}intersectsPlane(t){return Math.abs(t.distanceToPoint(this.center))<=this.radius}clampPoint(t,e){let n=this.center.distanceToSquared(t);return e.copy(t),n>this.radius*this.radius&&(e.sub(this.center).normalize(),e.multiplyScalar(this.radius).add(this.center)),e}getBoundingBox(t){return this.isEmpty()?(t.makeEmpty(),t):(t.set(this.center,this.center),t.expandByScalar(this.radius),t)}applyMatrix4(t){return this.center.applyMatrix4(t),this.radius=this.radius*t.getMaxScaleOnAxis(),this}translate(t){return this.center.add(t),this}expandByPoint(t){if(this.isEmpty())return this.center.copy(t),this.radius=0,this;Li.subVectors(t,this.center);let e=Li.lengthSq();if(e>this.radius*this.radius){let n=Math.sqrt(e),i=(n-this.radius)*.5;this.center.addScaledVector(Li,i/n),this.radius+=i}return this}union(t){return t.isEmpty()?this:this.isEmpty()?(this.copy(t),this):(this.center.equals(t.center)===!0?this.radius=Math.max(this.radius,t.radius):(Dr.subVectors(t.center,this.center).setLength(t.radius),this.expandByPoint(Li.copy(t.center).add(Dr)),this.expandByPoint(Li.copy(t.center).sub(Dr))),this)}equals(t){return t.center.equals(this.center)&&t.radius===this.radius}clone(){return new this.constructor().copy(this)}},Ye=new L,Ur=new L,cs=new L,un=new L,Nr=new L,ls=new L,Fr=new L,vi=class{constructor(t=new L,e=new L(0,0,-1)){this.origin=t,this.direction=e}set(t,e){return this.origin.copy(t),this.direction.copy(e),this}copy(t){return this.origin.copy(t.origin),this.direction.copy(t.direction),this}at(t,e){return e.copy(this.origin).addScaledVector(this.direction,t)}lookAt(t){return this.direction.copy(t).sub(this.origin).normalize(),this}recast(t){return this.origin.copy(this.at(t,Ye)),this}closestPointToPoint(t,e){e.subVectors(t,this.origin);let n=e.dot(this.direction);return n<0?e.copy(this.origin):e.copy(this.origin).addScaledVector(this.direction,n)}distanceToPoint(t){return Math.sqrt(this.distanceSqToPoint(t))}distanceSqToPoint(t){let e=Ye.subVectors(t,this.origin).dot(this.direction);return e<0?this.origin.distanceToSquared(t):(Ye.copy(this.origin).addScaledVector(this.direction,e),Ye.distanceToSquared(t))}distanceSqToSegment(t,e,n,i){Ur.copy(t).add(e).multiplyScalar(.5),cs.copy(e).sub(t).normalize(),un.copy(this.origin).sub(Ur);let r=t.distanceTo(e)*.5,o=-this.direction.dot(cs),a=un.dot(this.direction),c=-un.dot(cs),l=un.lengthSq(),h=Math.abs(1-o*o),u,d,m,v;if(h>0)if(u=o*c-a,d=o*a-c,v=r*h,u>=0)if(d>=-v)if(d<=v){let x=1/h;u*=x,d*=x,m=u*(u+o*d+2*a)+d*(o*u+d+2*c)+l}else d=r,u=Math.max(0,-(o*d+a)),m=-u*u+d*(d+2*c)+l;else d=-r,u=Math.max(0,-(o*d+a)),m=-u*u+d*(d+2*c)+l;else d<=-v?(u=Math.max(0,-(-o*r+a)),d=u>0?-r:Math.min(Math.max(-r,-c),r),m=-u*u+d*(d+2*c)+l):d<=v?(u=0,d=Math.min(Math.max(-r,-c),r),m=d*(d+2*c)+l):(u=Math.max(0,-(o*r+a)),d=u>0?r:Math.min(Math.max(-r,-c),r),m=-u*u+d*(d+2*c)+l);else d=o>0?-r:r,u=Math.max(0,-(o*d+a)),m=-u*u+d*(d+2*c)+l;return n&&n.copy(this.origin).addScaledVector(this.direction,u),i&&i.copy(Ur).addScaledVector(cs,d),m}intersectSphere(t,e){Ye.subVectors(t.center,this.origin);let n=Ye.dot(this.direction),i=Ye.dot(Ye)-n*n,r=t.radius*t.radius;if(i>r)return null;let o=Math.sqrt(r-i),a=n-o,c=n+o;return c<0?null:a<0?this.at(c,e):this.at(a,e)}intersectsSphere(t){return this.distanceSqToPoint(t.center)<=t.radius*t.radius}distanceToPlane(t){let e=t.normal.dot(this.direction);if(e===0)return t.distanceToPoint(this.origin)===0?0:null;let n=-(this.origin.dot(t.normal)+t.constant)/e;return n>=0?n:null}intersectPlane(t,e){let n=this.distanceToPlane(t);return n===null?null:this.at(n,e)}intersectsPlane(t){let e=t.distanceToPoint(this.origin);return e===0||t.normal.dot(this.direction)*e<0}intersectBox(t,e){let n,i,r,o,a,c,l=1/this.direction.x,h=1/this.direction.y,u=1/this.direction.z,d=this.origin;return l>=0?(n=(t.min.x-d.x)*l,i=(t.max.x-d.x)*l):(n=(t.max.x-d.x)*l,i=(t.min.x-d.x)*l),h>=0?(r=(t.min.y-d.y)*h,o=(t.max.y-d.y)*h):(r=(t.max.y-d.y)*h,o=(t.min.y-d.y)*h),n>o||r>i||((r>n||isNaN(n))&&(n=r),(o<i||isNaN(i))&&(i=o),u>=0?(a=(t.min.z-d.z)*u,c=(t.max.z-d.z)*u):(a=(t.max.z-d.z)*u,c=(t.min.z-d.z)*u),n>c||a>i)||((a>n||n!==n)&&(n=a),(c<i||i!==i)&&(i=c),i<0)?null:this.at(n>=0?n:i,e)}intersectsBox(t){return this.intersectBox(t,Ye)!==null}intersectTriangle(t,e,n,i,r){Nr.subVectors(e,t),ls.subVectors(n,t),Fr.crossVectors(Nr,ls);let o=this.direction.dot(Fr),a;if(o>0){if(i)return null;a=1}else if(o<0)a=-1,o=-o;else return null;un.subVectors(this.origin,t);let c=a*this.direction.dot(ls.crossVectors(un,ls));if(c<0)return null;let l=a*this.direction.dot(Nr.cross(un));if(l<0||c+l>o)return null;let h=-a*un.dot(Fr);return h<0?null:this.at(h/o,r)}applyMatrix4(t){return this.origin.applyMatrix4(t),this.direction.transformDirection(t),this}equals(t){return t.origin.equals(this.origin)&&t.direction.equals(this.direction)}clone(){return new this.constructor().copy(this)}},Zt=class s{constructor(t,e,n,i,r,o,a,c,l,h,u,d,m,v,x,p){s.prototype.isMatrix4=!0,this.elements=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],t!==void 0&&this.set(t,e,n,i,r,o,a,c,l,h,u,d,m,v,x,p)}set(t,e,n,i,r,o,a,c,l,h,u,d,m,v,x,p){let f=this.elements;return f[0]=t,f[4]=e,f[8]=n,f[12]=i,f[1]=r,f[5]=o,f[9]=a,f[13]=c,f[2]=l,f[6]=h,f[10]=u,f[14]=d,f[3]=m,f[7]=v,f[11]=x,f[15]=p,this}identity(){return this.set(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1),this}clone(){return new s().fromArray(this.elements)}copy(t){let e=this.elements,n=t.elements;return e[0]=n[0],e[1]=n[1],e[2]=n[2],e[3]=n[3],e[4]=n[4],e[5]=n[5],e[6]=n[6],e[7]=n[7],e[8]=n[8],e[9]=n[9],e[10]=n[10],e[11]=n[11],e[12]=n[12],e[13]=n[13],e[14]=n[14],e[15]=n[15],this}copyPosition(t){let e=this.elements,n=t.elements;return e[12]=n[12],e[13]=n[13],e[14]=n[14],this}setFromMatrix3(t){let e=t.elements;return this.set(e[0],e[3],e[6],0,e[1],e[4],e[7],0,e[2],e[5],e[8],0,0,0,0,1),this}extractBasis(t,e,n){return t.setFromMatrixColumn(this,0),e.setFromMatrixColumn(this,1),n.setFromMatrixColumn(this,2),this}makeBasis(t,e,n){return this.set(t.x,e.x,n.x,0,t.y,e.y,n.y,0,t.z,e.z,n.z,0,0,0,0,1),this}extractRotation(t){let e=this.elements,n=t.elements,i=1/Yn.setFromMatrixColumn(t,0).length(),r=1/Yn.setFromMatrixColumn(t,1).length(),o=1/Yn.setFromMatrixColumn(t,2).length();return e[0]=n[0]*i,e[1]=n[1]*i,e[2]=n[2]*i,e[3]=0,e[4]=n[4]*r,e[5]=n[5]*r,e[6]=n[6]*r,e[7]=0,e[8]=n[8]*o,e[9]=n[9]*o,e[10]=n[10]*o,e[11]=0,e[12]=0,e[13]=0,e[14]=0,e[15]=1,this}makeRotationFromEuler(t){let e=this.elements,n=t.x,i=t.y,r=t.z,o=Math.cos(n),a=Math.sin(n),c=Math.cos(i),l=Math.sin(i),h=Math.cos(r),u=Math.sin(r);if(t.order==="XYZ"){let d=o*h,m=o*u,v=a*h,x=a*u;e[0]=c*h,e[4]=-c*u,e[8]=l,e[1]=m+v*l,e[5]=d-x*l,e[9]=-a*c,e[2]=x-d*l,e[6]=v+m*l,e[10]=o*c}else if(t.order==="YXZ"){let d=c*h,m=c*u,v=l*h,x=l*u;e[0]=d+x*a,e[4]=v*a-m,e[8]=o*l,e[1]=o*u,e[5]=o*h,e[9]=-a,e[2]=m*a-v,e[6]=x+d*a,e[10]=o*c}else if(t.order==="ZXY"){let d=c*h,m=c*u,v=l*h,x=l*u;e[0]=d-x*a,e[4]=-o*u,e[8]=v+m*a,e[1]=m+v*a,e[5]=o*h,e[9]=x-d*a,e[2]=-o*l,e[6]=a,e[10]=o*c}else if(t.order==="ZYX"){let d=o*h,m=o*u,v=a*h,x=a*u;e[0]=c*h,e[4]=v*l-m,e[8]=d*l+x,e[1]=c*u,e[5]=x*l+d,e[9]=m*l-v,e[2]=-l,e[6]=a*c,e[10]=o*c}else if(t.order==="YZX"){let d=o*c,m=o*l,v=a*c,x=a*l;e[0]=c*h,e[4]=x-d*u,e[8]=v*u+m,e[1]=u,e[5]=o*h,e[9]=-a*h,e[2]=-l*h,e[6]=m*u+v,e[10]=d-x*u}else if(t.order==="XZY"){let d=o*c,m=o*l,v=a*c,x=a*l;e[0]=c*h,e[4]=-u,e[8]=l*h,e[1]=d*u+x,e[5]=o*h,e[9]=m*u-v,e[2]=v*u-m,e[6]=a*h,e[10]=x*u+d}return e[3]=0,e[7]=0,e[11]=0,e[12]=0,e[13]=0,e[14]=0,e[15]=1,this}makeRotationFromQuaternion(t){return this.compose(Ph,t,Lh)}lookAt(t,e,n){let i=this.elements;return Ce.subVectors(t,e),Ce.lengthSq()===0&&(Ce.z=1),Ce.normalize(),dn.crossVectors(n,Ce),dn.lengthSq()===0&&(Math.abs(n.z)===1?Ce.x+=1e-4:Ce.z+=1e-4,Ce.normalize(),dn.crossVectors(n,Ce)),dn.normalize(),hs.crossVectors(Ce,dn),i[0]=dn.x,i[4]=hs.x,i[8]=Ce.x,i[1]=dn.y,i[5]=hs.y,i[9]=Ce.y,i[2]=dn.z,i[6]=hs.z,i[10]=Ce.z,this}multiply(t){return this.multiplyMatrices(this,t)}premultiply(t){return this.multiplyMatrices(t,this)}multiplyMatrices(t,e){let n=t.elements,i=e.elements,r=this.elements,o=n[0],a=n[4],c=n[8],l=n[12],h=n[1],u=n[5],d=n[9],m=n[13],v=n[2],x=n[6],p=n[10],f=n[14],g=n[3],_=n[7],b=n[11],S=n[15],T=i[0],C=i[4],P=i[8],y=i[12],w=i[1],F=i[5],B=i[9],W=i[13],R=i[2],D=i[6],H=i[10],k=i[14],N=i[3],V=i[7],K=i[11],$=i[15];return r[0]=o*T+a*w+c*R+l*N,r[4]=o*C+a*F+c*D+l*V,r[8]=o*P+a*B+c*H+l*K,r[12]=o*y+a*W+c*k+l*$,r[1]=h*T+u*w+d*R+m*N,r[5]=h*C+u*F+d*D+m*V,r[9]=h*P+u*B+d*H+m*K,r[13]=h*y+u*W+d*k+m*$,r[2]=v*T+x*w+p*R+f*N,r[6]=v*C+x*F+p*D+f*V,r[10]=v*P+x*B+p*H+f*K,r[14]=v*y+x*W+p*k+f*$,r[3]=g*T+_*w+b*R+S*N,r[7]=g*C+_*F+b*D+S*V,r[11]=g*P+_*B+b*H+S*K,r[15]=g*y+_*W+b*k+S*$,this}multiplyScalar(t){let e=this.elements;return e[0]*=t,e[4]*=t,e[8]*=t,e[12]*=t,e[1]*=t,e[5]*=t,e[9]*=t,e[13]*=t,e[2]*=t,e[6]*=t,e[10]*=t,e[14]*=t,e[3]*=t,e[7]*=t,e[11]*=t,e[15]*=t,this}determinant(){let t=this.elements,e=t[0],n=t[4],i=t[8],r=t[12],o=t[1],a=t[5],c=t[9],l=t[13],h=t[2],u=t[6],d=t[10],m=t[14],v=t[3],x=t[7],p=t[11],f=t[15];return v*(+r*c*u-i*l*u-r*a*d+n*l*d+i*a*m-n*c*m)+x*(+e*c*m-e*l*d+r*o*d-i*o*m+i*l*h-r*c*h)+p*(+e*l*u-e*a*m-r*o*u+n*o*m+r*a*h-n*l*h)+f*(-i*a*h-e*c*u+e*a*d+i*o*u-n*o*d+n*c*h)}transpose(){let t=this.elements,e;return e=t[1],t[1]=t[4],t[4]=e,e=t[2],t[2]=t[8],t[8]=e,e=t[6],t[6]=t[9],t[9]=e,e=t[3],t[3]=t[12],t[12]=e,e=t[7],t[7]=t[13],t[13]=e,e=t[11],t[11]=t[14],t[14]=e,this}setPosition(t,e,n){let i=this.elements;return t.isVector3?(i[12]=t.x,i[13]=t.y,i[14]=t.z):(i[12]=t,i[13]=e,i[14]=n),this}invert(){let t=this.elements,e=t[0],n=t[1],i=t[2],r=t[3],o=t[4],a=t[5],c=t[6],l=t[7],h=t[8],u=t[9],d=t[10],m=t[11],v=t[12],x=t[13],p=t[14],f=t[15],g=u*p*l-x*d*l+x*c*m-a*p*m-u*c*f+a*d*f,_=v*d*l-h*p*l-v*c*m+o*p*m+h*c*f-o*d*f,b=h*x*l-v*u*l+v*a*m-o*x*m-h*a*f+o*u*f,S=v*u*c-h*x*c-v*a*d+o*x*d+h*a*p-o*u*p,T=e*g+n*_+i*b+r*S;if(T===0)return this.set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);let C=1/T;return t[0]=g*C,t[1]=(x*d*r-u*p*r-x*i*m+n*p*m+u*i*f-n*d*f)*C,t[2]=(a*p*r-x*c*r+x*i*l-n*p*l-a*i*f+n*c*f)*C,t[3]=(u*c*r-a*d*r-u*i*l+n*d*l+a*i*m-n*c*m)*C,t[4]=_*C,t[5]=(h*p*r-v*d*r+v*i*m-e*p*m-h*i*f+e*d*f)*C,t[6]=(v*c*r-o*p*r-v*i*l+e*p*l+o*i*f-e*c*f)*C,t[7]=(o*d*r-h*c*r+h*i*l-e*d*l-o*i*m+e*c*m)*C,t[8]=b*C,t[9]=(v*u*r-h*x*r-v*n*m+e*x*m+h*n*f-e*u*f)*C,t[10]=(o*x*r-v*a*r+v*n*l-e*x*l-o*n*f+e*a*f)*C,t[11]=(h*a*r-o*u*r-h*n*l+e*u*l+o*n*m-e*a*m)*C,t[12]=S*C,t[13]=(h*x*i-v*u*i+v*n*d-e*x*d-h*n*p+e*u*p)*C,t[14]=(v*a*i-o*x*i-v*n*c+e*x*c+o*n*p-e*a*p)*C,t[15]=(o*u*i-h*a*i+h*n*c-e*u*c-o*n*d+e*a*d)*C,this}scale(t){let e=this.elements,n=t.x,i=t.y,r=t.z;return e[0]*=n,e[4]*=i,e[8]*=r,e[1]*=n,e[5]*=i,e[9]*=r,e[2]*=n,e[6]*=i,e[10]*=r,e[3]*=n,e[7]*=i,e[11]*=r,this}getMaxScaleOnAxis(){let t=this.elements,e=t[0]*t[0]+t[1]*t[1]+t[2]*t[2],n=t[4]*t[4]+t[5]*t[5]+t[6]*t[6],i=t[8]*t[8]+t[9]*t[9]+t[10]*t[10];return Math.sqrt(Math.max(e,n,i))}makeTranslation(t,e,n){return t.isVector3?this.set(1,0,0,t.x,0,1,0,t.y,0,0,1,t.z,0,0,0,1):this.set(1,0,0,t,0,1,0,e,0,0,1,n,0,0,0,1),this}makeRotationX(t){let e=Math.cos(t),n=Math.sin(t);return this.set(1,0,0,0,0,e,-n,0,0,n,e,0,0,0,0,1),this}makeRotationY(t){let e=Math.cos(t),n=Math.sin(t);return this.set(e,0,n,0,0,1,0,0,-n,0,e,0,0,0,0,1),this}makeRotationZ(t){let e=Math.cos(t),n=Math.sin(t);return this.set(e,-n,0,0,n,e,0,0,0,0,1,0,0,0,0,1),this}makeRotationAxis(t,e){let n=Math.cos(e),i=Math.sin(e),r=1-n,o=t.x,a=t.y,c=t.z,l=r*o,h=r*a;return this.set(l*o+n,l*a-i*c,l*c+i*a,0,l*a+i*c,h*a+n,h*c-i*o,0,l*c-i*a,h*c+i*o,r*c*c+n,0,0,0,0,1),this}makeScale(t,e,n){return this.set(t,0,0,0,0,e,0,0,0,0,n,0,0,0,0,1),this}makeShear(t,e,n,i,r,o){return this.set(1,n,r,0,t,1,o,0,e,i,1,0,0,0,0,1),this}compose(t,e,n){let i=this.elements,r=e._x,o=e._y,a=e._z,c=e._w,l=r+r,h=o+o,u=a+a,d=r*l,m=r*h,v=r*u,x=o*h,p=o*u,f=a*u,g=c*l,_=c*h,b=c*u,S=n.x,T=n.y,C=n.z;return i[0]=(1-(x+f))*S,i[1]=(m+b)*S,i[2]=(v-_)*S,i[3]=0,i[4]=(m-b)*T,i[5]=(1-(d+f))*T,i[6]=(p+g)*T,i[7]=0,i[8]=(v+_)*C,i[9]=(p-g)*C,i[10]=(1-(d+x))*C,i[11]=0,i[12]=t.x,i[13]=t.y,i[14]=t.z,i[15]=1,this}decompose(t,e,n){let i=this.elements,r=Yn.set(i[0],i[1],i[2]).length(),o=Yn.set(i[4],i[5],i[6]).length(),a=Yn.set(i[8],i[9],i[10]).length();this.determinant()<0&&(r=-r),t.x=i[12],t.y=i[13],t.z=i[14],Be.copy(this);let l=1/r,h=1/o,u=1/a;return Be.elements[0]*=l,Be.elements[1]*=l,Be.elements[2]*=l,Be.elements[4]*=h,Be.elements[5]*=h,Be.elements[6]*=h,Be.elements[8]*=u,Be.elements[9]*=u,Be.elements[10]*=u,e.setFromRotationMatrix(Be),n.x=r,n.y=o,n.z=a,this}makePerspective(t,e,n,i,r,o,a=en){let c=this.elements,l=2*r/(e-t),h=2*r/(n-i),u=(e+t)/(e-t),d=(n+i)/(n-i),m,v;if(a===en)m=-(o+r)/(o-r),v=-2*o*r/(o-r);else if(a===ks)m=-o/(o-r),v=-o*r/(o-r);else throw new Error("THREE.Matrix4.makePerspective(): Invalid coordinate system: "+a);return c[0]=l,c[4]=0,c[8]=u,c[12]=0,c[1]=0,c[5]=h,c[9]=d,c[13]=0,c[2]=0,c[6]=0,c[10]=m,c[14]=v,c[3]=0,c[7]=0,c[11]=-1,c[15]=0,this}makeOrthographic(t,e,n,i,r,o,a=en){let c=this.elements,l=1/(e-t),h=1/(n-i),u=1/(o-r),d=(e+t)*l,m=(n+i)*h,v,x;if(a===en)v=(o+r)*u,x=-2*u;else if(a===ks)v=r*u,x=-1*u;else throw new Error("THREE.Matrix4.makeOrthographic(): Invalid coordinate system: "+a);return c[0]=2*l,c[4]=0,c[8]=0,c[12]=-d,c[1]=0,c[5]=2*h,c[9]=0,c[13]=-m,c[2]=0,c[6]=0,c[10]=x,c[14]=-v,c[3]=0,c[7]=0,c[11]=0,c[15]=1,this}equals(t){let e=this.elements,n=t.elements;for(let i=0;i<16;i++)if(e[i]!==n[i])return!1;return!0}fromArray(t,e=0){for(let n=0;n<16;n++)this.elements[n]=t[n+e];return this}toArray(t=[],e=0){let n=this.elements;return t[e]=n[0],t[e+1]=n[1],t[e+2]=n[2],t[e+3]=n[3],t[e+4]=n[4],t[e+5]=n[5],t[e+6]=n[6],t[e+7]=n[7],t[e+8]=n[8],t[e+9]=n[9],t[e+10]=n[10],t[e+11]=n[11],t[e+12]=n[12],t[e+13]=n[13],t[e+14]=n[14],t[e+15]=n[15],t}},Yn=new L,Be=new Zt,Ph=new L(0,0,0),Lh=new L(1,1,1),dn=new L,hs=new L,Ce=new L,Xa=new Zt,qa=new bn,Xs=class s{constructor(t=0,e=0,n=0,i=s.DEFAULT_ORDER){this.isEuler=!0,this._x=t,this._y=e,this._z=n,this._order=i}get x(){return this._x}set x(t){this._x=t,this._onChangeCallback()}get y(){return this._y}set y(t){this._y=t,this._onChangeCallback()}get z(){return this._z}set z(t){this._z=t,this._onChangeCallback()}get order(){return this._order}set order(t){this._order=t,this._onChangeCallback()}set(t,e,n,i=this._order){return this._x=t,this._y=e,this._z=n,this._order=i,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._order)}copy(t){return this._x=t._x,this._y=t._y,this._z=t._z,this._order=t._order,this._onChangeCallback(),this}setFromRotationMatrix(t,e=this._order,n=!0){let i=t.elements,r=i[0],o=i[4],a=i[8],c=i[1],l=i[5],h=i[9],u=i[2],d=i[6],m=i[10];switch(e){case"XYZ":this._y=Math.asin(we(a,-1,1)),Math.abs(a)<.9999999?(this._x=Math.atan2(-h,m),this._z=Math.atan2(-o,r)):(this._x=Math.atan2(d,l),this._z=0);break;case"YXZ":this._x=Math.asin(-we(h,-1,1)),Math.abs(h)<.9999999?(this._y=Math.atan2(a,m),this._z=Math.atan2(c,l)):(this._y=Math.atan2(-u,r),this._z=0);break;case"ZXY":this._x=Math.asin(we(d,-1,1)),Math.abs(d)<.9999999?(this._y=Math.atan2(-u,m),this._z=Math.atan2(-o,l)):(this._y=0,this._z=Math.atan2(c,r));break;case"ZYX":this._y=Math.asin(-we(u,-1,1)),Math.abs(u)<.9999999?(this._x=Math.atan2(d,m),this._z=Math.atan2(c,r)):(this._x=0,this._z=Math.atan2(-o,l));break;case"YZX":this._z=Math.asin(we(c,-1,1)),Math.abs(c)<.9999999?(this._x=Math.atan2(-h,l),this._y=Math.atan2(-u,r)):(this._x=0,this._y=Math.atan2(a,m));break;case"XZY":this._z=Math.asin(-we(o,-1,1)),Math.abs(o)<.9999999?(this._x=Math.atan2(d,l),this._y=Math.atan2(a,r)):(this._x=Math.atan2(-h,m),this._y=0);break;default:console.warn("THREE.Euler: .setFromRotationMatrix() encountered an unknown order: "+e)}return this._order=e,n===!0&&this._onChangeCallback(),this}setFromQuaternion(t,e,n){return Xa.makeRotationFromQuaternion(t),this.setFromRotationMatrix(Xa,e,n)}setFromVector3(t,e=this._order){return this.set(t.x,t.y,t.z,e)}reorder(t){return qa.setFromEuler(this),this.setFromQuaternion(qa,t)}equals(t){return t._x===this._x&&t._y===this._y&&t._z===this._z&&t._order===this._order}fromArray(t){return this._x=t[0],this._y=t[1],this._z=t[2],t[3]!==void 0&&(this._order=t[3]),this._onChangeCallback(),this}toArray(t=[],e=0){return t[e]=this._x,t[e+1]=this._y,t[e+2]=this._z,t[e+3]=this._order,t}_onChange(t){return this._onChangeCallback=t,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._order}};Xs.DEFAULT_ORDER="XYZ";var Gi=class{constructor(){this.mask=1}set(t){this.mask=(1<<t|0)>>>0}enable(t){this.mask|=1<<t|0}enableAll(){this.mask=-1}toggle(t){this.mask^=1<<t|0}disable(t){this.mask&=~(1<<t|0)}disableAll(){this.mask=0}test(t){return(this.mask&t.mask)!==0}isEnabled(t){return(this.mask&(1<<t|0))!==0}},Ih=0,Ya=new L,Zn=new bn,Ze=new Zt,us=new L,Ii=new L,Dh=new L,Uh=new bn,Za=new L(1,0,0),Ja=new L(0,1,0),Ka=new L(0,0,1),Nh={type:"added"},Fh={type:"removed"},fe=class s extends Mn{constructor(){super(),this.isObject3D=!0,Object.defineProperty(this,"id",{value:Ih++}),this.uuid=xn(),this.name="",this.type="Object3D",this.parent=null,this.children=[],this.up=s.DEFAULT_UP.clone();let t=new L,e=new Xs,n=new bn,i=new L(1,1,1);function r(){n.setFromEuler(e,!1)}function o(){e.setFromQuaternion(n,void 0,!1)}e._onChange(r),n._onChange(o),Object.defineProperties(this,{position:{configurable:!0,enumerable:!0,value:t},rotation:{configurable:!0,enumerable:!0,value:e},quaternion:{configurable:!0,enumerable:!0,value:n},scale:{configurable:!0,enumerable:!0,value:i},modelViewMatrix:{value:new Zt},normalMatrix:{value:new Gt}}),this.matrix=new Zt,this.matrixWorld=new Zt,this.matrixAutoUpdate=s.DEFAULT_MATRIX_AUTO_UPDATE,this.matrixWorldAutoUpdate=s.DEFAULT_MATRIX_WORLD_AUTO_UPDATE,this.matrixWorldNeedsUpdate=!1,this.layers=new Gi,this.visible=!0,this.castShadow=!1,this.receiveShadow=!1,this.frustumCulled=!0,this.renderOrder=0,this.animations=[],this.userData={}}onBeforeShadow(){}onAfterShadow(){}onBeforeRender(){}onAfterRender(){}applyMatrix4(t){this.matrixAutoUpdate&&this.updateMatrix(),this.matrix.premultiply(t),this.matrix.decompose(this.position,this.quaternion,this.scale)}applyQuaternion(t){return this.quaternion.premultiply(t),this}setRotationFromAxisAngle(t,e){this.quaternion.setFromAxisAngle(t,e)}setRotationFromEuler(t){this.quaternion.setFromEuler(t,!0)}setRotationFromMatrix(t){this.quaternion.setFromRotationMatrix(t)}setRotationFromQuaternion(t){this.quaternion.copy(t)}rotateOnAxis(t,e){return Zn.setFromAxisAngle(t,e),this.quaternion.multiply(Zn),this}rotateOnWorldAxis(t,e){return Zn.setFromAxisAngle(t,e),this.quaternion.premultiply(Zn),this}rotateX(t){return this.rotateOnAxis(Za,t)}rotateY(t){return this.rotateOnAxis(Ja,t)}rotateZ(t){return this.rotateOnAxis(Ka,t)}translateOnAxis(t,e){return Ya.copy(t).applyQuaternion(this.quaternion),this.position.add(Ya.multiplyScalar(e)),this}translateX(t){return this.translateOnAxis(Za,t)}translateY(t){return this.translateOnAxis(Ja,t)}translateZ(t){return this.translateOnAxis(Ka,t)}localToWorld(t){return this.updateWorldMatrix(!0,!1),t.applyMatrix4(this.matrixWorld)}worldToLocal(t){return this.updateWorldMatrix(!0,!1),t.applyMatrix4(Ze.copy(this.matrixWorld).invert())}lookAt(t,e,n){t.isVector3?us.copy(t):us.set(t,e,n);let i=this.parent;this.updateWorldMatrix(!0,!1),Ii.setFromMatrixPosition(this.matrixWorld),this.isCamera||this.isLight?Ze.lookAt(Ii,us,this.up):Ze.lookAt(us,Ii,this.up),this.quaternion.setFromRotationMatrix(Ze),i&&(Ze.extractRotation(i.matrixWorld),Zn.setFromRotationMatrix(Ze),this.quaternion.premultiply(Zn.invert()))}add(t){if(arguments.length>1){for(let e=0;e<arguments.length;e++)this.add(arguments[e]);return this}return t===this?(console.error("THREE.Object3D.add: object can't be added as a child of itself.",t),this):(t&&t.isObject3D?(t.parent!==null&&t.parent.remove(t),t.parent=this,this.children.push(t),t.dispatchEvent(Nh)):console.error("THREE.Object3D.add: object not an instance of THREE.Object3D.",t),this)}remove(t){if(arguments.length>1){for(let n=0;n<arguments.length;n++)this.remove(arguments[n]);return this}let e=this.children.indexOf(t);return e!==-1&&(t.parent=null,this.children.splice(e,1),t.dispatchEvent(Fh)),this}removeFromParent(){let t=this.parent;return t!==null&&t.remove(this),this}clear(){return this.remove(...this.children)}attach(t){return this.updateWorldMatrix(!0,!1),Ze.copy(this.matrixWorld).invert(),t.parent!==null&&(t.parent.updateWorldMatrix(!0,!1),Ze.multiply(t.parent.matrixWorld)),t.applyMatrix4(Ze),this.add(t),t.updateWorldMatrix(!1,!0),this}getObjectById(t){return this.getObjectByProperty("id",t)}getObjectByName(t){return this.getObjectByProperty("name",t)}getObjectByProperty(t,e){if(this[t]===e)return this;for(let n=0,i=this.children.length;n<i;n++){let o=this.children[n].getObjectByProperty(t,e);if(o!==void 0)return o}}getObjectsByProperty(t,e,n=[]){this[t]===e&&n.push(this);let i=this.children;for(let r=0,o=i.length;r<o;r++)i[r].getObjectsByProperty(t,e,n);return n}getWorldPosition(t){return this.updateWorldMatrix(!0,!1),t.setFromMatrixPosition(this.matrixWorld)}getWorldQuaternion(t){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(Ii,t,Dh),t}getWorldScale(t){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(Ii,Uh,t),t}getWorldDirection(t){this.updateWorldMatrix(!0,!1);let e=this.matrixWorld.elements;return t.set(e[8],e[9],e[10]).normalize()}raycast(){}traverse(t){t(this);let e=this.children;for(let n=0,i=e.length;n<i;n++)e[n].traverse(t)}traverseVisible(t){if(this.visible===!1)return;t(this);let e=this.children;for(let n=0,i=e.length;n<i;n++)e[n].traverseVisible(t)}traverseAncestors(t){let e=this.parent;e!==null&&(t(e),e.traverseAncestors(t))}updateMatrix(){this.matrix.compose(this.position,this.quaternion,this.scale),this.matrixWorldNeedsUpdate=!0}updateMatrixWorld(t){this.matrixAutoUpdate&&this.updateMatrix(),(this.matrixWorldNeedsUpdate||t)&&(this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix),this.matrixWorldNeedsUpdate=!1,t=!0);let e=this.children;for(let n=0,i=e.length;n<i;n++){let r=e[n];(r.matrixWorldAutoUpdate===!0||t===!0)&&r.updateMatrixWorld(t)}}updateWorldMatrix(t,e){let n=this.parent;if(t===!0&&n!==null&&n.matrixWorldAutoUpdate===!0&&n.updateWorldMatrix(!0,!1),this.matrixAutoUpdate&&this.updateMatrix(),this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix),e===!0){let i=this.children;for(let r=0,o=i.length;r<o;r++){let a=i[r];a.matrixWorldAutoUpdate===!0&&a.updateWorldMatrix(!1,!0)}}}toJSON(t){let e=t===void 0||typeof t=="string",n={};e&&(t={geometries:{},materials:{},textures:{},images:{},shapes:{},skeletons:{},animations:{},nodes:{}},n.metadata={version:4.6,type:"Object",generator:"Object3D.toJSON"});let i={};i.uuid=this.uuid,i.type=this.type,this.name!==""&&(i.name=this.name),this.castShadow===!0&&(i.castShadow=!0),this.receiveShadow===!0&&(i.receiveShadow=!0),this.visible===!1&&(i.visible=!1),this.frustumCulled===!1&&(i.frustumCulled=!1),this.renderOrder!==0&&(i.renderOrder=this.renderOrder),Object.keys(this.userData).length>0&&(i.userData=this.userData),i.layers=this.layers.mask,i.matrix=this.matrix.toArray(),i.up=this.up.toArray(),this.matrixAutoUpdate===!1&&(i.matrixAutoUpdate=!1),this.isInstancedMesh&&(i.type="InstancedMesh",i.count=this.count,i.instanceMatrix=this.instanceMatrix.toJSON(),this.instanceColor!==null&&(i.instanceColor=this.instanceColor.toJSON())),this.isBatchedMesh&&(i.type="BatchedMesh",i.perObjectFrustumCulled=this.perObjectFrustumCulled,i.sortObjects=this.sortObjects,i.drawRanges=this._drawRanges,i.reservedRanges=this._reservedRanges,i.visibility=this._visibility,i.active=this._active,i.bounds=this._bounds.map(a=>({boxInitialized:a.boxInitialized,boxMin:a.box.min.toArray(),boxMax:a.box.max.toArray(),sphereInitialized:a.sphereInitialized,sphereRadius:a.sphere.radius,sphereCenter:a.sphere.center.toArray()})),i.maxGeometryCount=this._maxGeometryCount,i.maxVertexCount=this._maxVertexCount,i.maxIndexCount=this._maxIndexCount,i.geometryInitialized=this._geometryInitialized,i.geometryCount=this._geometryCount,i.matricesTexture=this._matricesTexture.toJSON(t),this.boundingSphere!==null&&(i.boundingSphere={center:i.boundingSphere.center.toArray(),radius:i.boundingSphere.radius}),this.boundingBox!==null&&(i.boundingBox={min:i.boundingBox.min.toArray(),max:i.boundingBox.max.toArray()}));function r(a,c){return a[c.uuid]===void 0&&(a[c.uuid]=c.toJSON(t)),c.uuid}if(this.isScene)this.background&&(this.background.isColor?i.background=this.background.toJSON():this.background.isTexture&&(i.background=this.background.toJSON(t).uuid)),this.environment&&this.environment.isTexture&&this.environment.isRenderTargetTexture!==!0&&(i.environment=this.environment.toJSON(t).uuid);else if(this.isMesh||this.isLine||this.isPoints){i.geometry=r(t.geometries,this.geometry);let a=this.geometry.parameters;if(a!==void 0&&a.shapes!==void 0){let c=a.shapes;if(Array.isArray(c))for(let l=0,h=c.length;l<h;l++){let u=c[l];r(t.shapes,u)}else r(t.shapes,c)}}if(this.isSkinnedMesh&&(i.bindMode=this.bindMode,i.bindMatrix=this.bindMatrix.toArray(),this.skeleton!==void 0&&(r(t.skeletons,this.skeleton),i.skeleton=this.skeleton.uuid)),this.material!==void 0)if(Array.isArray(this.material)){let a=[];for(let c=0,l=this.material.length;c<l;c++)a.push(r(t.materials,this.material[c]));i.material=a}else i.material=r(t.materials,this.material);if(this.children.length>0){i.children=[];for(let a=0;a<this.children.length;a++)i.children.push(this.children[a].toJSON(t).object)}if(this.animations.length>0){i.animations=[];for(let a=0;a<this.animations.length;a++){let c=this.animations[a];i.animations.push(r(t.animations,c))}}if(e){let a=o(t.geometries),c=o(t.materials),l=o(t.textures),h=o(t.images),u=o(t.shapes),d=o(t.skeletons),m=o(t.animations),v=o(t.nodes);a.length>0&&(n.geometries=a),c.length>0&&(n.materials=c),l.length>0&&(n.textures=l),h.length>0&&(n.images=h),u.length>0&&(n.shapes=u),d.length>0&&(n.skeletons=d),m.length>0&&(n.animations=m),v.length>0&&(n.nodes=v)}return n.object=i,n;function o(a){let c=[];for(let l in a){let h=a[l];delete h.metadata,c.push(h)}return c}}clone(t){return new this.constructor().copy(this,t)}copy(t,e=!0){if(this.name=t.name,this.up.copy(t.up),this.position.copy(t.position),this.rotation.order=t.rotation.order,this.quaternion.copy(t.quaternion),this.scale.copy(t.scale),this.matrix.copy(t.matrix),this.matrixWorld.copy(t.matrixWorld),this.matrixAutoUpdate=t.matrixAutoUpdate,this.matrixWorldAutoUpdate=t.matrixWorldAutoUpdate,this.matrixWorldNeedsUpdate=t.matrixWorldNeedsUpdate,this.layers.mask=t.layers.mask,this.visible=t.visible,this.castShadow=t.castShadow,this.receiveShadow=t.receiveShadow,this.frustumCulled=t.frustumCulled,this.renderOrder=t.renderOrder,this.animations=t.animations.slice(),this.userData=JSON.parse(JSON.stringify(t.userData)),e===!0)for(let n=0;n<t.children.length;n++){let i=t.children[n];this.add(i.clone())}return this}};fe.DEFAULT_UP=new L(0,1,0);fe.DEFAULT_MATRIX_AUTO_UPDATE=!0;fe.DEFAULT_MATRIX_WORLD_AUTO_UPDATE=!0;var ze=new L,Je=new L,Or=new L,Ke=new L,Jn=new L,Kn=new L,$a=new L,Br=new L,zr=new L,kr=new L,ds=!1,Un=class s{constructor(t=new L,e=new L,n=new L){this.a=t,this.b=e,this.c=n}static getNormal(t,e,n,i){i.subVectors(n,e),ze.subVectors(t,e),i.cross(ze);let r=i.lengthSq();return r>0?i.multiplyScalar(1/Math.sqrt(r)):i.set(0,0,0)}static getBarycoord(t,e,n,i,r){ze.subVectors(i,e),Je.subVectors(n,e),Or.subVectors(t,e);let o=ze.dot(ze),a=ze.dot(Je),c=ze.dot(Or),l=Je.dot(Je),h=Je.dot(Or),u=o*l-a*a;if(u===0)return r.set(0,0,0),null;let d=1/u,m=(l*c-a*h)*d,v=(o*h-a*c)*d;return r.set(1-m-v,v,m)}static containsPoint(t,e,n,i){return this.getBarycoord(t,e,n,i,Ke)===null?!1:Ke.x>=0&&Ke.y>=0&&Ke.x+Ke.y<=1}static getUV(t,e,n,i,r,o,a,c){return ds===!1&&(console.warn("THREE.Triangle.getUV() has been renamed to THREE.Triangle.getInterpolation()."),ds=!0),this.getInterpolation(t,e,n,i,r,o,a,c)}static getInterpolation(t,e,n,i,r,o,a,c){return this.getBarycoord(t,e,n,i,Ke)===null?(c.x=0,c.y=0,"z"in c&&(c.z=0),"w"in c&&(c.w=0),null):(c.setScalar(0),c.addScaledVector(r,Ke.x),c.addScaledVector(o,Ke.y),c.addScaledVector(a,Ke.z),c)}static isFrontFacing(t,e,n,i){return ze.subVectors(n,e),Je.subVectors(t,e),ze.cross(Je).dot(i)<0}set(t,e,n){return this.a.copy(t),this.b.copy(e),this.c.copy(n),this}setFromPointsAndIndices(t,e,n,i){return this.a.copy(t[e]),this.b.copy(t[n]),this.c.copy(t[i]),this}setFromAttributeAndIndices(t,e,n,i){return this.a.fromBufferAttribute(t,e),this.b.fromBufferAttribute(t,n),this.c.fromBufferAttribute(t,i),this}clone(){return new this.constructor().copy(this)}copy(t){return this.a.copy(t.a),this.b.copy(t.b),this.c.copy(t.c),this}getArea(){return ze.subVectors(this.c,this.b),Je.subVectors(this.a,this.b),ze.cross(Je).length()*.5}getMidpoint(t){return t.addVectors(this.a,this.b).add(this.c).multiplyScalar(1/3)}getNormal(t){return s.getNormal(this.a,this.b,this.c,t)}getPlane(t){return t.setFromCoplanarPoints(this.a,this.b,this.c)}getBarycoord(t,e){return s.getBarycoord(t,this.a,this.b,this.c,e)}getUV(t,e,n,i,r){return ds===!1&&(console.warn("THREE.Triangle.getUV() has been renamed to THREE.Triangle.getInterpolation()."),ds=!0),s.getInterpolation(t,this.a,this.b,this.c,e,n,i,r)}getInterpolation(t,e,n,i,r){return s.getInterpolation(t,this.a,this.b,this.c,e,n,i,r)}containsPoint(t){return s.containsPoint(t,this.a,this.b,this.c)}isFrontFacing(t){return s.isFrontFacing(this.a,this.b,this.c,t)}intersectsBox(t){return t.intersectsTriangle(this)}closestPointToPoint(t,e){let n=this.a,i=this.b,r=this.c,o,a;Jn.subVectors(i,n),Kn.subVectors(r,n),Br.subVectors(t,n);let c=Jn.dot(Br),l=Kn.dot(Br);if(c<=0&&l<=0)return e.copy(n);zr.subVectors(t,i);let h=Jn.dot(zr),u=Kn.dot(zr);if(h>=0&&u<=h)return e.copy(i);let d=c*u-h*l;if(d<=0&&c>=0&&h<=0)return o=c/(c-h),e.copy(n).addScaledVector(Jn,o);kr.subVectors(t,r);let m=Jn.dot(kr),v=Kn.dot(kr);if(v>=0&&m<=v)return e.copy(r);let x=m*l-c*v;if(x<=0&&l>=0&&v<=0)return a=l/(l-v),e.copy(n).addScaledVector(Kn,a);let p=h*v-m*u;if(p<=0&&u-h>=0&&m-v>=0)return $a.subVectors(r,i),a=(u-h)/(u-h+(m-v)),e.copy(i).addScaledVector($a,a);let f=1/(p+x+d);return o=x*f,a=d*f,e.copy(n).addScaledVector(Jn,o).addScaledVector(Kn,a)}equals(t){return t.a.equals(this.a)&&t.b.equals(this.b)&&t.c.equals(this.c)}},Jc={aliceblue:15792383,antiquewhite:16444375,aqua:65535,aquamarine:8388564,azure:15794175,beige:16119260,bisque:16770244,black:0,blanchedalmond:16772045,blue:255,blueviolet:9055202,brown:10824234,burlywood:14596231,cadetblue:6266528,chartreuse:8388352,chocolate:13789470,coral:16744272,cornflowerblue:6591981,cornsilk:16775388,crimson:14423100,cyan:65535,darkblue:139,darkcyan:35723,darkgoldenrod:12092939,darkgray:11119017,darkgreen:25600,darkgrey:11119017,darkkhaki:12433259,darkmagenta:9109643,darkolivegreen:5597999,darkorange:16747520,darkorchid:10040012,darkred:9109504,darksalmon:15308410,darkseagreen:9419919,darkslateblue:4734347,darkslategray:3100495,darkslategrey:3100495,darkturquoise:52945,darkviolet:9699539,deeppink:16716947,deepskyblue:49151,dimgray:6908265,dimgrey:6908265,dodgerblue:2003199,firebrick:11674146,floralwhite:16775920,forestgreen:2263842,fuchsia:16711935,gainsboro:14474460,ghostwhite:16316671,gold:16766720,goldenrod:14329120,gray:8421504,green:32768,greenyellow:11403055,grey:8421504,honeydew:15794160,hotpink:16738740,indianred:13458524,indigo:4915330,ivory:16777200,khaki:15787660,lavender:15132410,lavenderblush:16773365,lawngreen:8190976,lemonchiffon:16775885,lightblue:11393254,lightcoral:15761536,lightcyan:14745599,lightgoldenrodyellow:16448210,lightgray:13882323,lightgreen:9498256,lightgrey:13882323,lightpink:16758465,lightsalmon:16752762,lightseagreen:2142890,lightskyblue:8900346,lightslategray:7833753,lightslategrey:7833753,lightsteelblue:11584734,lightyellow:16777184,lime:65280,limegreen:3329330,linen:16445670,magenta:16711935,maroon:8388608,mediumaquamarine:6737322,mediumblue:205,mediumorchid:12211667,mediumpurple:9662683,mediumseagreen:3978097,mediumslateblue:8087790,mediumspringgreen:64154,mediumturquoise:4772300,mediumvioletred:13047173,midnightblue:1644912,mintcream:16121850,mistyrose:16770273,moccasin:16770229,navajowhite:16768685,navy:128,oldlace:16643558,olive:8421376,olivedrab:7048739,orange:16753920,orangered:16729344,orchid:14315734,palegoldenrod:15657130,palegreen:10025880,paleturquoise:11529966,palevioletred:14381203,papayawhip:16773077,peachpuff:16767673,peru:13468991,pink:16761035,plum:14524637,powderblue:11591910,purple:8388736,rebeccapurple:6697881,red:16711680,rosybrown:12357519,royalblue:4286945,saddlebrown:9127187,salmon:16416882,sandybrown:16032864,seagreen:3050327,seashell:16774638,sienna:10506797,silver:12632256,skyblue:8900331,slateblue:6970061,slategray:7372944,slategrey:7372944,snow:16775930,springgreen:65407,steelblue:4620980,tan:13808780,teal:32896,thistle:14204888,tomato:16737095,turquoise:4251856,violet:15631086,wheat:16113331,white:16777215,whitesmoke:16119285,yellow:16776960,yellowgreen:10145074},fn={h:0,s:0,l:0},fs={h:0,s:0,l:0};function Vr(s,t,e){return e<0&&(e+=1),e>1&&(e-=1),e<1/6?s+(t-s)*6*e:e<1/2?t:e<2/3?s+(t-s)*6*(2/3-e):s}var zt=class{constructor(t,e,n){return this.isColor=!0,this.r=1,this.g=1,this.b=1,this.set(t,e,n)}set(t,e,n){if(e===void 0&&n===void 0){let i=t;i&&i.isColor?this.copy(i):typeof i=="number"?this.setHex(i):typeof i=="string"&&this.setStyle(i)}else this.setRGB(t,e,n);return this}setScalar(t){return this.r=t,this.g=t,this.b=t,this}setHex(t,e=oe){return t=Math.floor(t),this.r=(t>>16&255)/255,this.g=(t>>8&255)/255,this.b=(t&255)/255,qt.toWorkingColorSpace(this,e),this}setRGB(t,e,n,i=qt.workingColorSpace){return this.r=t,this.g=e,this.b=n,qt.toWorkingColorSpace(this,i),this}setHSL(t,e,n,i=qt.workingColorSpace){if(t=wh(t,1),e=we(e,0,1),n=we(n,0,1),e===0)this.r=this.g=this.b=n;else{let r=n<=.5?n*(1+e):n+e-n*e,o=2*n-r;this.r=Vr(o,r,t+1/3),this.g=Vr(o,r,t),this.b=Vr(o,r,t-1/3)}return qt.toWorkingColorSpace(this,i),this}setStyle(t,e=oe){function n(r){r!==void 0&&parseFloat(r)<1&&console.warn("THREE.Color: Alpha component of "+t+" will be ignored.")}let i;if(i=/^(\w+)\(([^\)]*)\)/.exec(t)){let r,o=i[1],a=i[2];switch(o){case"rgb":case"rgba":if(r=/^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return n(r[4]),this.setRGB(Math.min(255,parseInt(r[1],10))/255,Math.min(255,parseInt(r[2],10))/255,Math.min(255,parseInt(r[3],10))/255,e);if(r=/^\s*(\d+)\%\s*,\s*(\d+)\%\s*,\s*(\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return n(r[4]),this.setRGB(Math.min(100,parseInt(r[1],10))/100,Math.min(100,parseInt(r[2],10))/100,Math.min(100,parseInt(r[3],10))/100,e);break;case"hsl":case"hsla":if(r=/^\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\%\s*,\s*(\d*\.?\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return n(r[4]),this.setHSL(parseFloat(r[1])/360,parseFloat(r[2])/100,parseFloat(r[3])/100,e);break;default:console.warn("THREE.Color: Unknown color model "+t)}}else if(i=/^\#([A-Fa-f\d]+)$/.exec(t)){let r=i[1],o=r.length;if(o===3)return this.setRGB(parseInt(r.charAt(0),16)/15,parseInt(r.charAt(1),16)/15,parseInt(r.charAt(2),16)/15,e);if(o===6)return this.setHex(parseInt(r,16),e);console.warn("THREE.Color: Invalid hex color "+t)}else if(t&&t.length>0)return this.setColorName(t,e);return this}setColorName(t,e=oe){let n=Jc[t.toLowerCase()];return n!==void 0?this.setHex(n,e):console.warn("THREE.Color: Unknown color "+t),this}clone(){return new this.constructor(this.r,this.g,this.b)}copy(t){return this.r=t.r,this.g=t.g,this.b=t.b,this}copySRGBToLinear(t){return this.r=fi(t.r),this.g=fi(t.g),this.b=fi(t.b),this}copyLinearToSRGB(t){return this.r=Rr(t.r),this.g=Rr(t.g),this.b=Rr(t.b),this}convertSRGBToLinear(){return this.copySRGBToLinear(this),this}convertLinearToSRGB(){return this.copyLinearToSRGB(this),this}getHex(t=oe){return qt.fromWorkingColorSpace(_e.copy(this),t),Math.round(we(_e.r*255,0,255))*65536+Math.round(we(_e.g*255,0,255))*256+Math.round(we(_e.b*255,0,255))}getHexString(t=oe){return("000000"+this.getHex(t).toString(16)).slice(-6)}getHSL(t,e=qt.workingColorSpace){qt.fromWorkingColorSpace(_e.copy(this),e);let n=_e.r,i=_e.g,r=_e.b,o=Math.max(n,i,r),a=Math.min(n,i,r),c,l,h=(a+o)/2;if(a===o)c=0,l=0;else{let u=o-a;switch(l=h<=.5?u/(o+a):u/(2-o-a),o){case n:c=(i-r)/u+(i<r?6:0);break;case i:c=(r-n)/u+2;break;case r:c=(n-i)/u+4;break}c/=6}return t.h=c,t.s=l,t.l=h,t}getRGB(t,e=qt.workingColorSpace){return qt.fromWorkingColorSpace(_e.copy(this),e),t.r=_e.r,t.g=_e.g,t.b=_e.b,t}getStyle(t=oe){qt.fromWorkingColorSpace(_e.copy(this),t);let e=_e.r,n=_e.g,i=_e.b;return t!==oe?`color(${t} ${e.toFixed(3)} ${n.toFixed(3)} ${i.toFixed(3)})`:`rgb(${Math.round(e*255)},${Math.round(n*255)},${Math.round(i*255)})`}offsetHSL(t,e,n){return this.getHSL(fn),this.setHSL(fn.h+t,fn.s+e,fn.l+n)}add(t){return this.r+=t.r,this.g+=t.g,this.b+=t.b,this}addColors(t,e){return this.r=t.r+e.r,this.g=t.g+e.g,this.b=t.b+e.b,this}addScalar(t){return this.r+=t,this.g+=t,this.b+=t,this}sub(t){return this.r=Math.max(0,this.r-t.r),this.g=Math.max(0,this.g-t.g),this.b=Math.max(0,this.b-t.b),this}multiply(t){return this.r*=t.r,this.g*=t.g,this.b*=t.b,this}multiplyScalar(t){return this.r*=t,this.g*=t,this.b*=t,this}lerp(t,e){return this.r+=(t.r-this.r)*e,this.g+=(t.g-this.g)*e,this.b+=(t.b-this.b)*e,this}lerpColors(t,e,n){return this.r=t.r+(e.r-t.r)*n,this.g=t.g+(e.g-t.g)*n,this.b=t.b+(e.b-t.b)*n,this}lerpHSL(t,e){this.getHSL(fn),t.getHSL(fs);let n=Tr(fn.h,fs.h,e),i=Tr(fn.s,fs.s,e),r=Tr(fn.l,fs.l,e);return this.setHSL(n,i,r),this}setFromVector3(t){return this.r=t.x,this.g=t.y,this.b=t.z,this}applyMatrix3(t){let e=this.r,n=this.g,i=this.b,r=t.elements;return this.r=r[0]*e+r[3]*n+r[6]*i,this.g=r[1]*e+r[4]*n+r[7]*i,this.b=r[2]*e+r[5]*n+r[8]*i,this}equals(t){return t.r===this.r&&t.g===this.g&&t.b===this.b}fromArray(t,e=0){return this.r=t[e],this.g=t[e+1],this.b=t[e+2],this}toArray(t=[],e=0){return t[e]=this.r,t[e+1]=this.g,t[e+2]=this.b,t}fromBufferAttribute(t,e){return this.r=t.getX(e),this.g=t.getY(e),this.b=t.getZ(e),this}toJSON(){return this.getHex()}*[Symbol.iterator](){yield this.r,yield this.g,yield this.b}},_e=new zt;zt.NAMES=Jc;var Oh=0,an=class extends Mn{constructor(){super(),this.isMaterial=!0,Object.defineProperty(this,"id",{value:Oh++}),this.uuid=xn(),this.name="",this.type="Material",this.blending=di,this.side=yn,this.vertexColors=!1,this.opacity=1,this.transparent=!1,this.alphaHash=!1,this.blendSrc=jr,this.blendDst=Qr,this.blendEquation=In,this.blendSrcAlpha=null,this.blendDstAlpha=null,this.blendEquationAlpha=null,this.blendColor=new zt(0,0,0),this.blendAlpha=0,this.depthFunc=Us,this.depthTest=!0,this.depthWrite=!0,this.stencilWriteMask=255,this.stencilFunc=Ba,this.stencilRef=0,this.stencilFuncMask=255,this.stencilFail=Hn,this.stencilZFail=Hn,this.stencilZPass=Hn,this.stencilWrite=!1,this.clippingPlanes=null,this.clipIntersection=!1,this.clipShadows=!1,this.shadowSide=null,this.colorWrite=!0,this.precision=null,this.polygonOffset=!1,this.polygonOffsetFactor=0,this.polygonOffsetUnits=0,this.dithering=!1,this.alphaToCoverage=!1,this.premultipliedAlpha=!1,this.forceSinglePass=!1,this.visible=!0,this.toneMapped=!0,this.userData={},this.version=0,this._alphaTest=0}get alphaTest(){return this._alphaTest}set alphaTest(t){this._alphaTest>0!=t>0&&this.version++,this._alphaTest=t}onBuild(){}onBeforeRender(){}onBeforeCompile(){}customProgramCacheKey(){return this.onBeforeCompile.toString()}setValues(t){if(t!==void 0)for(let e in t){let n=t[e];if(n===void 0){console.warn(`THREE.Material: parameter '${e}' has value of undefined.`);continue}let i=this[e];if(i===void 0){console.warn(`THREE.Material: '${e}' is not a property of THREE.${this.type}.`);continue}i&&i.isColor?i.set(n):i&&i.isVector3&&n&&n.isVector3?i.copy(n):this[e]=n}}toJSON(t){let e=t===void 0||typeof t=="string";e&&(t={textures:{},images:{}});let n={metadata:{version:4.6,type:"Material",generator:"Material.toJSON"}};n.uuid=this.uuid,n.type=this.type,this.name!==""&&(n.name=this.name),this.color&&this.color.isColor&&(n.color=this.color.getHex()),this.roughness!==void 0&&(n.roughness=this.roughness),this.metalness!==void 0&&(n.metalness=this.metalness),this.sheen!==void 0&&(n.sheen=this.sheen),this.sheenColor&&this.sheenColor.isColor&&(n.sheenColor=this.sheenColor.getHex()),this.sheenRoughness!==void 0&&(n.sheenRoughness=this.sheenRoughness),this.emissive&&this.emissive.isColor&&(n.emissive=this.emissive.getHex()),this.emissiveIntensity&&this.emissiveIntensity!==1&&(n.emissiveIntensity=this.emissiveIntensity),this.specular&&this.specular.isColor&&(n.specular=this.specular.getHex()),this.specularIntensity!==void 0&&(n.specularIntensity=this.specularIntensity),this.specularColor&&this.specularColor.isColor&&(n.specularColor=this.specularColor.getHex()),this.shininess!==void 0&&(n.shininess=this.shininess),this.clearcoat!==void 0&&(n.clearcoat=this.clearcoat),this.clearcoatRoughness!==void 0&&(n.clearcoatRoughness=this.clearcoatRoughness),this.clearcoatMap&&this.clearcoatMap.isTexture&&(n.clearcoatMap=this.clearcoatMap.toJSON(t).uuid),this.clearcoatRoughnessMap&&this.clearcoatRoughnessMap.isTexture&&(n.clearcoatRoughnessMap=this.clearcoatRoughnessMap.toJSON(t).uuid),this.clearcoatNormalMap&&this.clearcoatNormalMap.isTexture&&(n.clearcoatNormalMap=this.clearcoatNormalMap.toJSON(t).uuid,n.clearcoatNormalScale=this.clearcoatNormalScale.toArray()),this.iridescence!==void 0&&(n.iridescence=this.iridescence),this.iridescenceIOR!==void 0&&(n.iridescenceIOR=this.iridescenceIOR),this.iridescenceThicknessRange!==void 0&&(n.iridescenceThicknessRange=this.iridescenceThicknessRange),this.iridescenceMap&&this.iridescenceMap.isTexture&&(n.iridescenceMap=this.iridescenceMap.toJSON(t).uuid),this.iridescenceThicknessMap&&this.iridescenceThicknessMap.isTexture&&(n.iridescenceThicknessMap=this.iridescenceThicknessMap.toJSON(t).uuid),this.anisotropy!==void 0&&(n.anisotropy=this.anisotropy),this.anisotropyRotation!==void 0&&(n.anisotropyRotation=this.anisotropyRotation),this.anisotropyMap&&this.anisotropyMap.isTexture&&(n.anisotropyMap=this.anisotropyMap.toJSON(t).uuid),this.map&&this.map.isTexture&&(n.map=this.map.toJSON(t).uuid),this.matcap&&this.matcap.isTexture&&(n.matcap=this.matcap.toJSON(t).uuid),this.alphaMap&&this.alphaMap.isTexture&&(n.alphaMap=this.alphaMap.toJSON(t).uuid),this.lightMap&&this.lightMap.isTexture&&(n.lightMap=this.lightMap.toJSON(t).uuid,n.lightMapIntensity=this.lightMapIntensity),this.aoMap&&this.aoMap.isTexture&&(n.aoMap=this.aoMap.toJSON(t).uuid,n.aoMapIntensity=this.aoMapIntensity),this.bumpMap&&this.bumpMap.isTexture&&(n.bumpMap=this.bumpMap.toJSON(t).uuid,n.bumpScale=this.bumpScale),this.normalMap&&this.normalMap.isTexture&&(n.normalMap=this.normalMap.toJSON(t).uuid,n.normalMapType=this.normalMapType,n.normalScale=this.normalScale.toArray()),this.displacementMap&&this.displacementMap.isTexture&&(n.displacementMap=this.displacementMap.toJSON(t).uuid,n.displacementScale=this.displacementScale,n.displacementBias=this.displacementBias),this.roughnessMap&&this.roughnessMap.isTexture&&(n.roughnessMap=this.roughnessMap.toJSON(t).uuid),this.metalnessMap&&this.metalnessMap.isTexture&&(n.metalnessMap=this.metalnessMap.toJSON(t).uuid),this.emissiveMap&&this.emissiveMap.isTexture&&(n.emissiveMap=this.emissiveMap.toJSON(t).uuid),this.specularMap&&this.specularMap.isTexture&&(n.specularMap=this.specularMap.toJSON(t).uuid),this.specularIntensityMap&&this.specularIntensityMap.isTexture&&(n.specularIntensityMap=this.specularIntensityMap.toJSON(t).uuid),this.specularColorMap&&this.specularColorMap.isTexture&&(n.specularColorMap=this.specularColorMap.toJSON(t).uuid),this.envMap&&this.envMap.isTexture&&(n.envMap=this.envMap.toJSON(t).uuid,this.combine!==void 0&&(n.combine=this.combine)),this.envMapIntensity!==void 0&&(n.envMapIntensity=this.envMapIntensity),this.reflectivity!==void 0&&(n.reflectivity=this.reflectivity),this.refractionRatio!==void 0&&(n.refractionRatio=this.refractionRatio),this.gradientMap&&this.gradientMap.isTexture&&(n.gradientMap=this.gradientMap.toJSON(t).uuid),this.transmission!==void 0&&(n.transmission=this.transmission),this.transmissionMap&&this.transmissionMap.isTexture&&(n.transmissionMap=this.transmissionMap.toJSON(t).uuid),this.thickness!==void 0&&(n.thickness=this.thickness),this.thicknessMap&&this.thicknessMap.isTexture&&(n.thicknessMap=this.thicknessMap.toJSON(t).uuid),this.attenuationDistance!==void 0&&this.attenuationDistance!==1/0&&(n.attenuationDistance=this.attenuationDistance),this.attenuationColor!==void 0&&(n.attenuationColor=this.attenuationColor.getHex()),this.size!==void 0&&(n.size=this.size),this.shadowSide!==null&&(n.shadowSide=this.shadowSide),this.sizeAttenuation!==void 0&&(n.sizeAttenuation=this.sizeAttenuation),this.blending!==di&&(n.blending=this.blending),this.side!==yn&&(n.side=this.side),this.vertexColors===!0&&(n.vertexColors=!0),this.opacity<1&&(n.opacity=this.opacity),this.transparent===!0&&(n.transparent=!0),this.blendSrc!==jr&&(n.blendSrc=this.blendSrc),this.blendDst!==Qr&&(n.blendDst=this.blendDst),this.blendEquation!==In&&(n.blendEquation=this.blendEquation),this.blendSrcAlpha!==null&&(n.blendSrcAlpha=this.blendSrcAlpha),this.blendDstAlpha!==null&&(n.blendDstAlpha=this.blendDstAlpha),this.blendEquationAlpha!==null&&(n.blendEquationAlpha=this.blendEquationAlpha),this.blendColor&&this.blendColor.isColor&&(n.blendColor=this.blendColor.getHex()),this.blendAlpha!==0&&(n.blendAlpha=this.blendAlpha),this.depthFunc!==Us&&(n.depthFunc=this.depthFunc),this.depthTest===!1&&(n.depthTest=this.depthTest),this.depthWrite===!1&&(n.depthWrite=this.depthWrite),this.colorWrite===!1&&(n.colorWrite=this.colorWrite),this.stencilWriteMask!==255&&(n.stencilWriteMask=this.stencilWriteMask),this.stencilFunc!==Ba&&(n.stencilFunc=this.stencilFunc),this.stencilRef!==0&&(n.stencilRef=this.stencilRef),this.stencilFuncMask!==255&&(n.stencilFuncMask=this.stencilFuncMask),this.stencilFail!==Hn&&(n.stencilFail=this.stencilFail),this.stencilZFail!==Hn&&(n.stencilZFail=this.stencilZFail),this.stencilZPass!==Hn&&(n.stencilZPass=this.stencilZPass),this.stencilWrite===!0&&(n.stencilWrite=this.stencilWrite),this.rotation!==void 0&&this.rotation!==0&&(n.rotation=this.rotation),this.polygonOffset===!0&&(n.polygonOffset=!0),this.polygonOffsetFactor!==0&&(n.polygonOffsetFactor=this.polygonOffsetFactor),this.polygonOffsetUnits!==0&&(n.polygonOffsetUnits=this.polygonOffsetUnits),this.linewidth!==void 0&&this.linewidth!==1&&(n.linewidth=this.linewidth),this.dashSize!==void 0&&(n.dashSize=this.dashSize),this.gapSize!==void 0&&(n.gapSize=this.gapSize),this.scale!==void 0&&(n.scale=this.scale),this.dithering===!0&&(n.dithering=!0),this.alphaTest>0&&(n.alphaTest=this.alphaTest),this.alphaHash===!0&&(n.alphaHash=!0),this.alphaToCoverage===!0&&(n.alphaToCoverage=!0),this.premultipliedAlpha===!0&&(n.premultipliedAlpha=!0),this.forceSinglePass===!0&&(n.forceSinglePass=!0),this.wireframe===!0&&(n.wireframe=!0),this.wireframeLinewidth>1&&(n.wireframeLinewidth=this.wireframeLinewidth),this.wireframeLinecap!=="round"&&(n.wireframeLinecap=this.wireframeLinecap),this.wireframeLinejoin!=="round"&&(n.wireframeLinejoin=this.wireframeLinejoin),this.flatShading===!0&&(n.flatShading=!0),this.visible===!1&&(n.visible=!1),this.toneMapped===!1&&(n.toneMapped=!1),this.fog===!1&&(n.fog=!1),Object.keys(this.userData).length>0&&(n.userData=this.userData);function i(r){let o=[];for(let a in r){let c=r[a];delete c.metadata,o.push(c)}return o}if(e){let r=i(t.textures),o=i(t.images);r.length>0&&(n.textures=r),o.length>0&&(n.images=o)}return n}clone(){return new this.constructor().copy(this)}copy(t){this.name=t.name,this.blending=t.blending,this.side=t.side,this.vertexColors=t.vertexColors,this.opacity=t.opacity,this.transparent=t.transparent,this.blendSrc=t.blendSrc,this.blendDst=t.blendDst,this.blendEquation=t.blendEquation,this.blendSrcAlpha=t.blendSrcAlpha,this.blendDstAlpha=t.blendDstAlpha,this.blendEquationAlpha=t.blendEquationAlpha,this.blendColor.copy(t.blendColor),this.blendAlpha=t.blendAlpha,this.depthFunc=t.depthFunc,this.depthTest=t.depthTest,this.depthWrite=t.depthWrite,this.stencilWriteMask=t.stencilWriteMask,this.stencilFunc=t.stencilFunc,this.stencilRef=t.stencilRef,this.stencilFuncMask=t.stencilFuncMask,this.stencilFail=t.stencilFail,this.stencilZFail=t.stencilZFail,this.stencilZPass=t.stencilZPass,this.stencilWrite=t.stencilWrite;let e=t.clippingPlanes,n=null;if(e!==null){let i=e.length;n=new Array(i);for(let r=0;r!==i;++r)n[r]=e[r].clone()}return this.clippingPlanes=n,this.clipIntersection=t.clipIntersection,this.clipShadows=t.clipShadows,this.shadowSide=t.shadowSide,this.colorWrite=t.colorWrite,this.precision=t.precision,this.polygonOffset=t.polygonOffset,this.polygonOffsetFactor=t.polygonOffsetFactor,this.polygonOffsetUnits=t.polygonOffsetUnits,this.dithering=t.dithering,this.alphaTest=t.alphaTest,this.alphaHash=t.alphaHash,this.alphaToCoverage=t.alphaToCoverage,this.premultipliedAlpha=t.premultipliedAlpha,this.forceSinglePass=t.forceSinglePass,this.visible=t.visible,this.toneMapped=t.toneMapped,this.userData=JSON.parse(JSON.stringify(t.userData)),this}dispose(){this.dispatchEvent({type:"dispose"})}set needsUpdate(t){t===!0&&this.version++}},xi=class extends an{constructor(t){super(),this.isMeshBasicMaterial=!0,this.type="MeshBasicMaterial",this.color=new zt(16777215),this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.combine=Oc,this.reflectivity=1,this.refractionRatio=.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.map=t.map,this.lightMap=t.lightMap,this.lightMapIntensity=t.lightMapIntensity,this.aoMap=t.aoMap,this.aoMapIntensity=t.aoMapIntensity,this.specularMap=t.specularMap,this.alphaMap=t.alphaMap,this.envMap=t.envMap,this.combine=t.combine,this.reflectivity=t.reflectivity,this.refractionRatio=t.refractionRatio,this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this.wireframeLinecap=t.wireframeLinecap,this.wireframeLinejoin=t.wireframeLinejoin,this.fog=t.fog,this}};var re=new L,ps=new Lt,ee=class{constructor(t,e,n=!1){if(Array.isArray(t))throw new TypeError("THREE.BufferAttribute: array should be a Typed Array.");this.isBufferAttribute=!0,this.name="",this.array=t,this.itemSize=e,this.count=t!==void 0?t.length/e:0,this.normalized=n,this.usage=so,this._updateRange={offset:0,count:-1},this.updateRanges=[],this.gpuType=mn,this.version=0}onUploadCallback(){}set needsUpdate(t){t===!0&&this.version++}get updateRange(){return console.warn("THREE.BufferAttribute: updateRange() is deprecated and will be removed in r169. Use addUpdateRange() instead."),this._updateRange}setUsage(t){return this.usage=t,this}addUpdateRange(t,e){this.updateRanges.push({start:t,count:e})}clearUpdateRanges(){this.updateRanges.length=0}copy(t){return this.name=t.name,this.array=new t.array.constructor(t.array),this.itemSize=t.itemSize,this.count=t.count,this.normalized=t.normalized,this.usage=t.usage,this.gpuType=t.gpuType,this}copyAt(t,e,n){t*=this.itemSize,n*=e.itemSize;for(let i=0,r=this.itemSize;i<r;i++)this.array[t+i]=e.array[n+i];return this}copyArray(t){return this.array.set(t),this}applyMatrix3(t){if(this.itemSize===2)for(let e=0,n=this.count;e<n;e++)ps.fromBufferAttribute(this,e),ps.applyMatrix3(t),this.setXY(e,ps.x,ps.y);else if(this.itemSize===3)for(let e=0,n=this.count;e<n;e++)re.fromBufferAttribute(this,e),re.applyMatrix3(t),this.setXYZ(e,re.x,re.y,re.z);return this}applyMatrix4(t){for(let e=0,n=this.count;e<n;e++)re.fromBufferAttribute(this,e),re.applyMatrix4(t),this.setXYZ(e,re.x,re.y,re.z);return this}applyNormalMatrix(t){for(let e=0,n=this.count;e<n;e++)re.fromBufferAttribute(this,e),re.applyNormalMatrix(t),this.setXYZ(e,re.x,re.y,re.z);return this}transformDirection(t){for(let e=0,n=this.count;e<n;e++)re.fromBufferAttribute(this,e),re.transformDirection(t),this.setXYZ(e,re.x,re.y,re.z);return this}set(t,e=0){return this.array.set(t,e),this}getComponent(t,e){let n=this.array[t*this.itemSize+e];return this.normalized&&(n=tn(n,this.array)),n}setComponent(t,e,n){return this.normalized&&(n=Yt(n,this.array)),this.array[t*this.itemSize+e]=n,this}getX(t){let e=this.array[t*this.itemSize];return this.normalized&&(e=tn(e,this.array)),e}setX(t,e){return this.normalized&&(e=Yt(e,this.array)),this.array[t*this.itemSize]=e,this}getY(t){let e=this.array[t*this.itemSize+1];return this.normalized&&(e=tn(e,this.array)),e}setY(t,e){return this.normalized&&(e=Yt(e,this.array)),this.array[t*this.itemSize+1]=e,this}getZ(t){let e=this.array[t*this.itemSize+2];return this.normalized&&(e=tn(e,this.array)),e}setZ(t,e){return this.normalized&&(e=Yt(e,this.array)),this.array[t*this.itemSize+2]=e,this}getW(t){let e=this.array[t*this.itemSize+3];return this.normalized&&(e=tn(e,this.array)),e}setW(t,e){return this.normalized&&(e=Yt(e,this.array)),this.array[t*this.itemSize+3]=e,this}setXY(t,e,n){return t*=this.itemSize,this.normalized&&(e=Yt(e,this.array),n=Yt(n,this.array)),this.array[t+0]=e,this.array[t+1]=n,this}setXYZ(t,e,n,i){return t*=this.itemSize,this.normalized&&(e=Yt(e,this.array),n=Yt(n,this.array),i=Yt(i,this.array)),this.array[t+0]=e,this.array[t+1]=n,this.array[t+2]=i,this}setXYZW(t,e,n,i,r){return t*=this.itemSize,this.normalized&&(e=Yt(e,this.array),n=Yt(n,this.array),i=Yt(i,this.array),r=Yt(r,this.array)),this.array[t+0]=e,this.array[t+1]=n,this.array[t+2]=i,this.array[t+3]=r,this}onUpload(t){return this.onUploadCallback=t,this}clone(){return new this.constructor(this.array,this.itemSize).copy(this)}toJSON(){let t={itemSize:this.itemSize,type:this.array.constructor.name,array:Array.from(this.array),normalized:this.normalized};return this.name!==""&&(t.name=this.name),this.usage!==so&&(t.usage=this.usage),t}};var qs=class extends ee{constructor(t,e,n){super(new Uint16Array(t),e,n)}};var Ys=class extends ee{constructor(t,e,n){super(new Uint32Array(t),e,n)}};var Ae=class extends ee{constructor(t,e,n){super(new Float32Array(t),e,n)}};var Bh=0,Le=new Zt,Hr=new fe,$n=new L,Re=new rn,Di=new rn,ue=new L,pe=class s extends Mn{constructor(){super(),this.isBufferGeometry=!0,Object.defineProperty(this,"id",{value:Bh++}),this.uuid=xn(),this.name="",this.type="BufferGeometry",this.index=null,this.attributes={},this.morphAttributes={},this.morphTargetsRelative=!1,this.groups=[],this.boundingBox=null,this.boundingSphere=null,this.drawRange={start:0,count:1/0},this.userData={}}getIndex(){return this.index}setIndex(t){return Array.isArray(t)?this.index=new(Zc(t)?Ys:qs)(t,1):this.index=t,this}getAttribute(t){return this.attributes[t]}setAttribute(t,e){return this.attributes[t]=e,this}deleteAttribute(t){return delete this.attributes[t],this}hasAttribute(t){return this.attributes[t]!==void 0}addGroup(t,e,n=0){this.groups.push({start:t,count:e,materialIndex:n})}clearGroups(){this.groups=[]}setDrawRange(t,e){this.drawRange.start=t,this.drawRange.count=e}applyMatrix4(t){let e=this.attributes.position;e!==void 0&&(e.applyMatrix4(t),e.needsUpdate=!0);let n=this.attributes.normal;if(n!==void 0){let r=new Gt().getNormalMatrix(t);n.applyNormalMatrix(r),n.needsUpdate=!0}let i=this.attributes.tangent;return i!==void 0&&(i.transformDirection(t),i.needsUpdate=!0),this.boundingBox!==null&&this.computeBoundingBox(),this.boundingSphere!==null&&this.computeBoundingSphere(),this}applyQuaternion(t){return Le.makeRotationFromQuaternion(t),this.applyMatrix4(Le),this}rotateX(t){return Le.makeRotationX(t),this.applyMatrix4(Le),this}rotateY(t){return Le.makeRotationY(t),this.applyMatrix4(Le),this}rotateZ(t){return Le.makeRotationZ(t),this.applyMatrix4(Le),this}translate(t,e,n){return Le.makeTranslation(t,e,n),this.applyMatrix4(Le),this}scale(t,e,n){return Le.makeScale(t,e,n),this.applyMatrix4(Le),this}lookAt(t){return Hr.lookAt(t),Hr.updateMatrix(),this.applyMatrix4(Hr.matrix),this}center(){return this.computeBoundingBox(),this.boundingBox.getCenter($n).negate(),this.translate($n.x,$n.y,$n.z),this}setFromPoints(t){let e=[];for(let n=0,i=t.length;n<i;n++){let r=t[n];e.push(r.x,r.y,r.z||0)}return this.setAttribute("position",new Ae(e,3)),this}computeBoundingBox(){this.boundingBox===null&&(this.boundingBox=new rn);let t=this.attributes.position,e=this.morphAttributes.position;if(t&&t.isGLBufferAttribute){console.error('THREE.BufferGeometry.computeBoundingBox(): GLBufferAttribute requires a manual bounding box. Alternatively set "mesh.frustumCulled" to "false".',this),this.boundingBox.set(new L(-1/0,-1/0,-1/0),new L(1/0,1/0,1/0));return}if(t!==void 0){if(this.boundingBox.setFromBufferAttribute(t),e)for(let n=0,i=e.length;n<i;n++){let r=e[n];Re.setFromBufferAttribute(r),this.morphTargetsRelative?(ue.addVectors(this.boundingBox.min,Re.min),this.boundingBox.expandByPoint(ue),ue.addVectors(this.boundingBox.max,Re.max),this.boundingBox.expandByPoint(ue)):(this.boundingBox.expandByPoint(Re.min),this.boundingBox.expandByPoint(Re.max))}}else this.boundingBox.makeEmpty();(isNaN(this.boundingBox.min.x)||isNaN(this.boundingBox.min.y)||isNaN(this.boundingBox.min.z))&&console.error('THREE.BufferGeometry.computeBoundingBox(): Computed min/max have NaN values. The "position" attribute is likely to have NaN values.',this)}computeBoundingSphere(){this.boundingSphere===null&&(this.boundingSphere=new on);let t=this.attributes.position,e=this.morphAttributes.position;if(t&&t.isGLBufferAttribute){console.error('THREE.BufferGeometry.computeBoundingSphere(): GLBufferAttribute requires a manual bounding sphere. Alternatively set "mesh.frustumCulled" to "false".',this),this.boundingSphere.set(new L,1/0);return}if(t){let n=this.boundingSphere.center;if(Re.setFromBufferAttribute(t),e)for(let r=0,o=e.length;r<o;r++){let a=e[r];Di.setFromBufferAttribute(a),this.morphTargetsRelative?(ue.addVectors(Re.min,Di.min),Re.expandByPoint(ue),ue.addVectors(Re.max,Di.max),Re.expandByPoint(ue)):(Re.expandByPoint(Di.min),Re.expandByPoint(Di.max))}Re.getCenter(n);let i=0;for(let r=0,o=t.count;r<o;r++)ue.fromBufferAttribute(t,r),i=Math.max(i,n.distanceToSquared(ue));if(e)for(let r=0,o=e.length;r<o;r++){let a=e[r],c=this.morphTargetsRelative;for(let l=0,h=a.count;l<h;l++)ue.fromBufferAttribute(a,l),c&&($n.fromBufferAttribute(t,l),ue.add($n)),i=Math.max(i,n.distanceToSquared(ue))}this.boundingSphere.radius=Math.sqrt(i),isNaN(this.boundingSphere.radius)&&console.error('THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN. The "position" attribute is likely to have NaN values.',this)}}computeTangents(){let t=this.index,e=this.attributes;if(t===null||e.position===void 0||e.normal===void 0||e.uv===void 0){console.error("THREE.BufferGeometry: .computeTangents() failed. Missing required attributes (index, position, normal or uv)");return}let n=t.array,i=e.position.array,r=e.normal.array,o=e.uv.array,a=i.length/3;this.hasAttribute("tangent")===!1&&this.setAttribute("tangent",new ee(new Float32Array(4*a),4));let c=this.getAttribute("tangent").array,l=[],h=[];for(let w=0;w<a;w++)l[w]=new L,h[w]=new L;let u=new L,d=new L,m=new L,v=new Lt,x=new Lt,p=new Lt,f=new L,g=new L;function _(w,F,B){u.fromArray(i,w*3),d.fromArray(i,F*3),m.fromArray(i,B*3),v.fromArray(o,w*2),x.fromArray(o,F*2),p.fromArray(o,B*2),d.sub(u),m.sub(u),x.sub(v),p.sub(v);let W=1/(x.x*p.y-p.x*x.y);isFinite(W)&&(f.copy(d).multiplyScalar(p.y).addScaledVector(m,-x.y).multiplyScalar(W),g.copy(m).multiplyScalar(x.x).addScaledVector(d,-p.x).multiplyScalar(W),l[w].add(f),l[F].add(f),l[B].add(f),h[w].add(g),h[F].add(g),h[B].add(g))}let b=this.groups;b.length===0&&(b=[{start:0,count:n.length}]);for(let w=0,F=b.length;w<F;++w){let B=b[w],W=B.start,R=B.count;for(let D=W,H=W+R;D<H;D+=3)_(n[D+0],n[D+1],n[D+2])}let S=new L,T=new L,C=new L,P=new L;function y(w){C.fromArray(r,w*3),P.copy(C);let F=l[w];S.copy(F),S.sub(C.multiplyScalar(C.dot(F))).normalize(),T.crossVectors(P,F);let W=T.dot(h[w])<0?-1:1;c[w*4]=S.x,c[w*4+1]=S.y,c[w*4+2]=S.z,c[w*4+3]=W}for(let w=0,F=b.length;w<F;++w){let B=b[w],W=B.start,R=B.count;for(let D=W,H=W+R;D<H;D+=3)y(n[D+0]),y(n[D+1]),y(n[D+2])}}computeVertexNormals(){let t=this.index,e=this.getAttribute("position");if(e!==void 0){let n=this.getAttribute("normal");if(n===void 0)n=new ee(new Float32Array(e.count*3),3),this.setAttribute("normal",n);else for(let d=0,m=n.count;d<m;d++)n.setXYZ(d,0,0,0);let i=new L,r=new L,o=new L,a=new L,c=new L,l=new L,h=new L,u=new L;if(t)for(let d=0,m=t.count;d<m;d+=3){let v=t.getX(d+0),x=t.getX(d+1),p=t.getX(d+2);i.fromBufferAttribute(e,v),r.fromBufferAttribute(e,x),o.fromBufferAttribute(e,p),h.subVectors(o,r),u.subVectors(i,r),h.cross(u),a.fromBufferAttribute(n,v),c.fromBufferAttribute(n,x),l.fromBufferAttribute(n,p),a.add(h),c.add(h),l.add(h),n.setXYZ(v,a.x,a.y,a.z),n.setXYZ(x,c.x,c.y,c.z),n.setXYZ(p,l.x,l.y,l.z)}else for(let d=0,m=e.count;d<m;d+=3)i.fromBufferAttribute(e,d+0),r.fromBufferAttribute(e,d+1),o.fromBufferAttribute(e,d+2),h.subVectors(o,r),u.subVectors(i,r),h.cross(u),n.setXYZ(d+0,h.x,h.y,h.z),n.setXYZ(d+1,h.x,h.y,h.z),n.setXYZ(d+2,h.x,h.y,h.z);this.normalizeNormals(),n.needsUpdate=!0}}normalizeNormals(){let t=this.attributes.normal;for(let e=0,n=t.count;e<n;e++)ue.fromBufferAttribute(t,e),ue.normalize(),t.setXYZ(e,ue.x,ue.y,ue.z)}toNonIndexed(){function t(a,c){let l=a.array,h=a.itemSize,u=a.normalized,d=new l.constructor(c.length*h),m=0,v=0;for(let x=0,p=c.length;x<p;x++){a.isInterleavedBufferAttribute?m=c[x]*a.data.stride+a.offset:m=c[x]*h;for(let f=0;f<h;f++)d[v++]=l[m++]}return new ee(d,h,u)}if(this.index===null)return console.warn("THREE.BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed."),this;let e=new s,n=this.index.array,i=this.attributes;for(let a in i){let c=i[a],l=t(c,n);e.setAttribute(a,l)}let r=this.morphAttributes;for(let a in r){let c=[],l=r[a];for(let h=0,u=l.length;h<u;h++){let d=l[h],m=t(d,n);c.push(m)}e.morphAttributes[a]=c}e.morphTargetsRelative=this.morphTargetsRelative;let o=this.groups;for(let a=0,c=o.length;a<c;a++){let l=o[a];e.addGroup(l.start,l.count,l.materialIndex)}return e}toJSON(){let t={metadata:{version:4.6,type:"BufferGeometry",generator:"BufferGeometry.toJSON"}};if(t.uuid=this.uuid,t.type=this.type,this.name!==""&&(t.name=this.name),Object.keys(this.userData).length>0&&(t.userData=this.userData),this.parameters!==void 0){let c=this.parameters;for(let l in c)c[l]!==void 0&&(t[l]=c[l]);return t}t.data={attributes:{}};let e=this.index;e!==null&&(t.data.index={type:e.array.constructor.name,array:Array.prototype.slice.call(e.array)});let n=this.attributes;for(let c in n){let l=n[c];t.data.attributes[c]=l.toJSON(t.data)}let i={},r=!1;for(let c in this.morphAttributes){let l=this.morphAttributes[c],h=[];for(let u=0,d=l.length;u<d;u++){let m=l[u];h.push(m.toJSON(t.data))}h.length>0&&(i[c]=h,r=!0)}r&&(t.data.morphAttributes=i,t.data.morphTargetsRelative=this.morphTargetsRelative);let o=this.groups;o.length>0&&(t.data.groups=JSON.parse(JSON.stringify(o)));let a=this.boundingSphere;return a!==null&&(t.data.boundingSphere={center:a.center.toArray(),radius:a.radius}),t}clone(){return new this.constructor().copy(this)}copy(t){this.index=null,this.attributes={},this.morphAttributes={},this.groups=[],this.boundingBox=null,this.boundingSphere=null;let e={};this.name=t.name;let n=t.index;n!==null&&this.setIndex(n.clone(e));let i=t.attributes;for(let l in i){let h=i[l];this.setAttribute(l,h.clone(e))}let r=t.morphAttributes;for(let l in r){let h=[],u=r[l];for(let d=0,m=u.length;d<m;d++)h.push(u[d].clone(e));this.morphAttributes[l]=h}this.morphTargetsRelative=t.morphTargetsRelative;let o=t.groups;for(let l=0,h=o.length;l<h;l++){let u=o[l];this.addGroup(u.start,u.count,u.materialIndex)}let a=t.boundingBox;a!==null&&(this.boundingBox=a.clone());let c=t.boundingSphere;return c!==null&&(this.boundingSphere=c.clone()),this.drawRange.start=t.drawRange.start,this.drawRange.count=t.drawRange.count,this.userData=t.userData,this}dispose(){this.dispatchEvent({type:"dispose"})}},ja=new Zt,Rn=new vi,ms=new on,Qa=new L,jn=new L,Qn=new L,ti=new L,Gr=new L,gs=new L,_s=new Lt,vs=new Lt,xs=new Lt,tc=new L,ec=new L,nc=new L,ys=new L,Ms=new L,Ue=class extends fe{constructor(t=new pe,e=new xi){super(),this.isMesh=!0,this.type="Mesh",this.geometry=t,this.material=e,this.updateMorphTargets()}copy(t,e){return super.copy(t,e),t.morphTargetInfluences!==void 0&&(this.morphTargetInfluences=t.morphTargetInfluences.slice()),t.morphTargetDictionary!==void 0&&(this.morphTargetDictionary=Object.assign({},t.morphTargetDictionary)),this.material=Array.isArray(t.material)?t.material.slice():t.material,this.geometry=t.geometry,this}updateMorphTargets(){let e=this.geometry.morphAttributes,n=Object.keys(e);if(n.length>0){let i=e[n[0]];if(i!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let r=0,o=i.length;r<o;r++){let a=i[r].name||String(r);this.morphTargetInfluences.push(0),this.morphTargetDictionary[a]=r}}}}getVertexPosition(t,e){let n=this.geometry,i=n.attributes.position,r=n.morphAttributes.position,o=n.morphTargetsRelative;e.fromBufferAttribute(i,t);let a=this.morphTargetInfluences;if(r&&a){gs.set(0,0,0);for(let c=0,l=r.length;c<l;c++){let h=a[c],u=r[c];h!==0&&(Gr.fromBufferAttribute(u,t),o?gs.addScaledVector(Gr,h):gs.addScaledVector(Gr.sub(e),h))}e.add(gs)}return e}raycast(t,e){let n=this.geometry,i=this.material,r=this.matrixWorld;i!==void 0&&(n.boundingSphere===null&&n.computeBoundingSphere(),ms.copy(n.boundingSphere),ms.applyMatrix4(r),Rn.copy(t.ray).recast(t.near),!(ms.containsPoint(Rn.origin)===!1&&(Rn.intersectSphere(ms,Qa)===null||Rn.origin.distanceToSquared(Qa)>(t.far-t.near)**2))&&(ja.copy(r).invert(),Rn.copy(t.ray).applyMatrix4(ja),!(n.boundingBox!==null&&Rn.intersectsBox(n.boundingBox)===!1)&&this._computeIntersections(t,e,Rn)))}_computeIntersections(t,e,n){let i,r=this.geometry,o=this.material,a=r.index,c=r.attributes.position,l=r.attributes.uv,h=r.attributes.uv1,u=r.attributes.normal,d=r.groups,m=r.drawRange;if(a!==null)if(Array.isArray(o))for(let v=0,x=d.length;v<x;v++){let p=d[v],f=o[p.materialIndex],g=Math.max(p.start,m.start),_=Math.min(a.count,Math.min(p.start+p.count,m.start+m.count));for(let b=g,S=_;b<S;b+=3){let T=a.getX(b),C=a.getX(b+1),P=a.getX(b+2);i=bs(this,f,t,n,l,h,u,T,C,P),i&&(i.faceIndex=Math.floor(b/3),i.face.materialIndex=p.materialIndex,e.push(i))}}else{let v=Math.max(0,m.start),x=Math.min(a.count,m.start+m.count);for(let p=v,f=x;p<f;p+=3){let g=a.getX(p),_=a.getX(p+1),b=a.getX(p+2);i=bs(this,o,t,n,l,h,u,g,_,b),i&&(i.faceIndex=Math.floor(p/3),e.push(i))}}else if(c!==void 0)if(Array.isArray(o))for(let v=0,x=d.length;v<x;v++){let p=d[v],f=o[p.materialIndex],g=Math.max(p.start,m.start),_=Math.min(c.count,Math.min(p.start+p.count,m.start+m.count));for(let b=g,S=_;b<S;b+=3){let T=b,C=b+1,P=b+2;i=bs(this,f,t,n,l,h,u,T,C,P),i&&(i.faceIndex=Math.floor(b/3),i.face.materialIndex=p.materialIndex,e.push(i))}}else{let v=Math.max(0,m.start),x=Math.min(c.count,m.start+m.count);for(let p=v,f=x;p<f;p+=3){let g=p,_=p+1,b=p+2;i=bs(this,o,t,n,l,h,u,g,_,b),i&&(i.faceIndex=Math.floor(p/3),e.push(i))}}}};function zh(s,t,e,n,i,r,o,a){let c;if(t.side===Ee?c=n.intersectTriangle(o,r,i,!0,a):c=n.intersectTriangle(i,r,o,t.side===yn,a),c===null)return null;Ms.copy(a),Ms.applyMatrix4(s.matrixWorld);let l=e.ray.origin.distanceTo(Ms);return l<e.near||l>e.far?null:{distance:l,point:Ms.clone(),object:s}}function bs(s,t,e,n,i,r,o,a,c,l){s.getVertexPosition(a,jn),s.getVertexPosition(c,Qn),s.getVertexPosition(l,ti);let h=zh(s,t,e,n,jn,Qn,ti,ys);if(h){i&&(_s.fromBufferAttribute(i,a),vs.fromBufferAttribute(i,c),xs.fromBufferAttribute(i,l),h.uv=Un.getInterpolation(ys,jn,Qn,ti,_s,vs,xs,new Lt)),r&&(_s.fromBufferAttribute(r,a),vs.fromBufferAttribute(r,c),xs.fromBufferAttribute(r,l),h.uv1=Un.getInterpolation(ys,jn,Qn,ti,_s,vs,xs,new Lt),h.uv2=h.uv1),o&&(tc.fromBufferAttribute(o,a),ec.fromBufferAttribute(o,c),nc.fromBufferAttribute(o,l),h.normal=Un.getInterpolation(ys,jn,Qn,ti,tc,ec,nc,new L),h.normal.dot(n.direction)>0&&h.normal.multiplyScalar(-1));let u={a,b:c,c:l,normal:new L,materialIndex:0};Un.getNormal(jn,Qn,ti,u.normal),h.face=u}return h}var Wi=class s extends pe{constructor(t=1,e=1,n=1,i=1,r=1,o=1){super(),this.type="BoxGeometry",this.parameters={width:t,height:e,depth:n,widthSegments:i,heightSegments:r,depthSegments:o};let a=this;i=Math.floor(i),r=Math.floor(r),o=Math.floor(o);let c=[],l=[],h=[],u=[],d=0,m=0;v("z","y","x",-1,-1,n,e,t,o,r,0),v("z","y","x",1,-1,n,e,-t,o,r,1),v("x","z","y",1,1,t,n,e,i,o,2),v("x","z","y",1,-1,t,n,-e,i,o,3),v("x","y","z",1,-1,t,e,n,i,r,4),v("x","y","z",-1,-1,t,e,-n,i,r,5),this.setIndex(c),this.setAttribute("position",new Ae(l,3)),this.setAttribute("normal",new Ae(h,3)),this.setAttribute("uv",new Ae(u,2));function v(x,p,f,g,_,b,S,T,C,P,y){let w=b/C,F=S/P,B=b/2,W=S/2,R=T/2,D=C+1,H=P+1,k=0,N=0,V=new L;for(let K=0;K<H;K++){let $=K*F-W;for(let ct=0;ct<D;ct++){let G=ct*w-B;V[x]=G*g,V[p]=$*_,V[f]=R,l.push(V.x,V.y,V.z),V[x]=0,V[p]=0,V[f]=T>0?1:-1,h.push(V.x,V.y,V.z),u.push(ct/C),u.push(1-K/P),k+=1}}for(let K=0;K<P;K++)for(let $=0;$<C;$++){let ct=d+$+D*K,G=d+$+D*(K+1),J=d+($+1)+D*(K+1),ot=d+($+1)+D*K;c.push(ct,G,ot),c.push(G,J,ot),N+=6}a.addGroup(m,N,y),m+=N,d+=k}}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new s(t.width,t.height,t.depth,t.widthSegments,t.heightSegments,t.depthSegments)}};function yi(s){let t={};for(let e in s){t[e]={};for(let n in s[e]){let i=s[e][n];i&&(i.isColor||i.isMatrix3||i.isMatrix4||i.isVector2||i.isVector3||i.isVector4||i.isTexture||i.isQuaternion)?i.isRenderTargetTexture?(console.warn("UniformsUtils: Textures of render targets cannot be cloned via cloneUniforms() or mergeUniforms()."),t[e][n]=null):t[e][n]=i.clone():Array.isArray(i)?t[e][n]=i.slice():t[e][n]=i}}return t}function Me(s){let t={};for(let e=0;e<s.length;e++){let n=yi(s[e]);for(let i in n)t[i]=n[i]}return t}function kh(s){let t=[];for(let e=0;e<s.length;e++)t.push(s[e].clone());return t}function Kc(s){return s.getRenderTarget()===null?s.outputColorSpace:qt.workingColorSpace}var Vh={clone:yi,merge:Me},Hh=`void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,Gh=`void main() {
	gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );
}`,Fe=class extends an{constructor(t){super(),this.isShaderMaterial=!0,this.type="ShaderMaterial",this.defines={},this.uniforms={},this.uniformsGroups=[],this.vertexShader=Hh,this.fragmentShader=Gh,this.linewidth=1,this.wireframe=!1,this.wireframeLinewidth=1,this.fog=!1,this.lights=!1,this.clipping=!1,this.forceSinglePass=!0,this.extensions={derivatives:!1,fragDepth:!1,drawBuffers:!1,shaderTextureLOD:!1,clipCullDistance:!1},this.defaultAttributeValues={color:[1,1,1],uv:[0,0],uv1:[0,0]},this.index0AttributeName=void 0,this.uniformsNeedUpdate=!1,this.glslVersion=null,t!==void 0&&this.setValues(t)}copy(t){return super.copy(t),this.fragmentShader=t.fragmentShader,this.vertexShader=t.vertexShader,this.uniforms=yi(t.uniforms),this.uniformsGroups=kh(t.uniformsGroups),this.defines=Object.assign({},t.defines),this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this.fog=t.fog,this.lights=t.lights,this.clipping=t.clipping,this.extensions=Object.assign({},t.extensions),this.glslVersion=t.glslVersion,this}toJSON(t){let e=super.toJSON(t);e.glslVersion=this.glslVersion,e.uniforms={};for(let i in this.uniforms){let o=this.uniforms[i].value;o&&o.isTexture?e.uniforms[i]={type:"t",value:o.toJSON(t).uuid}:o&&o.isColor?e.uniforms[i]={type:"c",value:o.getHex()}:o&&o.isVector2?e.uniforms[i]={type:"v2",value:o.toArray()}:o&&o.isVector3?e.uniforms[i]={type:"v3",value:o.toArray()}:o&&o.isVector4?e.uniforms[i]={type:"v4",value:o.toArray()}:o&&o.isMatrix3?e.uniforms[i]={type:"m3",value:o.toArray()}:o&&o.isMatrix4?e.uniforms[i]={type:"m4",value:o.toArray()}:e.uniforms[i]={value:o}}Object.keys(this.defines).length>0&&(e.defines=this.defines),e.vertexShader=this.vertexShader,e.fragmentShader=this.fragmentShader,e.lights=this.lights,e.clipping=this.clipping;let n={};for(let i in this.extensions)this.extensions[i]===!0&&(n[i]=!0);return Object.keys(n).length>0&&(e.extensions=n),e}},Zs=class extends fe{constructor(){super(),this.isCamera=!0,this.type="Camera",this.matrixWorldInverse=new Zt,this.projectionMatrix=new Zt,this.projectionMatrixInverse=new Zt,this.coordinateSystem=en}copy(t,e){return super.copy(t,e),this.matrixWorldInverse.copy(t.matrixWorldInverse),this.projectionMatrix.copy(t.projectionMatrix),this.projectionMatrixInverse.copy(t.projectionMatrixInverse),this.coordinateSystem=t.coordinateSystem,this}getWorldDirection(t){return super.getWorldDirection(t).negate()}updateMatrixWorld(t){super.updateMatrixWorld(t),this.matrixWorldInverse.copy(this.matrixWorld).invert()}updateWorldMatrix(t,e){super.updateWorldMatrix(t,e),this.matrixWorldInverse.copy(this.matrixWorld).invert()}clone(){return new this.constructor().copy(this)}},Se=class extends Zs{constructor(t=50,e=1,n=.1,i=2e3){super(),this.isPerspectiveCamera=!0,this.type="PerspectiveCamera",this.fov=t,this.zoom=1,this.near=n,this.far=i,this.focus=10,this.aspect=e,this.view=null,this.filmGauge=35,this.filmOffset=0,this.updateProjectionMatrix()}copy(t,e){return super.copy(t,e),this.fov=t.fov,this.zoom=t.zoom,this.near=t.near,this.far=t.far,this.focus=t.focus,this.aspect=t.aspect,this.view=t.view===null?null:Object.assign({},t.view),this.filmGauge=t.filmGauge,this.filmOffset=t.filmOffset,this}setFocalLength(t){let e=.5*this.getFilmHeight()/t;this.fov=oo*2*Math.atan(e),this.updateProjectionMatrix()}getFocalLength(){let t=Math.tan(Ar*.5*this.fov);return .5*this.getFilmHeight()/t}getEffectiveFOV(){return oo*2*Math.atan(Math.tan(Ar*.5*this.fov)/this.zoom)}getFilmWidth(){return this.filmGauge*Math.min(this.aspect,1)}getFilmHeight(){return this.filmGauge/Math.max(this.aspect,1)}setViewOffset(t,e,n,i,r,o){this.aspect=t/e,this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=t,this.view.fullHeight=e,this.view.offsetX=n,this.view.offsetY=i,this.view.width=r,this.view.height=o,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){let t=this.near,e=t*Math.tan(Ar*.5*this.fov)/this.zoom,n=2*e,i=this.aspect*n,r=-.5*i,o=this.view;if(this.view!==null&&this.view.enabled){let c=o.fullWidth,l=o.fullHeight;r+=o.offsetX*i/c,e-=o.offsetY*n/l,i*=o.width/c,n*=o.height/l}let a=this.filmOffset;a!==0&&(r+=t*a/this.getFilmWidth()),this.projectionMatrix.makePerspective(r,r+i,e,e-n,t,this.far,this.coordinateSystem),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(t){let e=super.toJSON(t);return e.object.fov=this.fov,e.object.zoom=this.zoom,e.object.near=this.near,e.object.far=this.far,e.object.focus=this.focus,e.object.aspect=this.aspect,this.view!==null&&(e.object.view=Object.assign({},this.view)),e.object.filmGauge=this.filmGauge,e.object.filmOffset=this.filmOffset,e}},ei=-90,ni=1,ho=class extends fe{constructor(t,e,n){super(),this.type="CubeCamera",this.renderTarget=n,this.coordinateSystem=null,this.activeMipmapLevel=0;let i=new Se(ei,ni,t,e);i.layers=this.layers,this.add(i);let r=new Se(ei,ni,t,e);r.layers=this.layers,this.add(r);let o=new Se(ei,ni,t,e);o.layers=this.layers,this.add(o);let a=new Se(ei,ni,t,e);a.layers=this.layers,this.add(a);let c=new Se(ei,ni,t,e);c.layers=this.layers,this.add(c);let l=new Se(ei,ni,t,e);l.layers=this.layers,this.add(l)}updateCoordinateSystem(){let t=this.coordinateSystem,e=this.children.concat(),[n,i,r,o,a,c]=e;for(let l of e)this.remove(l);if(t===en)n.up.set(0,1,0),n.lookAt(1,0,0),i.up.set(0,1,0),i.lookAt(-1,0,0),r.up.set(0,0,-1),r.lookAt(0,1,0),o.up.set(0,0,1),o.lookAt(0,-1,0),a.up.set(0,1,0),a.lookAt(0,0,1),c.up.set(0,1,0),c.lookAt(0,0,-1);else if(t===ks)n.up.set(0,-1,0),n.lookAt(-1,0,0),i.up.set(0,-1,0),i.lookAt(1,0,0),r.up.set(0,0,1),r.lookAt(0,1,0),o.up.set(0,0,-1),o.lookAt(0,-1,0),a.up.set(0,-1,0),a.lookAt(0,0,1),c.up.set(0,-1,0),c.lookAt(0,0,-1);else throw new Error("THREE.CubeCamera.updateCoordinateSystem(): Invalid coordinate system: "+t);for(let l of e)this.add(l),l.updateMatrixWorld()}update(t,e){this.parent===null&&this.updateMatrixWorld();let{renderTarget:n,activeMipmapLevel:i}=this;this.coordinateSystem!==t.coordinateSystem&&(this.coordinateSystem=t.coordinateSystem,this.updateCoordinateSystem());let[r,o,a,c,l,h]=this.children,u=t.getRenderTarget(),d=t.getActiveCubeFace(),m=t.getActiveMipmapLevel(),v=t.xr.enabled;t.xr.enabled=!1;let x=n.texture.generateMipmaps;n.texture.generateMipmaps=!1,t.setRenderTarget(n,0,i),t.render(e,r),t.setRenderTarget(n,1,i),t.render(e,o),t.setRenderTarget(n,2,i),t.render(e,a),t.setRenderTarget(n,3,i),t.render(e,c),t.setRenderTarget(n,4,i),t.render(e,l),n.texture.generateMipmaps=x,t.setRenderTarget(n,5,i),t.render(e,h),t.setRenderTarget(u,d,m),t.xr.enabled=v,n.texture.needsPMREMUpdate=!0}},Js=class extends Ne{constructor(t,e,n,i,r,o,a,c,l,h){t=t!==void 0?t:[],e=e!==void 0?e:mi,super(t,e,n,i,r,o,a,c,l,h),this.isCubeTexture=!0,this.flipY=!1}get images(){return this.image}set images(t){this.image=t}},uo=class extends sn{constructor(t=1,e={}){super(t,t,e),this.isWebGLCubeRenderTarget=!0;let n={width:t,height:t,depth:1},i=[n,n,n,n,n,n];e.encoding!==void 0&&(zi("THREE.WebGLCubeRenderTarget: option.encoding has been replaced by option.colorSpace."),e.colorSpace=e.encoding===On?oe:De),this.texture=new Js(i,e.mapping,e.wrapS,e.wrapT,e.magFilter,e.minFilter,e.format,e.type,e.anisotropy,e.colorSpace),this.texture.isRenderTargetTexture=!0,this.texture.generateMipmaps=e.generateMipmaps!==void 0?e.generateMipmaps:!1,this.texture.minFilter=e.minFilter!==void 0?e.minFilter:Ie}fromEquirectangularTexture(t,e){this.texture.type=e.type,this.texture.colorSpace=e.colorSpace,this.texture.generateMipmaps=e.generateMipmaps,this.texture.minFilter=e.minFilter,this.texture.magFilter=e.magFilter;let n={uniforms:{tEquirect:{value:null}},vertexShader:`

				varying vec3 vWorldDirection;

				vec3 transformDirection( in vec3 dir, in mat4 matrix ) {

					return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );

				}

				void main() {

					vWorldDirection = transformDirection( position, modelMatrix );

					#include <begin_vertex>
					#include <project_vertex>

				}
			`,fragmentShader:`

				uniform sampler2D tEquirect;

				varying vec3 vWorldDirection;

				#include <common>

				void main() {

					vec3 direction = normalize( vWorldDirection );

					vec2 sampleUV = equirectUv( direction );

					gl_FragColor = texture2D( tEquirect, sampleUV );

				}
			`},i=new Wi(5,5,5),r=new Fe({name:"CubemapFromEquirect",uniforms:yi(n.uniforms),vertexShader:n.vertexShader,fragmentShader:n.fragmentShader,side:Ee,blending:gn});r.uniforms.tEquirect.value=e;let o=new Ue(i,r),a=e.minFilter;return e.minFilter===Vi&&(e.minFilter=Ie),new ho(1,10,this).update(t,o),e.minFilter=a,o.geometry.dispose(),o.material.dispose(),this}clear(t,e,n,i){let r=t.getRenderTarget();for(let o=0;o<6;o++)t.setRenderTarget(this,o),t.clear(e,n,i);t.setRenderTarget(r)}},Wr=new L,Wh=new L,Xh=new Gt,je=class{constructor(t=new L(1,0,0),e=0){this.isPlane=!0,this.normal=t,this.constant=e}set(t,e){return this.normal.copy(t),this.constant=e,this}setComponents(t,e,n,i){return this.normal.set(t,e,n),this.constant=i,this}setFromNormalAndCoplanarPoint(t,e){return this.normal.copy(t),this.constant=-e.dot(this.normal),this}setFromCoplanarPoints(t,e,n){let i=Wr.subVectors(n,e).cross(Wh.subVectors(t,e)).normalize();return this.setFromNormalAndCoplanarPoint(i,t),this}copy(t){return this.normal.copy(t.normal),this.constant=t.constant,this}normalize(){let t=1/this.normal.length();return this.normal.multiplyScalar(t),this.constant*=t,this}negate(){return this.constant*=-1,this.normal.negate(),this}distanceToPoint(t){return this.normal.dot(t)+this.constant}distanceToSphere(t){return this.distanceToPoint(t.center)-t.radius}projectPoint(t,e){return e.copy(t).addScaledVector(this.normal,-this.distanceToPoint(t))}intersectLine(t,e){let n=t.delta(Wr),i=this.normal.dot(n);if(i===0)return this.distanceToPoint(t.start)===0?e.copy(t.start):null;let r=-(t.start.dot(this.normal)+this.constant)/i;return r<0||r>1?null:e.copy(t.start).addScaledVector(n,r)}intersectsLine(t){let e=this.distanceToPoint(t.start),n=this.distanceToPoint(t.end);return e<0&&n>0||n<0&&e>0}intersectsBox(t){return t.intersectsPlane(this)}intersectsSphere(t){return t.intersectsPlane(this)}coplanarPoint(t){return t.copy(this.normal).multiplyScalar(-this.constant)}applyMatrix4(t,e){let n=e||Xh.getNormalMatrix(t),i=this.coplanarPoint(Wr).applyMatrix4(t),r=this.normal.applyMatrix3(n).normalize();return this.constant=-i.dot(r),this}translate(t){return this.constant-=t.dot(this.normal),this}equals(t){return t.normal.equals(this.normal)&&t.constant===this.constant}clone(){return new this.constructor().copy(this)}},Pn=new on,Ss=new L,Mi=class{constructor(t=new je,e=new je,n=new je,i=new je,r=new je,o=new je){this.planes=[t,e,n,i,r,o]}set(t,e,n,i,r,o){let a=this.planes;return a[0].copy(t),a[1].copy(e),a[2].copy(n),a[3].copy(i),a[4].copy(r),a[5].copy(o),this}copy(t){let e=this.planes;for(let n=0;n<6;n++)e[n].copy(t.planes[n]);return this}setFromProjectionMatrix(t,e=en){let n=this.planes,i=t.elements,r=i[0],o=i[1],a=i[2],c=i[3],l=i[4],h=i[5],u=i[6],d=i[7],m=i[8],v=i[9],x=i[10],p=i[11],f=i[12],g=i[13],_=i[14],b=i[15];if(n[0].setComponents(c-r,d-l,p-m,b-f).normalize(),n[1].setComponents(c+r,d+l,p+m,b+f).normalize(),n[2].setComponents(c+o,d+h,p+v,b+g).normalize(),n[3].setComponents(c-o,d-h,p-v,b-g).normalize(),n[4].setComponents(c-a,d-u,p-x,b-_).normalize(),e===en)n[5].setComponents(c+a,d+u,p+x,b+_).normalize();else if(e===ks)n[5].setComponents(a,u,x,_).normalize();else throw new Error("THREE.Frustum.setFromProjectionMatrix(): Invalid coordinate system: "+e);return this}intersectsObject(t){if(t.boundingSphere!==void 0)t.boundingSphere===null&&t.computeBoundingSphere(),Pn.copy(t.boundingSphere).applyMatrix4(t.matrixWorld);else{let e=t.geometry;e.boundingSphere===null&&e.computeBoundingSphere(),Pn.copy(e.boundingSphere).applyMatrix4(t.matrixWorld)}return this.intersectsSphere(Pn)}intersectsSprite(t){return Pn.center.set(0,0,0),Pn.radius=.7071067811865476,Pn.applyMatrix4(t.matrixWorld),this.intersectsSphere(Pn)}intersectsSphere(t){let e=this.planes,n=t.center,i=-t.radius;for(let r=0;r<6;r++)if(e[r].distanceToPoint(n)<i)return!1;return!0}intersectsBox(t){let e=this.planes;for(let n=0;n<6;n++){let i=e[n];if(Ss.x=i.normal.x>0?t.max.x:t.min.x,Ss.y=i.normal.y>0?t.max.y:t.min.y,Ss.z=i.normal.z>0?t.max.z:t.min.z,i.distanceToPoint(Ss)<0)return!1}return!0}containsPoint(t){let e=this.planes;for(let n=0;n<6;n++)if(e[n].distanceToPoint(t)<0)return!1;return!0}clone(){return new this.constructor().copy(this)}};function $c(){let s=null,t=!1,e=null,n=null;function i(r,o){e(r,o),n=s.requestAnimationFrame(i)}return{start:function(){t!==!0&&e!==null&&(n=s.requestAnimationFrame(i),t=!0)},stop:function(){s.cancelAnimationFrame(n),t=!1},setAnimationLoop:function(r){e=r},setContext:function(r){s=r}}}function qh(s,t){let e=t.isWebGL2,n=new WeakMap;function i(l,h){let u=l.array,d=l.usage,m=u.byteLength,v=s.createBuffer();s.bindBuffer(h,v),s.bufferData(h,u,d),l.onUploadCallback();let x;if(u instanceof Float32Array)x=s.FLOAT;else if(u instanceof Uint16Array)if(l.isFloat16BufferAttribute)if(e)x=s.HALF_FLOAT;else throw new Error("THREE.WebGLAttributes: Usage of Float16BufferAttribute requires WebGL2.");else x=s.UNSIGNED_SHORT;else if(u instanceof Int16Array)x=s.SHORT;else if(u instanceof Uint32Array)x=s.UNSIGNED_INT;else if(u instanceof Int32Array)x=s.INT;else if(u instanceof Int8Array)x=s.BYTE;else if(u instanceof Uint8Array)x=s.UNSIGNED_BYTE;else if(u instanceof Uint8ClampedArray)x=s.UNSIGNED_BYTE;else throw new Error("THREE.WebGLAttributes: Unsupported buffer data format: "+u);return{buffer:v,type:x,bytesPerElement:u.BYTES_PER_ELEMENT,version:l.version,size:m}}function r(l,h,u){let d=h.array,m=h._updateRange,v=h.updateRanges;if(s.bindBuffer(u,l),m.count===-1&&v.length===0&&s.bufferSubData(u,0,d),v.length!==0){for(let x=0,p=v.length;x<p;x++){let f=v[x];e?s.bufferSubData(u,f.start*d.BYTES_PER_ELEMENT,d,f.start,f.count):s.bufferSubData(u,f.start*d.BYTES_PER_ELEMENT,d.subarray(f.start,f.start+f.count))}h.clearUpdateRanges()}m.count!==-1&&(e?s.bufferSubData(u,m.offset*d.BYTES_PER_ELEMENT,d,m.offset,m.count):s.bufferSubData(u,m.offset*d.BYTES_PER_ELEMENT,d.subarray(m.offset,m.offset+m.count)),m.count=-1),h.onUploadCallback()}function o(l){return l.isInterleavedBufferAttribute&&(l=l.data),n.get(l)}function a(l){l.isInterleavedBufferAttribute&&(l=l.data);let h=n.get(l);h&&(s.deleteBuffer(h.buffer),n.delete(l))}function c(l,h){if(l.isGLBufferAttribute){let d=n.get(l);(!d||d.version<l.version)&&n.set(l,{buffer:l.buffer,type:l.type,bytesPerElement:l.elementSize,version:l.version});return}l.isInterleavedBufferAttribute&&(l=l.data);let u=n.get(l);if(u===void 0)n.set(l,i(l,h));else if(u.version<l.version){if(u.size!==l.array.byteLength)throw new Error("THREE.WebGLAttributes: The size of the buffer attribute's array buffer does not match the original size. Resizing buffer attributes is not supported.");r(u.buffer,l,h),u.version=l.version}}return{get:o,remove:a,update:c}}var fo=class s extends pe{constructor(t=1,e=1,n=1,i=1){super(),this.type="PlaneGeometry",this.parameters={width:t,height:e,widthSegments:n,heightSegments:i};let r=t/2,o=e/2,a=Math.floor(n),c=Math.floor(i),l=a+1,h=c+1,u=t/a,d=e/c,m=[],v=[],x=[],p=[];for(let f=0;f<h;f++){let g=f*d-o;for(let _=0;_<l;_++){let b=_*u-r;v.push(b,-g,0),x.push(0,0,1),p.push(_/a),p.push(1-f/c)}}for(let f=0;f<c;f++)for(let g=0;g<a;g++){let _=g+l*f,b=g+l*(f+1),S=g+1+l*(f+1),T=g+1+l*f;m.push(_,b,T),m.push(b,S,T)}this.setIndex(m),this.setAttribute("position",new Ae(v,3)),this.setAttribute("normal",new Ae(x,3)),this.setAttribute("uv",new Ae(p,2))}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new s(t.width,t.height,t.widthSegments,t.heightSegments)}},Yh=`#ifdef USE_ALPHAHASH
	if ( diffuseColor.a < getAlphaHashThreshold( vPosition ) ) discard;
#endif`,Zh=`#ifdef USE_ALPHAHASH
	const float ALPHA_HASH_SCALE = 0.05;
	float hash2D( vec2 value ) {
		return fract( 1.0e4 * sin( 17.0 * value.x + 0.1 * value.y ) * ( 0.1 + abs( sin( 13.0 * value.y + value.x ) ) ) );
	}
	float hash3D( vec3 value ) {
		return hash2D( vec2( hash2D( value.xy ), value.z ) );
	}
	float getAlphaHashThreshold( vec3 position ) {
		float maxDeriv = max(
			length( dFdx( position.xyz ) ),
			length( dFdy( position.xyz ) )
		);
		float pixScale = 1.0 / ( ALPHA_HASH_SCALE * maxDeriv );
		vec2 pixScales = vec2(
			exp2( floor( log2( pixScale ) ) ),
			exp2( ceil( log2( pixScale ) ) )
		);
		vec2 alpha = vec2(
			hash3D( floor( pixScales.x * position.xyz ) ),
			hash3D( floor( pixScales.y * position.xyz ) )
		);
		float lerpFactor = fract( log2( pixScale ) );
		float x = ( 1.0 - lerpFactor ) * alpha.x + lerpFactor * alpha.y;
		float a = min( lerpFactor, 1.0 - lerpFactor );
		vec3 cases = vec3(
			x * x / ( 2.0 * a * ( 1.0 - a ) ),
			( x - 0.5 * a ) / ( 1.0 - a ),
			1.0 - ( ( 1.0 - x ) * ( 1.0 - x ) / ( 2.0 * a * ( 1.0 - a ) ) )
		);
		float threshold = ( x < ( 1.0 - a ) )
			? ( ( x < a ) ? cases.x : cases.y )
			: cases.z;
		return clamp( threshold , 1.0e-6, 1.0 );
	}
#endif`,Jh=`#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;
#endif`,Kh=`#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,$h=`#ifdef USE_ALPHATEST
	if ( diffuseColor.a < alphaTest ) discard;
#endif`,jh=`#ifdef USE_ALPHATEST
	uniform float alphaTest;
#endif`,Qh=`#ifdef USE_AOMAP
	float ambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
	reflectedLight.indirectDiffuse *= ambientOcclusion;
	#if defined( USE_CLEARCOAT ) 
		clearcoatSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_SHEEN ) 
		sheenSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
	#endif
#endif`,tu=`#ifdef USE_AOMAP
	uniform sampler2D aoMap;
	uniform float aoMapIntensity;
#endif`,eu=`#ifdef USE_BATCHING
	attribute float batchId;
	uniform highp sampler2D batchingTexture;
	mat4 getBatchingMatrix( const in float i ) {
		int size = textureSize( batchingTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( batchingTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( batchingTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( batchingTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( batchingTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
#endif`,nu=`#ifdef USE_BATCHING
	mat4 batchingMatrix = getBatchingMatrix( batchId );
#endif`,iu=`vec3 transformed = vec3( position );
#ifdef USE_ALPHAHASH
	vPosition = vec3( position );
#endif`,su=`vec3 objectNormal = vec3( normal );
#ifdef USE_TANGENT
	vec3 objectTangent = vec3( tangent.xyz );
#endif`,ru=`float G_BlinnPhong_Implicit( ) {
	return 0.25;
}
float D_BlinnPhong( const in float shininess, const in float dotNH ) {
	return RECIPROCAL_PI * ( shininess * 0.5 + 1.0 ) * pow( dotNH, shininess );
}
vec3 BRDF_BlinnPhong( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in vec3 specularColor, const in float shininess ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( specularColor, 1.0, dotVH );
	float G = G_BlinnPhong_Implicit( );
	float D = D_BlinnPhong( shininess, dotNH );
	return F * ( G * D );
} // validated`,ou=`#ifdef USE_IRIDESCENCE
	const mat3 XYZ_TO_REC709 = mat3(
		 3.2404542, -0.9692660,  0.0556434,
		-1.5371385,  1.8760108, -0.2040259,
		-0.4985314,  0.0415560,  1.0572252
	);
	vec3 Fresnel0ToIor( vec3 fresnel0 ) {
		vec3 sqrtF0 = sqrt( fresnel0 );
		return ( vec3( 1.0 ) + sqrtF0 ) / ( vec3( 1.0 ) - sqrtF0 );
	}
	vec3 IorToFresnel0( vec3 transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - vec3( incidentIor ) ) / ( transmittedIor + vec3( incidentIor ) ) );
	}
	float IorToFresnel0( float transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - incidentIor ) / ( transmittedIor + incidentIor ));
	}
	vec3 evalSensitivity( float OPD, vec3 shift ) {
		float phase = 2.0 * PI * OPD * 1.0e-9;
		vec3 val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
		vec3 pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
		vec3 var = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );
		vec3 xyz = val * sqrt( 2.0 * PI * var ) * cos( pos * phase + shift ) * exp( - pow2( phase ) * var );
		xyz.x += 9.7470e-14 * sqrt( 2.0 * PI * 4.5282e+09 ) * cos( 2.2399e+06 * phase + shift[ 0 ] ) * exp( - 4.5282e+09 * pow2( phase ) );
		xyz /= 1.0685e-7;
		vec3 rgb = XYZ_TO_REC709 * xyz;
		return rgb;
	}
	vec3 evalIridescence( float outsideIOR, float eta2, float cosTheta1, float thinFilmThickness, vec3 baseF0 ) {
		vec3 I;
		float iridescenceIOR = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) );
		float sinTheta2Sq = pow2( outsideIOR / iridescenceIOR ) * ( 1.0 - pow2( cosTheta1 ) );
		float cosTheta2Sq = 1.0 - sinTheta2Sq;
		if ( cosTheta2Sq < 0.0 ) {
			return vec3( 1.0 );
		}
		float cosTheta2 = sqrt( cosTheta2Sq );
		float R0 = IorToFresnel0( iridescenceIOR, outsideIOR );
		float R12 = F_Schlick( R0, 1.0, cosTheta1 );
		float T121 = 1.0 - R12;
		float phi12 = 0.0;
		if ( iridescenceIOR < outsideIOR ) phi12 = PI;
		float phi21 = PI - phi12;
		vec3 baseIOR = Fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) );		vec3 R1 = IorToFresnel0( baseIOR, iridescenceIOR );
		vec3 R23 = F_Schlick( R1, 1.0, cosTheta2 );
		vec3 phi23 = vec3( 0.0 );
		if ( baseIOR[ 0 ] < iridescenceIOR ) phi23[ 0 ] = PI;
		if ( baseIOR[ 1 ] < iridescenceIOR ) phi23[ 1 ] = PI;
		if ( baseIOR[ 2 ] < iridescenceIOR ) phi23[ 2 ] = PI;
		float OPD = 2.0 * iridescenceIOR * thinFilmThickness * cosTheta2;
		vec3 phi = vec3( phi21 ) + phi23;
		vec3 R123 = clamp( R12 * R23, 1e-5, 0.9999 );
		vec3 r123 = sqrt( R123 );
		vec3 Rs = pow2( T121 ) * R23 / ( vec3( 1.0 ) - R123 );
		vec3 C0 = R12 + Rs;
		I = C0;
		vec3 Cm = Rs - T121;
		for ( int m = 1; m <= 2; ++ m ) {
			Cm *= r123;
			vec3 Sm = 2.0 * evalSensitivity( float( m ) * OPD, float( m ) * phi );
			I += Cm * Sm;
		}
		return max( I, vec3( 0.0 ) );
	}
#endif`,au=`#ifdef USE_BUMPMAP
	uniform sampler2D bumpMap;
	uniform float bumpScale;
	vec2 dHdxy_fwd() {
		vec2 dSTdx = dFdx( vBumpMapUv );
		vec2 dSTdy = dFdy( vBumpMapUv );
		float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv ).x;
		float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdx ).x - Hll;
		float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdy ).x - Hll;
		return vec2( dBx, dBy );
	}
	vec3 perturbNormalArb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
		vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) );
		vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) );
		vec3 vN = surf_norm;
		vec3 R1 = cross( vSigmaY, vN );
		vec3 R2 = cross( vN, vSigmaX );
		float fDet = dot( vSigmaX, R1 ) * faceDirection;
		vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
		return normalize( abs( fDet ) * surf_norm - vGrad );
	}
#endif`,cu=`#if NUM_CLIPPING_PLANES > 0
	vec4 plane;
	#pragma unroll_loop_start
	for ( int i = 0; i < UNION_CLIPPING_PLANES; i ++ ) {
		plane = clippingPlanes[ i ];
		if ( dot( vClipPosition, plane.xyz ) > plane.w ) discard;
	}
	#pragma unroll_loop_end
	#if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
		bool clipped = true;
		#pragma unroll_loop_start
		for ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {
			plane = clippingPlanes[ i ];
			clipped = ( dot( vClipPosition, plane.xyz ) > plane.w ) && clipped;
		}
		#pragma unroll_loop_end
		if ( clipped ) discard;
	#endif
#endif`,lu=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
	uniform vec4 clippingPlanes[ NUM_CLIPPING_PLANES ];
#endif`,hu=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
#endif`,uu=`#if NUM_CLIPPING_PLANES > 0
	vClipPosition = - mvPosition.xyz;
#endif`,du=`#if defined( USE_COLOR_ALPHA )
	diffuseColor *= vColor;
#elif defined( USE_COLOR )
	diffuseColor.rgb *= vColor;
#endif`,fu=`#if defined( USE_COLOR_ALPHA )
	varying vec4 vColor;
#elif defined( USE_COLOR )
	varying vec3 vColor;
#endif`,pu=`#if defined( USE_COLOR_ALPHA )
	varying vec4 vColor;
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
	varying vec3 vColor;
#endif`,mu=`#if defined( USE_COLOR_ALPHA )
	vColor = vec4( 1.0 );
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
	vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
	vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
	vColor.xyz *= instanceColor.xyz;
#endif`,gu=`#define PI 3.141592653589793
#define PI2 6.283185307179586
#define PI_HALF 1.5707963267948966
#define RECIPROCAL_PI 0.3183098861837907
#define RECIPROCAL_PI2 0.15915494309189535
#define EPSILON 1e-6
#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
#define whiteComplement( a ) ( 1.0 - saturate( a ) )
float pow2( const in float x ) { return x*x; }
vec3 pow2( const in vec3 x ) { return x*x; }
float pow3( const in float x ) { return x*x*x; }
float pow4( const in float x ) { float x2 = x*x; return x2*x2; }
float max3( const in vec3 v ) { return max( max( v.x, v.y ), v.z ); }
float average( const in vec3 v ) { return dot( v, vec3( 0.3333333 ) ); }
highp float rand( const in vec2 uv ) {
	const highp float a = 12.9898, b = 78.233, c = 43758.5453;
	highp float dt = dot( uv.xy, vec2( a,b ) ), sn = mod( dt, PI );
	return fract( sin( sn ) * c );
}
#ifdef HIGH_PRECISION
	float precisionSafeLength( vec3 v ) { return length( v ); }
#else
	float precisionSafeLength( vec3 v ) {
		float maxComponent = max3( abs( v ) );
		return length( v / maxComponent ) * maxComponent;
	}
#endif
struct IncidentLight {
	vec3 color;
	vec3 direction;
	bool visible;
};
struct ReflectedLight {
	vec3 directDiffuse;
	vec3 directSpecular;
	vec3 indirectDiffuse;
	vec3 indirectSpecular;
};
#ifdef USE_ALPHAHASH
	varying vec3 vPosition;
#endif
vec3 transformDirection( in vec3 dir, in mat4 matrix ) {
	return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );
}
vec3 inverseTransformDirection( in vec3 dir, in mat4 matrix ) {
	return normalize( ( vec4( dir, 0.0 ) * matrix ).xyz );
}
mat3 transposeMat3( const in mat3 m ) {
	mat3 tmp;
	tmp[ 0 ] = vec3( m[ 0 ].x, m[ 1 ].x, m[ 2 ].x );
	tmp[ 1 ] = vec3( m[ 0 ].y, m[ 1 ].y, m[ 2 ].y );
	tmp[ 2 ] = vec3( m[ 0 ].z, m[ 1 ].z, m[ 2 ].z );
	return tmp;
}
float luminance( const in vec3 rgb ) {
	const vec3 weights = vec3( 0.2126729, 0.7151522, 0.0721750 );
	return dot( weights, rgb );
}
bool isPerspectiveMatrix( mat4 m ) {
	return m[ 2 ][ 3 ] == - 1.0;
}
vec2 equirectUv( in vec3 dir ) {
	float u = atan( dir.z, dir.x ) * RECIPROCAL_PI2 + 0.5;
	float v = asin( clamp( dir.y, - 1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5;
	return vec2( u, v );
}
vec3 BRDF_Lambert( const in vec3 diffuseColor ) {
	return RECIPROCAL_PI * diffuseColor;
}
vec3 F_Schlick( const in vec3 f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
}
float F_Schlick( const in float f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
} // validated`,_u=`#ifdef ENVMAP_TYPE_CUBE_UV
	#define cubeUV_minMipLevel 4.0
	#define cubeUV_minTileSize 16.0
	float getFace( vec3 direction ) {
		vec3 absDirection = abs( direction );
		float face = - 1.0;
		if ( absDirection.x > absDirection.z ) {
			if ( absDirection.x > absDirection.y )
				face = direction.x > 0.0 ? 0.0 : 3.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		} else {
			if ( absDirection.z > absDirection.y )
				face = direction.z > 0.0 ? 2.0 : 5.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		}
		return face;
	}
	vec2 getUV( vec3 direction, float face ) {
		vec2 uv;
		if ( face == 0.0 ) {
			uv = vec2( direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 1.0 ) {
			uv = vec2( - direction.x, - direction.z ) / abs( direction.y );
		} else if ( face == 2.0 ) {
			uv = vec2( - direction.x, direction.y ) / abs( direction.z );
		} else if ( face == 3.0 ) {
			uv = vec2( - direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 4.0 ) {
			uv = vec2( - direction.x, direction.z ) / abs( direction.y );
		} else {
			uv = vec2( direction.x, direction.y ) / abs( direction.z );
		}
		return 0.5 * ( uv + 1.0 );
	}
	vec3 bilinearCubeUV( sampler2D envMap, vec3 direction, float mipInt ) {
		float face = getFace( direction );
		float filterInt = max( cubeUV_minMipLevel - mipInt, 0.0 );
		mipInt = max( mipInt, cubeUV_minMipLevel );
		float faceSize = exp2( mipInt );
		highp vec2 uv = getUV( direction, face ) * ( faceSize - 2.0 ) + 1.0;
		if ( face > 2.0 ) {
			uv.y += faceSize;
			face -= 3.0;
		}
		uv.x += face * faceSize;
		uv.x += filterInt * 3.0 * cubeUV_minTileSize;
		uv.y += 4.0 * ( exp2( CUBEUV_MAX_MIP ) - faceSize );
		uv.x *= CUBEUV_TEXEL_WIDTH;
		uv.y *= CUBEUV_TEXEL_HEIGHT;
		#ifdef texture2DGradEXT
			return texture2DGradEXT( envMap, uv, vec2( 0.0 ), vec2( 0.0 ) ).rgb;
		#else
			return texture2D( envMap, uv ).rgb;
		#endif
	}
	#define cubeUV_r0 1.0
	#define cubeUV_m0 - 2.0
	#define cubeUV_r1 0.8
	#define cubeUV_m1 - 1.0
	#define cubeUV_r4 0.4
	#define cubeUV_m4 2.0
	#define cubeUV_r5 0.305
	#define cubeUV_m5 3.0
	#define cubeUV_r6 0.21
	#define cubeUV_m6 4.0
	float roughnessToMip( float roughness ) {
		float mip = 0.0;
		if ( roughness >= cubeUV_r1 ) {
			mip = ( cubeUV_r0 - roughness ) * ( cubeUV_m1 - cubeUV_m0 ) / ( cubeUV_r0 - cubeUV_r1 ) + cubeUV_m0;
		} else if ( roughness >= cubeUV_r4 ) {
			mip = ( cubeUV_r1 - roughness ) * ( cubeUV_m4 - cubeUV_m1 ) / ( cubeUV_r1 - cubeUV_r4 ) + cubeUV_m1;
		} else if ( roughness >= cubeUV_r5 ) {
			mip = ( cubeUV_r4 - roughness ) * ( cubeUV_m5 - cubeUV_m4 ) / ( cubeUV_r4 - cubeUV_r5 ) + cubeUV_m4;
		} else if ( roughness >= cubeUV_r6 ) {
			mip = ( cubeUV_r5 - roughness ) * ( cubeUV_m6 - cubeUV_m5 ) / ( cubeUV_r5 - cubeUV_r6 ) + cubeUV_m5;
		} else {
			mip = - 2.0 * log2( 1.16 * roughness );		}
		return mip;
	}
	vec4 textureCubeUV( sampler2D envMap, vec3 sampleDir, float roughness ) {
		float mip = clamp( roughnessToMip( roughness ), cubeUV_m0, CUBEUV_MAX_MIP );
		float mipF = fract( mip );
		float mipInt = floor( mip );
		vec3 color0 = bilinearCubeUV( envMap, sampleDir, mipInt );
		if ( mipF == 0.0 ) {
			return vec4( color0, 1.0 );
		} else {
			vec3 color1 = bilinearCubeUV( envMap, sampleDir, mipInt + 1.0 );
			return vec4( mix( color0, color1, mipF ), 1.0 );
		}
	}
#endif`,vu=`vec3 transformedNormal = objectNormal;
#ifdef USE_TANGENT
	vec3 transformedTangent = objectTangent;
#endif
#ifdef USE_BATCHING
	mat3 bm = mat3( batchingMatrix );
	transformedNormal /= vec3( dot( bm[ 0 ], bm[ 0 ] ), dot( bm[ 1 ], bm[ 1 ] ), dot( bm[ 2 ], bm[ 2 ] ) );
	transformedNormal = bm * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = bm * transformedTangent;
	#endif
#endif
#ifdef USE_INSTANCING
	mat3 im = mat3( instanceMatrix );
	transformedNormal /= vec3( dot( im[ 0 ], im[ 0 ] ), dot( im[ 1 ], im[ 1 ] ), dot( im[ 2 ], im[ 2 ] ) );
	transformedNormal = im * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = im * transformedTangent;
	#endif
#endif
transformedNormal = normalMatrix * transformedNormal;
#ifdef FLIP_SIDED
	transformedNormal = - transformedNormal;
#endif
#ifdef USE_TANGENT
	transformedTangent = ( modelViewMatrix * vec4( transformedTangent, 0.0 ) ).xyz;
	#ifdef FLIP_SIDED
		transformedTangent = - transformedTangent;
	#endif
#endif`,xu=`#ifdef USE_DISPLACEMENTMAP
	uniform sampler2D displacementMap;
	uniform float displacementScale;
	uniform float displacementBias;
#endif`,yu=`#ifdef USE_DISPLACEMENTMAP
	transformed += normalize( objectNormal ) * ( texture2D( displacementMap, vDisplacementMapUv ).x * displacementScale + displacementBias );
#endif`,Mu=`#ifdef USE_EMISSIVEMAP
	vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
	totalEmissiveRadiance *= emissiveColor.rgb;
#endif`,bu=`#ifdef USE_EMISSIVEMAP
	uniform sampler2D emissiveMap;
#endif`,Su="gl_FragColor = linearToOutputTexel( gl_FragColor );",wu=`
const mat3 LINEAR_SRGB_TO_LINEAR_DISPLAY_P3 = mat3(
	vec3( 0.8224621, 0.177538, 0.0 ),
	vec3( 0.0331941, 0.9668058, 0.0 ),
	vec3( 0.0170827, 0.0723974, 0.9105199 )
);
const mat3 LINEAR_DISPLAY_P3_TO_LINEAR_SRGB = mat3(
	vec3( 1.2249401, - 0.2249404, 0.0 ),
	vec3( - 0.0420569, 1.0420571, 0.0 ),
	vec3( - 0.0196376, - 0.0786361, 1.0982735 )
);
vec4 LinearSRGBToLinearDisplayP3( in vec4 value ) {
	return vec4( value.rgb * LINEAR_SRGB_TO_LINEAR_DISPLAY_P3, value.a );
}
vec4 LinearDisplayP3ToLinearSRGB( in vec4 value ) {
	return vec4( value.rgb * LINEAR_DISPLAY_P3_TO_LINEAR_SRGB, value.a );
}
vec4 LinearTransferOETF( in vec4 value ) {
	return value;
}
vec4 sRGBTransferOETF( in vec4 value ) {
	return vec4( mix( pow( value.rgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), value.rgb * 12.92, vec3( lessThanEqual( value.rgb, vec3( 0.0031308 ) ) ) ), value.a );
}
vec4 LinearToLinear( in vec4 value ) {
	return value;
}
vec4 LinearTosRGB( in vec4 value ) {
	return sRGBTransferOETF( value );
}`,Eu=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vec3 cameraToFrag;
		if ( isOrthographic ) {
			cameraToFrag = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToFrag = normalize( vWorldPosition - cameraPosition );
		}
		vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vec3 reflectVec = reflect( cameraToFrag, worldNormal );
		#else
			vec3 reflectVec = refract( cameraToFrag, worldNormal, refractionRatio );
		#endif
	#else
		vec3 reflectVec = vReflect;
	#endif
	#ifdef ENVMAP_TYPE_CUBE
		vec4 envColor = textureCube( envMap, vec3( flipEnvMap * reflectVec.x, reflectVec.yz ) );
	#else
		vec4 envColor = vec4( 0.0 );
	#endif
	#ifdef ENVMAP_BLENDING_MULTIPLY
		outgoingLight = mix( outgoingLight, outgoingLight * envColor.xyz, specularStrength * reflectivity );
	#elif defined( ENVMAP_BLENDING_MIX )
		outgoingLight = mix( outgoingLight, envColor.xyz, specularStrength * reflectivity );
	#elif defined( ENVMAP_BLENDING_ADD )
		outgoingLight += envColor.xyz * specularStrength * reflectivity;
	#endif
#endif`,Au=`#ifdef USE_ENVMAP
	uniform float envMapIntensity;
	uniform float flipEnvMap;
	#ifdef ENVMAP_TYPE_CUBE
		uniform samplerCube envMap;
	#else
		uniform sampler2D envMap;
	#endif
	
#endif`,Tu=`#ifdef USE_ENVMAP
	uniform float reflectivity;
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		varying vec3 vWorldPosition;
		uniform float refractionRatio;
	#else
		varying vec3 vReflect;
	#endif
#endif`,Cu=`#ifdef USE_ENVMAP
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		
		varying vec3 vWorldPosition;
	#else
		varying vec3 vReflect;
		uniform float refractionRatio;
	#endif
#endif`,Ru=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vWorldPosition = worldPosition.xyz;
	#else
		vec3 cameraToVertex;
		if ( isOrthographic ) {
			cameraToVertex = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToVertex = normalize( worldPosition.xyz - cameraPosition );
		}
		vec3 worldNormal = inverseTransformDirection( transformedNormal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vReflect = reflect( cameraToVertex, worldNormal );
		#else
			vReflect = refract( cameraToVertex, worldNormal, refractionRatio );
		#endif
	#endif
#endif`,Pu=`#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
#endif`,Lu=`#ifdef USE_FOG
	varying float vFogDepth;
#endif`,Iu=`#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`,Du=`#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`,Uu=`#ifdef USE_GRADIENTMAP
	uniform sampler2D gradientMap;
#endif
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
	float dotNL = dot( normal, lightDirection );
	vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.0 );
	#ifdef USE_GRADIENTMAP
		return vec3( texture2D( gradientMap, coord ).r );
	#else
		vec2 fw = fwidth( coord ) * 0.5;
		return mix( vec3( 0.7 ), vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
	#endif
}`,Nu=`#ifdef USE_LIGHTMAP
	vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
	vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;
	reflectedLight.indirectDiffuse += lightMapIrradiance;
#endif`,Fu=`#ifdef USE_LIGHTMAP
	uniform sampler2D lightMap;
	uniform float lightMapIntensity;
#endif`,Ou=`LambertMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularStrength = specularStrength;`,Bu=`varying vec3 vViewPosition;
struct LambertMaterial {
	vec3 diffuseColor;
	float specularStrength;
};
void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Lambert
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Lambert`,zu=`uniform bool receiveShadow;
uniform vec3 ambientLightColor;
#if defined( USE_LIGHT_PROBES )
	uniform vec3 lightProbe[ 9 ];
#endif
vec3 shGetIrradianceAt( in vec3 normal, in vec3 shCoefficients[ 9 ] ) {
	float x = normal.x, y = normal.y, z = normal.z;
	vec3 result = shCoefficients[ 0 ] * 0.886227;
	result += shCoefficients[ 1 ] * 2.0 * 0.511664 * y;
	result += shCoefficients[ 2 ] * 2.0 * 0.511664 * z;
	result += shCoefficients[ 3 ] * 2.0 * 0.511664 * x;
	result += shCoefficients[ 4 ] * 2.0 * 0.429043 * x * y;
	result += shCoefficients[ 5 ] * 2.0 * 0.429043 * y * z;
	result += shCoefficients[ 6 ] * ( 0.743125 * z * z - 0.247708 );
	result += shCoefficients[ 7 ] * 2.0 * 0.429043 * x * z;
	result += shCoefficients[ 8 ] * 0.429043 * ( x * x - y * y );
	return result;
}
vec3 getLightProbeIrradiance( const in vec3 lightProbe[ 9 ], const in vec3 normal ) {
	vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
	vec3 irradiance = shGetIrradianceAt( worldNormal, lightProbe );
	return irradiance;
}
vec3 getAmbientLightIrradiance( const in vec3 ambientLightColor ) {
	vec3 irradiance = ambientLightColor;
	return irradiance;
}
float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {
	#if defined ( LEGACY_LIGHTS )
		if ( cutoffDistance > 0.0 && decayExponent > 0.0 ) {
			return pow( saturate( - lightDistance / cutoffDistance + 1.0 ), decayExponent );
		}
		return 1.0;
	#else
		float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );
		if ( cutoffDistance > 0.0 ) {
			distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );
		}
		return distanceFalloff;
	#endif
}
float getSpotAttenuation( const in float coneCosine, const in float penumbraCosine, const in float angleCosine ) {
	return smoothstep( coneCosine, penumbraCosine, angleCosine );
}
#if NUM_DIR_LIGHTS > 0
	struct DirectionalLight {
		vec3 direction;
		vec3 color;
	};
	uniform DirectionalLight directionalLights[ NUM_DIR_LIGHTS ];
	void getDirectionalLightInfo( const in DirectionalLight directionalLight, out IncidentLight light ) {
		light.color = directionalLight.color;
		light.direction = directionalLight.direction;
		light.visible = true;
	}
#endif
#if NUM_POINT_LIGHTS > 0
	struct PointLight {
		vec3 position;
		vec3 color;
		float distance;
		float decay;
	};
	uniform PointLight pointLights[ NUM_POINT_LIGHTS ];
	void getPointLightInfo( const in PointLight pointLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = pointLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float lightDistance = length( lVector );
		light.color = pointLight.color;
		light.color *= getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay );
		light.visible = ( light.color != vec3( 0.0 ) );
	}
#endif
#if NUM_SPOT_LIGHTS > 0
	struct SpotLight {
		vec3 position;
		vec3 direction;
		vec3 color;
		float distance;
		float decay;
		float coneCos;
		float penumbraCos;
	};
	uniform SpotLight spotLights[ NUM_SPOT_LIGHTS ];
	void getSpotLightInfo( const in SpotLight spotLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = spotLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float angleCos = dot( light.direction, spotLight.direction );
		float spotAttenuation = getSpotAttenuation( spotLight.coneCos, spotLight.penumbraCos, angleCos );
		if ( spotAttenuation > 0.0 ) {
			float lightDistance = length( lVector );
			light.color = spotLight.color * spotAttenuation;
			light.color *= getDistanceAttenuation( lightDistance, spotLight.distance, spotLight.decay );
			light.visible = ( light.color != vec3( 0.0 ) );
		} else {
			light.color = vec3( 0.0 );
			light.visible = false;
		}
	}
#endif
#if NUM_RECT_AREA_LIGHTS > 0
	struct RectAreaLight {
		vec3 color;
		vec3 position;
		vec3 halfWidth;
		vec3 halfHeight;
	};
	uniform sampler2D ltc_1;	uniform sampler2D ltc_2;
	uniform RectAreaLight rectAreaLights[ NUM_RECT_AREA_LIGHTS ];
#endif
#if NUM_HEMI_LIGHTS > 0
	struct HemisphereLight {
		vec3 direction;
		vec3 skyColor;
		vec3 groundColor;
	};
	uniform HemisphereLight hemisphereLights[ NUM_HEMI_LIGHTS ];
	vec3 getHemisphereLightIrradiance( const in HemisphereLight hemiLight, const in vec3 normal ) {
		float dotNL = dot( normal, hemiLight.direction );
		float hemiDiffuseWeight = 0.5 * dotNL + 0.5;
		vec3 irradiance = mix( hemiLight.groundColor, hemiLight.skyColor, hemiDiffuseWeight );
		return irradiance;
	}
#endif`,ku=`#ifdef USE_ENVMAP
	vec3 getIBLIrradiance( const in vec3 normal ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, worldNormal, 1.0 );
			return PI * envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 reflectVec = reflect( - viewDir, normal );
			reflectVec = normalize( mix( reflectVec, normal, roughness * roughness) );
			reflectVec = inverseTransformDirection( reflectVec, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, reflectVec, roughness );
			return envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	#ifdef USE_ANISOTROPY
		vec3 getIBLAnisotropyRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy ) {
			#ifdef ENVMAP_TYPE_CUBE_UV
				vec3 bentNormal = cross( bitangent, viewDir );
				bentNormal = normalize( cross( bentNormal, bitangent ) );
				bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
				return getIBLRadiance( viewDir, bentNormal, roughness );
			#else
				return vec3( 0.0 );
			#endif
		}
	#endif
#endif`,Vu=`ToonMaterial material;
material.diffuseColor = diffuseColor.rgb;`,Hu=`varying vec3 vViewPosition;
struct ToonMaterial {
	vec3 diffuseColor;
};
void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Toon
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Toon`,Gu=`BlinnPhongMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularColor = specular;
material.specularShininess = shininess;
material.specularStrength = specularStrength;`,Wu=`varying vec3 vViewPosition;
struct BlinnPhongMaterial {
	vec3 diffuseColor;
	vec3 specularColor;
	float specularShininess;
	float specularStrength;
};
void RE_Direct_BlinnPhong( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
	reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularShininess ) * material.specularStrength;
}
void RE_IndirectDiffuse_BlinnPhong( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_BlinnPhong
#define RE_IndirectDiffuse		RE_IndirectDiffuse_BlinnPhong`,Xu=`PhysicalMaterial material;
material.diffuseColor = diffuseColor.rgb * ( 1.0 - metalnessFactor );
vec3 dxy = max( abs( dFdx( nonPerturbedNormal ) ), abs( dFdy( nonPerturbedNormal ) ) );
float geometryRoughness = max( max( dxy.x, dxy.y ), dxy.z );
material.roughness = max( roughnessFactor, 0.0525 );material.roughness += geometryRoughness;
material.roughness = min( material.roughness, 1.0 );
#ifdef IOR
	material.ior = ior;
	#ifdef USE_SPECULAR
		float specularIntensityFactor = specularIntensity;
		vec3 specularColorFactor = specularColor;
		#ifdef USE_SPECULAR_COLORMAP
			specularColorFactor *= texture2D( specularColorMap, vSpecularColorMapUv ).rgb;
		#endif
		#ifdef USE_SPECULAR_INTENSITYMAP
			specularIntensityFactor *= texture2D( specularIntensityMap, vSpecularIntensityMapUv ).a;
		#endif
		material.specularF90 = mix( specularIntensityFactor, 1.0, metalnessFactor );
	#else
		float specularIntensityFactor = 1.0;
		vec3 specularColorFactor = vec3( 1.0 );
		material.specularF90 = 1.0;
	#endif
	material.specularColor = mix( min( pow2( ( material.ior - 1.0 ) / ( material.ior + 1.0 ) ) * specularColorFactor, vec3( 1.0 ) ) * specularIntensityFactor, diffuseColor.rgb, metalnessFactor );
#else
	material.specularColor = mix( vec3( 0.04 ), diffuseColor.rgb, metalnessFactor );
	material.specularF90 = 1.0;
#endif
#ifdef USE_CLEARCOAT
	material.clearcoat = clearcoat;
	material.clearcoatRoughness = clearcoatRoughness;
	material.clearcoatF0 = vec3( 0.04 );
	material.clearcoatF90 = 1.0;
	#ifdef USE_CLEARCOATMAP
		material.clearcoat *= texture2D( clearcoatMap, vClearcoatMapUv ).x;
	#endif
	#ifdef USE_CLEARCOAT_ROUGHNESSMAP
		material.clearcoatRoughness *= texture2D( clearcoatRoughnessMap, vClearcoatRoughnessMapUv ).y;
	#endif
	material.clearcoat = saturate( material.clearcoat );	material.clearcoatRoughness = max( material.clearcoatRoughness, 0.0525 );
	material.clearcoatRoughness += geometryRoughness;
	material.clearcoatRoughness = min( material.clearcoatRoughness, 1.0 );
#endif
#ifdef USE_IRIDESCENCE
	material.iridescence = iridescence;
	material.iridescenceIOR = iridescenceIOR;
	#ifdef USE_IRIDESCENCEMAP
		material.iridescence *= texture2D( iridescenceMap, vIridescenceMapUv ).r;
	#endif
	#ifdef USE_IRIDESCENCE_THICKNESSMAP
		material.iridescenceThickness = (iridescenceThicknessMaximum - iridescenceThicknessMinimum) * texture2D( iridescenceThicknessMap, vIridescenceThicknessMapUv ).g + iridescenceThicknessMinimum;
	#else
		material.iridescenceThickness = iridescenceThicknessMaximum;
	#endif
#endif
#ifdef USE_SHEEN
	material.sheenColor = sheenColor;
	#ifdef USE_SHEEN_COLORMAP
		material.sheenColor *= texture2D( sheenColorMap, vSheenColorMapUv ).rgb;
	#endif
	material.sheenRoughness = clamp( sheenRoughness, 0.07, 1.0 );
	#ifdef USE_SHEEN_ROUGHNESSMAP
		material.sheenRoughness *= texture2D( sheenRoughnessMap, vSheenRoughnessMapUv ).a;
	#endif
#endif
#ifdef USE_ANISOTROPY
	#ifdef USE_ANISOTROPYMAP
		mat2 anisotropyMat = mat2( anisotropyVector.x, anisotropyVector.y, - anisotropyVector.y, anisotropyVector.x );
		vec3 anisotropyPolar = texture2D( anisotropyMap, vAnisotropyMapUv ).rgb;
		vec2 anisotropyV = anisotropyMat * normalize( 2.0 * anisotropyPolar.rg - vec2( 1.0 ) ) * anisotropyPolar.b;
	#else
		vec2 anisotropyV = anisotropyVector;
	#endif
	material.anisotropy = length( anisotropyV );
	if( material.anisotropy == 0.0 ) {
		anisotropyV = vec2( 1.0, 0.0 );
	} else {
		anisotropyV /= material.anisotropy;
		material.anisotropy = saturate( material.anisotropy );
	}
	material.alphaT = mix( pow2( material.roughness ), 1.0, pow2( material.anisotropy ) );
	material.anisotropyT = tbn[ 0 ] * anisotropyV.x + tbn[ 1 ] * anisotropyV.y;
	material.anisotropyB = tbn[ 1 ] * anisotropyV.x - tbn[ 0 ] * anisotropyV.y;
#endif`,qu=`struct PhysicalMaterial {
	vec3 diffuseColor;
	float roughness;
	vec3 specularColor;
	float specularF90;
	#ifdef USE_CLEARCOAT
		float clearcoat;
		float clearcoatRoughness;
		vec3 clearcoatF0;
		float clearcoatF90;
	#endif
	#ifdef USE_IRIDESCENCE
		float iridescence;
		float iridescenceIOR;
		float iridescenceThickness;
		vec3 iridescenceFresnel;
		vec3 iridescenceF0;
	#endif
	#ifdef USE_SHEEN
		vec3 sheenColor;
		float sheenRoughness;
	#endif
	#ifdef IOR
		float ior;
	#endif
	#ifdef USE_TRANSMISSION
		float transmission;
		float transmissionAlpha;
		float thickness;
		float attenuationDistance;
		vec3 attenuationColor;
	#endif
	#ifdef USE_ANISOTROPY
		float anisotropy;
		float alphaT;
		vec3 anisotropyT;
		vec3 anisotropyB;
	#endif
};
vec3 clearcoatSpecularDirect = vec3( 0.0 );
vec3 clearcoatSpecularIndirect = vec3( 0.0 );
vec3 sheenSpecularDirect = vec3( 0.0 );
vec3 sheenSpecularIndirect = vec3(0.0 );
vec3 Schlick_to_F0( const in vec3 f, const in float f90, const in float dotVH ) {
    float x = clamp( 1.0 - dotVH, 0.0, 1.0 );
    float x2 = x * x;
    float x5 = clamp( x * x2 * x2, 0.0, 0.9999 );
    return ( f - vec3( f90 ) * x5 ) / ( 1.0 - x5 );
}
float V_GGX_SmithCorrelated( const in float alpha, const in float dotNL, const in float dotNV ) {
	float a2 = pow2( alpha );
	float gv = dotNL * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNV ) );
	float gl = dotNV * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNL ) );
	return 0.5 / max( gv + gl, EPSILON );
}
float D_GGX( const in float alpha, const in float dotNH ) {
	float a2 = pow2( alpha );
	float denom = pow2( dotNH ) * ( a2 - 1.0 ) + 1.0;
	return RECIPROCAL_PI * a2 / pow2( denom );
}
#ifdef USE_ANISOTROPY
	float V_GGX_SmithCorrelated_Anisotropic( const in float alphaT, const in float alphaB, const in float dotTV, const in float dotBV, const in float dotTL, const in float dotBL, const in float dotNV, const in float dotNL ) {
		float gv = dotNL * length( vec3( alphaT * dotTV, alphaB * dotBV, dotNV ) );
		float gl = dotNV * length( vec3( alphaT * dotTL, alphaB * dotBL, dotNL ) );
		float v = 0.5 / ( gv + gl );
		return saturate(v);
	}
	float D_GGX_Anisotropic( const in float alphaT, const in float alphaB, const in float dotNH, const in float dotTH, const in float dotBH ) {
		float a2 = alphaT * alphaB;
		highp vec3 v = vec3( alphaB * dotTH, alphaT * dotBH, a2 * dotNH );
		highp float v2 = dot( v, v );
		float w2 = a2 / v2;
		return RECIPROCAL_PI * a2 * pow2 ( w2 );
	}
#endif
#ifdef USE_CLEARCOAT
	vec3 BRDF_GGX_Clearcoat( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material) {
		vec3 f0 = material.clearcoatF0;
		float f90 = material.clearcoatF90;
		float roughness = material.clearcoatRoughness;
		float alpha = pow2( roughness );
		vec3 halfDir = normalize( lightDir + viewDir );
		float dotNL = saturate( dot( normal, lightDir ) );
		float dotNV = saturate( dot( normal, viewDir ) );
		float dotNH = saturate( dot( normal, halfDir ) );
		float dotVH = saturate( dot( viewDir, halfDir ) );
		vec3 F = F_Schlick( f0, f90, dotVH );
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
		return F * ( V * D );
	}
#endif
vec3 BRDF_GGX( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material ) {
	vec3 f0 = material.specularColor;
	float f90 = material.specularF90;
	float roughness = material.roughness;
	float alpha = pow2( roughness );
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( f0, f90, dotVH );
	#ifdef USE_IRIDESCENCE
		F = mix( F, material.iridescenceFresnel, material.iridescence );
	#endif
	#ifdef USE_ANISOTROPY
		float dotTL = dot( material.anisotropyT, lightDir );
		float dotTV = dot( material.anisotropyT, viewDir );
		float dotTH = dot( material.anisotropyT, halfDir );
		float dotBL = dot( material.anisotropyB, lightDir );
		float dotBV = dot( material.anisotropyB, viewDir );
		float dotBH = dot( material.anisotropyB, halfDir );
		float V = V_GGX_SmithCorrelated_Anisotropic( material.alphaT, alpha, dotTV, dotBV, dotTL, dotBL, dotNV, dotNL );
		float D = D_GGX_Anisotropic( material.alphaT, alpha, dotNH, dotTH, dotBH );
	#else
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
	#endif
	return F * ( V * D );
}
vec2 LTC_Uv( const in vec3 N, const in vec3 V, const in float roughness ) {
	const float LUT_SIZE = 64.0;
	const float LUT_SCALE = ( LUT_SIZE - 1.0 ) / LUT_SIZE;
	const float LUT_BIAS = 0.5 / LUT_SIZE;
	float dotNV = saturate( dot( N, V ) );
	vec2 uv = vec2( roughness, sqrt( 1.0 - dotNV ) );
	uv = uv * LUT_SCALE + LUT_BIAS;
	return uv;
}
float LTC_ClippedSphereFormFactor( const in vec3 f ) {
	float l = length( f );
	return max( ( l * l + f.z ) / ( l + 1.0 ), 0.0 );
}
vec3 LTC_EdgeVectorFormFactor( const in vec3 v1, const in vec3 v2 ) {
	float x = dot( v1, v2 );
	float y = abs( x );
	float a = 0.8543985 + ( 0.4965155 + 0.0145206 * y ) * y;
	float b = 3.4175940 + ( 4.1616724 + y ) * y;
	float v = a / b;
	float theta_sintheta = ( x > 0.0 ) ? v : 0.5 * inversesqrt( max( 1.0 - x * x, 1e-7 ) ) - v;
	return cross( v1, v2 ) * theta_sintheta;
}
vec3 LTC_Evaluate( const in vec3 N, const in vec3 V, const in vec3 P, const in mat3 mInv, const in vec3 rectCoords[ 4 ] ) {
	vec3 v1 = rectCoords[ 1 ] - rectCoords[ 0 ];
	vec3 v2 = rectCoords[ 3 ] - rectCoords[ 0 ];
	vec3 lightNormal = cross( v1, v2 );
	if( dot( lightNormal, P - rectCoords[ 0 ] ) < 0.0 ) return vec3( 0.0 );
	vec3 T1, T2;
	T1 = normalize( V - N * dot( V, N ) );
	T2 = - cross( N, T1 );
	mat3 mat = mInv * transposeMat3( mat3( T1, T2, N ) );
	vec3 coords[ 4 ];
	coords[ 0 ] = mat * ( rectCoords[ 0 ] - P );
	coords[ 1 ] = mat * ( rectCoords[ 1 ] - P );
	coords[ 2 ] = mat * ( rectCoords[ 2 ] - P );
	coords[ 3 ] = mat * ( rectCoords[ 3 ] - P );
	coords[ 0 ] = normalize( coords[ 0 ] );
	coords[ 1 ] = normalize( coords[ 1 ] );
	coords[ 2 ] = normalize( coords[ 2 ] );
	coords[ 3 ] = normalize( coords[ 3 ] );
	vec3 vectorFormFactor = vec3( 0.0 );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 0 ], coords[ 1 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 1 ], coords[ 2 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 2 ], coords[ 3 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 3 ], coords[ 0 ] );
	float result = LTC_ClippedSphereFormFactor( vectorFormFactor );
	return vec3( result );
}
#if defined( USE_SHEEN )
float D_Charlie( float roughness, float dotNH ) {
	float alpha = pow2( roughness );
	float invAlpha = 1.0 / alpha;
	float cos2h = dotNH * dotNH;
	float sin2h = max( 1.0 - cos2h, 0.0078125 );
	return ( 2.0 + invAlpha ) * pow( sin2h, invAlpha * 0.5 ) / ( 2.0 * PI );
}
float V_Neubelt( float dotNV, float dotNL ) {
	return saturate( 1.0 / ( 4.0 * ( dotNL + dotNV - dotNL * dotNV ) ) );
}
vec3 BRDF_Sheen( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, vec3 sheenColor, const in float sheenRoughness ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float D = D_Charlie( sheenRoughness, dotNH );
	float V = V_Neubelt( dotNV, dotNL );
	return sheenColor * ( D * V );
}
#endif
float IBLSheenBRDF( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	float r2 = roughness * roughness;
	float a = roughness < 0.25 ? -339.2 * r2 + 161.4 * roughness - 25.9 : -8.48 * r2 + 14.3 * roughness - 9.95;
	float b = roughness < 0.25 ? 44.0 * r2 - 23.7 * roughness + 3.26 : 1.97 * r2 - 3.27 * roughness + 0.72;
	float DG = exp( a * dotNV + b ) + ( roughness < 0.25 ? 0.0 : 0.1 * ( roughness - 0.25 ) );
	return saturate( DG * RECIPROCAL_PI );
}
vec2 DFGApprox( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	const vec4 c0 = vec4( - 1, - 0.0275, - 0.572, 0.022 );
	const vec4 c1 = vec4( 1, 0.0425, 1.04, - 0.04 );
	vec4 r = roughness * c0 + c1;
	float a004 = min( r.x * r.x, exp2( - 9.28 * dotNV ) ) * r.x + r.y;
	vec2 fab = vec2( - 1.04, 1.04 ) * a004 + r.zw;
	return fab;
}
vec3 EnvironmentBRDF( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness ) {
	vec2 fab = DFGApprox( normal, viewDir, roughness );
	return specularColor * fab.x + specularF90 * fab.y;
}
#ifdef USE_IRIDESCENCE
void computeMultiscatteringIridescence( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float iridescence, const in vec3 iridescenceF0, const in float roughness, inout vec3 singleScatter, inout vec3 multiScatter ) {
#else
void computeMultiscattering( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness, inout vec3 singleScatter, inout vec3 multiScatter ) {
#endif
	vec2 fab = DFGApprox( normal, viewDir, roughness );
	#ifdef USE_IRIDESCENCE
		vec3 Fr = mix( specularColor, iridescenceF0, iridescence );
	#else
		vec3 Fr = specularColor;
	#endif
	vec3 FssEss = Fr * fab.x + specularF90 * fab.y;
	float Ess = fab.x + fab.y;
	float Ems = 1.0 - Ess;
	vec3 Favg = Fr + ( 1.0 - Fr ) * 0.047619;	vec3 Fms = FssEss * Favg / ( 1.0 - Ems * Favg );
	singleScatter += FssEss;
	multiScatter += Fms * Ems;
}
#if NUM_RECT_AREA_LIGHTS > 0
	void RE_Direct_RectArea_Physical( const in RectAreaLight rectAreaLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
		vec3 normal = geometryNormal;
		vec3 viewDir = geometryViewDir;
		vec3 position = geometryPosition;
		vec3 lightPos = rectAreaLight.position;
		vec3 halfWidth = rectAreaLight.halfWidth;
		vec3 halfHeight = rectAreaLight.halfHeight;
		vec3 lightColor = rectAreaLight.color;
		float roughness = material.roughness;
		vec3 rectCoords[ 4 ];
		rectCoords[ 0 ] = lightPos + halfWidth - halfHeight;		rectCoords[ 1 ] = lightPos - halfWidth - halfHeight;
		rectCoords[ 2 ] = lightPos - halfWidth + halfHeight;
		rectCoords[ 3 ] = lightPos + halfWidth + halfHeight;
		vec2 uv = LTC_Uv( normal, viewDir, roughness );
		vec4 t1 = texture2D( ltc_1, uv );
		vec4 t2 = texture2D( ltc_2, uv );
		mat3 mInv = mat3(
			vec3( t1.x, 0, t1.y ),
			vec3(    0, 1,    0 ),
			vec3( t1.z, 0, t1.w )
		);
		vec3 fresnel = ( material.specularColor * t2.x + ( vec3( 1.0 ) - material.specularColor ) * t2.y );
		reflectedLight.directSpecular += lightColor * fresnel * LTC_Evaluate( normal, viewDir, position, mInv, rectCoords );
		reflectedLight.directDiffuse += lightColor * material.diffuseColor * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );
	}
#endif
void RE_Direct_Physical( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	#ifdef USE_CLEARCOAT
		float dotNLcc = saturate( dot( geometryClearcoatNormal, directLight.direction ) );
		vec3 ccIrradiance = dotNLcc * directLight.color;
		clearcoatSpecularDirect += ccIrradiance * BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, material );
	#endif
	#ifdef USE_SHEEN
		sheenSpecularDirect += irradiance * BRDF_Sheen( directLight.direction, geometryViewDir, geometryNormal, material.sheenColor, material.sheenRoughness );
	#endif
	reflectedLight.directSpecular += irradiance * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Physical( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectSpecular_Physical( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
	#ifdef USE_CLEARCOAT
		clearcoatSpecularIndirect += clearcoatRadiance * EnvironmentBRDF( geometryClearcoatNormal, geometryViewDir, material.clearcoatF0, material.clearcoatF90, material.clearcoatRoughness );
	#endif
	#ifdef USE_SHEEN
		sheenSpecularIndirect += irradiance * material.sheenColor * IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
	#endif
	vec3 singleScattering = vec3( 0.0 );
	vec3 multiScattering = vec3( 0.0 );
	vec3 cosineWeightedIrradiance = irradiance * RECIPROCAL_PI;
	#ifdef USE_IRIDESCENCE
		computeMultiscatteringIridescence( geometryNormal, geometryViewDir, material.specularColor, material.specularF90, material.iridescence, material.iridescenceFresnel, material.roughness, singleScattering, multiScattering );
	#else
		computeMultiscattering( geometryNormal, geometryViewDir, material.specularColor, material.specularF90, material.roughness, singleScattering, multiScattering );
	#endif
	vec3 totalScattering = singleScattering + multiScattering;
	vec3 diffuse = material.diffuseColor * ( 1.0 - max( max( totalScattering.r, totalScattering.g ), totalScattering.b ) );
	reflectedLight.indirectSpecular += radiance * singleScattering;
	reflectedLight.indirectSpecular += multiScattering * cosineWeightedIrradiance;
	reflectedLight.indirectDiffuse += diffuse * cosineWeightedIrradiance;
}
#define RE_Direct				RE_Direct_Physical
#define RE_Direct_RectArea		RE_Direct_RectArea_Physical
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Physical
#define RE_IndirectSpecular		RE_IndirectSpecular_Physical
float computeSpecularOcclusion( const in float dotNV, const in float ambientOcclusion, const in float roughness ) {
	return saturate( pow( dotNV + ambientOcclusion, exp2( - 16.0 * roughness - 1.0 ) ) - 1.0 + ambientOcclusion );
}`,Yu=`
vec3 geometryPosition = - vViewPosition;
vec3 geometryNormal = normal;
vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );
vec3 geometryClearcoatNormal = vec3( 0.0 );
#ifdef USE_CLEARCOAT
	geometryClearcoatNormal = clearcoatNormal;
#endif
#ifdef USE_IRIDESCENCE
	float dotNVi = saturate( dot( normal, geometryViewDir ) );
	if ( material.iridescenceThickness == 0.0 ) {
		material.iridescence = 0.0;
	} else {
		material.iridescence = saturate( material.iridescence );
	}
	if ( material.iridescence > 0.0 ) {
		material.iridescenceFresnel = evalIridescence( 1.0, material.iridescenceIOR, dotNVi, material.iridescenceThickness, material.specularColor );
		material.iridescenceF0 = Schlick_to_F0( material.iridescenceFresnel, 1.0, dotNVi );
	}
#endif
IncidentLight directLight;
#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )
	PointLight pointLight;
	#if defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
		pointLight = pointLights[ i ];
		getPointLightInfo( pointLight, geometryPosition, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS )
		pointLightShadow = pointLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowBias, pointLightShadow.shadowRadius, vPointShadowCoord[ i ], pointLightShadow.shadowCameraNear, pointLightShadow.shadowCameraFar ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )
	SpotLight spotLight;
	vec4 spotColor;
	vec3 spotLightCoord;
	bool inSpotLightMap;
	#if defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
		spotLight = spotLights[ i ];
		getSpotLightInfo( spotLight, geometryPosition, directLight );
		#if ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#define SPOT_LIGHT_MAP_INDEX UNROLLED_LOOP_INDEX
		#elif ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		#define SPOT_LIGHT_MAP_INDEX NUM_SPOT_LIGHT_MAPS
		#else
		#define SPOT_LIGHT_MAP_INDEX ( UNROLLED_LOOP_INDEX - NUM_SPOT_LIGHT_SHADOWS + NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#endif
		#if ( SPOT_LIGHT_MAP_INDEX < NUM_SPOT_LIGHT_MAPS )
			spotLightCoord = vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w;
			inSpotLightMap = all( lessThan( abs( spotLightCoord * 2. - 1. ), vec3( 1.0 ) ) );
			spotColor = texture2D( spotLightMap[ SPOT_LIGHT_MAP_INDEX ], spotLightCoord.xy );
			directLight.color = inSpotLightMap ? directLight.color * spotColor.rgb : directLight.color;
		#endif
		#undef SPOT_LIGHT_MAP_INDEX
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		spotLightShadow = spotLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )
	RectAreaLight rectAreaLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_RECT_AREA_LIGHTS; i ++ ) {
		rectAreaLight = rectAreaLights[ i ];
		RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if defined( RE_IndirectDiffuse )
	vec3 iblIrradiance = vec3( 0.0 );
	vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );
	#if defined( USE_LIGHT_PROBES )
		irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );
	#endif
	#if ( NUM_HEMI_LIGHTS > 0 )
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
			irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );
		}
		#pragma unroll_loop_end
	#endif
#endif
#if defined( RE_IndirectSpecular )
	vec3 radiance = vec3( 0.0 );
	vec3 clearcoatRadiance = vec3( 0.0 );
#endif`,Zu=`#if defined( RE_IndirectDiffuse )
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;
		irradiance += lightMapIrradiance;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
		iblIrradiance += getIBLIrradiance( geometryNormal );
	#endif
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
	#ifdef USE_ANISOTROPY
		radiance += getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );
	#else
		radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
	#endif
	#ifdef USE_CLEARCOAT
		clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );
	#endif
#endif`,Ju=`#if defined( RE_IndirectDiffuse )
	RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif
#if defined( RE_IndirectSpecular )
	RE_IndirectSpecular( radiance, iblIrradiance, clearcoatRadiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif`,Ku=`#if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )
	gl_FragDepthEXT = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
#endif`,$u=`#if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )
	uniform float logDepthBufFC;
	varying float vFragDepth;
	varying float vIsPerspective;
#endif`,ju=`#ifdef USE_LOGDEPTHBUF
	#ifdef USE_LOGDEPTHBUF_EXT
		varying float vFragDepth;
		varying float vIsPerspective;
	#else
		uniform float logDepthBufFC;
	#endif
#endif`,Qu=`#ifdef USE_LOGDEPTHBUF
	#ifdef USE_LOGDEPTHBUF_EXT
		vFragDepth = 1.0 + gl_Position.w;
		vIsPerspective = float( isPerspectiveMatrix( projectionMatrix ) );
	#else
		if ( isPerspectiveMatrix( projectionMatrix ) ) {
			gl_Position.z = log2( max( EPSILON, gl_Position.w + 1.0 ) ) * logDepthBufFC - 1.0;
			gl_Position.z *= gl_Position.w;
		}
	#endif
#endif`,td=`#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	#ifdef DECODE_VIDEO_TEXTURE
		sampledDiffuseColor = vec4( mix( pow( sampledDiffuseColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), sampledDiffuseColor.rgb * 0.0773993808, vec3( lessThanEqual( sampledDiffuseColor.rgb, vec3( 0.04045 ) ) ) ), sampledDiffuseColor.w );
	
	#endif
	diffuseColor *= sampledDiffuseColor;
#endif`,ed=`#ifdef USE_MAP
	uniform sampler2D map;
#endif`,nd=`#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
	#if defined( USE_POINTS_UV )
		vec2 uv = vUv;
	#else
		vec2 uv = ( uvTransform * vec3( gl_PointCoord.x, 1.0 - gl_PointCoord.y, 1 ) ).xy;
	#endif
#endif
#ifdef USE_MAP
	diffuseColor *= texture2D( map, uv );
#endif
#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, uv ).g;
#endif`,id=`#if defined( USE_POINTS_UV )
	varying vec2 vUv;
#else
	#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
		uniform mat3 uvTransform;
	#endif
#endif
#ifdef USE_MAP
	uniform sampler2D map;
#endif
#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,sd=`float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
	vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
	metalnessFactor *= texelMetalness.b;
#endif`,rd=`#ifdef USE_METALNESSMAP
	uniform sampler2D metalnessMap;
#endif`,od=`#if defined( USE_MORPHCOLORS ) && defined( MORPHTARGETS_TEXTURE )
	vColor *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		#if defined( USE_COLOR_ALPHA )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ) * morphTargetInfluences[ i ];
		#elif defined( USE_COLOR )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ).rgb * morphTargetInfluences[ i ];
		#endif
	}
#endif`,ad=`#ifdef USE_MORPHNORMALS
	objectNormal *= morphTargetBaseInfluence;
	#ifdef MORPHTARGETS_TEXTURE
		for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
			if ( morphTargetInfluences[ i ] != 0.0 ) objectNormal += getMorph( gl_VertexID, i, 1 ).xyz * morphTargetInfluences[ i ];
		}
	#else
		objectNormal += morphNormal0 * morphTargetInfluences[ 0 ];
		objectNormal += morphNormal1 * morphTargetInfluences[ 1 ];
		objectNormal += morphNormal2 * morphTargetInfluences[ 2 ];
		objectNormal += morphNormal3 * morphTargetInfluences[ 3 ];
	#endif
#endif`,cd=`#ifdef USE_MORPHTARGETS
	uniform float morphTargetBaseInfluence;
	#ifdef MORPHTARGETS_TEXTURE
		uniform float morphTargetInfluences[ MORPHTARGETS_COUNT ];
		uniform sampler2DArray morphTargetsTexture;
		uniform ivec2 morphTargetsTextureSize;
		vec4 getMorph( const in int vertexIndex, const in int morphTargetIndex, const in int offset ) {
			int texelIndex = vertexIndex * MORPHTARGETS_TEXTURE_STRIDE + offset;
			int y = texelIndex / morphTargetsTextureSize.x;
			int x = texelIndex - y * morphTargetsTextureSize.x;
			ivec3 morphUV = ivec3( x, y, morphTargetIndex );
			return texelFetch( morphTargetsTexture, morphUV, 0 );
		}
	#else
		#ifndef USE_MORPHNORMALS
			uniform float morphTargetInfluences[ 8 ];
		#else
			uniform float morphTargetInfluences[ 4 ];
		#endif
	#endif
#endif`,ld=`#ifdef USE_MORPHTARGETS
	transformed *= morphTargetBaseInfluence;
	#ifdef MORPHTARGETS_TEXTURE
		for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
			if ( morphTargetInfluences[ i ] != 0.0 ) transformed += getMorph( gl_VertexID, i, 0 ).xyz * morphTargetInfluences[ i ];
		}
	#else
		transformed += morphTarget0 * morphTargetInfluences[ 0 ];
		transformed += morphTarget1 * morphTargetInfluences[ 1 ];
		transformed += morphTarget2 * morphTargetInfluences[ 2 ];
		transformed += morphTarget3 * morphTargetInfluences[ 3 ];
		#ifndef USE_MORPHNORMALS
			transformed += morphTarget4 * morphTargetInfluences[ 4 ];
			transformed += morphTarget5 * morphTargetInfluences[ 5 ];
			transformed += morphTarget6 * morphTargetInfluences[ 6 ];
			transformed += morphTarget7 * morphTargetInfluences[ 7 ];
		#endif
	#endif
#endif`,hd=`float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
#ifdef FLAT_SHADED
	vec3 fdx = dFdx( vViewPosition );
	vec3 fdy = dFdy( vViewPosition );
	vec3 normal = normalize( cross( fdx, fdy ) );
#else
	vec3 normal = normalize( vNormal );
	#ifdef DOUBLE_SIDED
		normal *= faceDirection;
	#endif
#endif
#if defined( USE_NORMALMAP_TANGENTSPACE ) || defined( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY )
	#ifdef USE_TANGENT
		mat3 tbn = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn = getTangentFrame( - vViewPosition, normal,
		#if defined( USE_NORMALMAP )
			vNormalMapUv
		#elif defined( USE_CLEARCOAT_NORMALMAP )
			vClearcoatNormalMapUv
		#else
			vUv
		#endif
		);
	#endif
	#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
		tbn[0] *= faceDirection;
		tbn[1] *= faceDirection;
	#endif
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	#ifdef USE_TANGENT
		mat3 tbn2 = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn2 = getTangentFrame( - vViewPosition, normal, vClearcoatNormalMapUv );
	#endif
	#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
		tbn2[0] *= faceDirection;
		tbn2[1] *= faceDirection;
	#endif
#endif
vec3 nonPerturbedNormal = normal;`,ud=`#ifdef USE_NORMALMAP_OBJECTSPACE
	normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#ifdef FLIP_SIDED
		normal = - normal;
	#endif
	#ifdef DOUBLE_SIDED
		normal = normal * faceDirection;
	#endif
	normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
	vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	mapN.xy *= normalScale;
	normal = normalize( tbn * mapN );
#elif defined( USE_BUMPMAP )
	normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif`,dd=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,fd=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,pd=`#ifndef FLAT_SHADED
	vNormal = normalize( transformedNormal );
	#ifdef USE_TANGENT
		vTangent = normalize( transformedTangent );
		vBitangent = normalize( cross( vNormal, vTangent ) * tangent.w );
	#endif
#endif`,md=`#ifdef USE_NORMALMAP
	uniform sampler2D normalMap;
	uniform vec2 normalScale;
#endif
#ifdef USE_NORMALMAP_OBJECTSPACE
	uniform mat3 normalMatrix;
#endif
#if ! defined ( USE_TANGENT ) && ( defined ( USE_NORMALMAP_TANGENTSPACE ) || defined ( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY ) )
	mat3 getTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
		vec3 q0 = dFdx( eye_pos.xyz );
		vec3 q1 = dFdy( eye_pos.xyz );
		vec2 st0 = dFdx( uv.st );
		vec2 st1 = dFdy( uv.st );
		vec3 N = surf_norm;
		vec3 q1perp = cross( q1, N );
		vec3 q0perp = cross( N, q0 );
		vec3 T = q1perp * st0.x + q0perp * st1.x;
		vec3 B = q1perp * st0.y + q0perp * st1.y;
		float det = max( dot( T, T ), dot( B, B ) );
		float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
		return mat3( T * scale, B * scale, N );
	}
#endif`,gd=`#ifdef USE_CLEARCOAT
	vec3 clearcoatNormal = nonPerturbedNormal;
#endif`,_d=`#ifdef USE_CLEARCOAT_NORMALMAP
	vec3 clearcoatMapN = texture2D( clearcoatNormalMap, vClearcoatNormalMapUv ).xyz * 2.0 - 1.0;
	clearcoatMapN.xy *= clearcoatNormalScale;
	clearcoatNormal = normalize( tbn2 * clearcoatMapN );
#endif`,vd=`#ifdef USE_CLEARCOATMAP
	uniform sampler2D clearcoatMap;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform sampler2D clearcoatNormalMap;
	uniform vec2 clearcoatNormalScale;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform sampler2D clearcoatRoughnessMap;
#endif`,xd=`#ifdef USE_IRIDESCENCEMAP
	uniform sampler2D iridescenceMap;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform sampler2D iridescenceThicknessMap;
#endif`,yd=`#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
#ifdef USE_TRANSMISSION
diffuseColor.a *= material.transmissionAlpha;
#endif
gl_FragColor = vec4( outgoingLight, diffuseColor.a );`,Md=`vec3 packNormalToRGB( const in vec3 normal ) {
	return normalize( normal ) * 0.5 + 0.5;
}
vec3 unpackRGBToNormal( const in vec3 rgb ) {
	return 2.0 * rgb.xyz - 1.0;
}
const float PackUpscale = 256. / 255.;const float UnpackDownscale = 255. / 256.;
const vec3 PackFactors = vec3( 256. * 256. * 256., 256. * 256., 256. );
const vec4 UnpackFactors = UnpackDownscale / vec4( PackFactors, 1. );
const float ShiftRight8 = 1. / 256.;
vec4 packDepthToRGBA( const in float v ) {
	vec4 r = vec4( fract( v * PackFactors ), v );
	r.yzw -= r.xyz * ShiftRight8;	return r * PackUpscale;
}
float unpackRGBAToDepth( const in vec4 v ) {
	return dot( v, UnpackFactors );
}
vec2 packDepthToRG( in highp float v ) {
	return packDepthToRGBA( v ).yx;
}
float unpackRGToDepth( const in highp vec2 v ) {
	return unpackRGBAToDepth( vec4( v.xy, 0.0, 0.0 ) );
}
vec4 pack2HalfToRGBA( vec2 v ) {
	vec4 r = vec4( v.x, fract( v.x * 255.0 ), v.y, fract( v.y * 255.0 ) );
	return vec4( r.x - r.y / 255.0, r.y, r.z - r.w / 255.0, r.w );
}
vec2 unpackRGBATo2Half( vec4 v ) {
	return vec2( v.x + ( v.y / 255.0 ), v.z + ( v.w / 255.0 ) );
}
float viewZToOrthographicDepth( const in float viewZ, const in float near, const in float far ) {
	return ( viewZ + near ) / ( near - far );
}
float orthographicDepthToViewZ( const in float depth, const in float near, const in float far ) {
	return depth * ( near - far ) - near;
}
float viewZToPerspectiveDepth( const in float viewZ, const in float near, const in float far ) {
	return ( ( near + viewZ ) * far ) / ( ( far - near ) * viewZ );
}
float perspectiveDepthToViewZ( const in float depth, const in float near, const in float far ) {
	return ( near * far ) / ( ( far - near ) * depth - far );
}`,bd=`#ifdef PREMULTIPLIED_ALPHA
	gl_FragColor.rgb *= gl_FragColor.a;
#endif`,Sd=`vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,wd=`#ifdef DITHERING
	gl_FragColor.rgb = dithering( gl_FragColor.rgb );
#endif`,Ed=`#ifdef DITHERING
	vec3 dithering( vec3 color ) {
		float grid_position = rand( gl_FragCoord.xy );
		vec3 dither_shift_RGB = vec3( 0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0 );
		dither_shift_RGB = mix( 2.0 * dither_shift_RGB, -2.0 * dither_shift_RGB, grid_position );
		return color + dither_shift_RGB;
	}
#endif`,Ad=`float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
	vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
	roughnessFactor *= texelRoughness.g;
#endif`,Td=`#ifdef USE_ROUGHNESSMAP
	uniform sampler2D roughnessMap;
#endif`,Cd=`#if NUM_SPOT_LIGHT_COORDS > 0
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#if NUM_SPOT_LIGHT_MAPS > 0
	uniform sampler2D spotLightMap[ NUM_SPOT_LIGHT_MAPS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
		uniform sampler2D directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		uniform sampler2D spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];
		struct SpotLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		uniform sampler2D pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
	float texture2DCompare( sampler2D depths, vec2 uv, float compare ) {
		return step( compare, unpackRGBAToDepth( texture2D( depths, uv ) ) );
	}
	vec2 texture2DDistribution( sampler2D shadow, vec2 uv ) {
		return unpackRGBATo2Half( texture2D( shadow, uv ) );
	}
	float VSMShadow (sampler2D shadow, vec2 uv, float compare ){
		float occlusion = 1.0;
		vec2 distribution = texture2DDistribution( shadow, uv );
		float hard_shadow = step( compare , distribution.x );
		if (hard_shadow != 1.0 ) {
			float distance = compare - distribution.x ;
			float variance = max( 0.00000, distribution.y * distribution.y );
			float softness_probability = variance / (variance + distance * distance );			softness_probability = clamp( ( softness_probability - 0.3 ) / ( 0.95 - 0.3 ), 0.0, 1.0 );			occlusion = clamp( max( hard_shadow, softness_probability ), 0.0, 1.0 );
		}
		return occlusion;
	}
	float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
		float shadow = 1.0;
		shadowCoord.xyz /= shadowCoord.w;
		shadowCoord.z += shadowBias;
		bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
		bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
		if ( frustumTest ) {
		#if defined( SHADOWMAP_TYPE_PCF )
			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
			float dx0 = - texelSize.x * shadowRadius;
			float dy0 = - texelSize.y * shadowRadius;
			float dx1 = + texelSize.x * shadowRadius;
			float dy1 = + texelSize.y * shadowRadius;
			float dx2 = dx0 / 2.0;
			float dy2 = dy0 / 2.0;
			float dx3 = dx1 / 2.0;
			float dy3 = dy1 / 2.0;
			shadow = (
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, dy1 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy1 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, dy1 ), shadowCoord.z )
			) * ( 1.0 / 17.0 );
		#elif defined( SHADOWMAP_TYPE_PCF_SOFT )
			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
			float dx = texelSize.x;
			float dy = texelSize.y;
			vec2 uv = shadowCoord.xy;
			vec2 f = fract( uv * shadowMapSize + 0.5 );
			uv -= f * texelSize;
			shadow = (
				texture2DCompare( shadowMap, uv, shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + vec2( dx, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + vec2( 0.0, dy ), shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + texelSize, shadowCoord.z ) +
				mix( texture2DCompare( shadowMap, uv + vec2( -dx, 0.0 ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, 0.0 ), shadowCoord.z ),
					 f.x ) +
				mix( texture2DCompare( shadowMap, uv + vec2( -dx, dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, dy ), shadowCoord.z ),
					 f.x ) +
				mix( texture2DCompare( shadowMap, uv + vec2( 0.0, -dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 0.0, 2.0 * dy ), shadowCoord.z ),
					 f.y ) +
				mix( texture2DCompare( shadowMap, uv + vec2( dx, -dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( dx, 2.0 * dy ), shadowCoord.z ),
					 f.y ) +
				mix( mix( texture2DCompare( shadowMap, uv + vec2( -dx, -dy ), shadowCoord.z ),
						  texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, -dy ), shadowCoord.z ),
						  f.x ),
					 mix( texture2DCompare( shadowMap, uv + vec2( -dx, 2.0 * dy ), shadowCoord.z ),
						  texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, 2.0 * dy ), shadowCoord.z ),
						  f.x ),
					 f.y )
			) * ( 1.0 / 9.0 );
		#elif defined( SHADOWMAP_TYPE_VSM )
			shadow = VSMShadow( shadowMap, shadowCoord.xy, shadowCoord.z );
		#else
			shadow = texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z );
		#endif
		}
		return shadow;
	}
	vec2 cubeToUV( vec3 v, float texelSizeY ) {
		vec3 absV = abs( v );
		float scaleToCube = 1.0 / max( absV.x, max( absV.y, absV.z ) );
		absV *= scaleToCube;
		v *= scaleToCube * ( 1.0 - 2.0 * texelSizeY );
		vec2 planar = v.xy;
		float almostATexel = 1.5 * texelSizeY;
		float almostOne = 1.0 - almostATexel;
		if ( absV.z >= almostOne ) {
			if ( v.z > 0.0 )
				planar.x = 4.0 - v.x;
		} else if ( absV.x >= almostOne ) {
			float signX = sign( v.x );
			planar.x = v.z * signX + 2.0 * signX;
		} else if ( absV.y >= almostOne ) {
			float signY = sign( v.y );
			planar.x = v.x + 2.0 * signY + 2.0;
			planar.y = v.z * signY - 2.0;
		}
		return vec2( 0.125, 0.25 ) * planar + vec2( 0.375, 0.75 );
	}
	float getPointShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		vec2 texelSize = vec2( 1.0 ) / ( shadowMapSize * vec2( 4.0, 2.0 ) );
		vec3 lightToPosition = shadowCoord.xyz;
		float dp = ( length( lightToPosition ) - shadowCameraNear ) / ( shadowCameraFar - shadowCameraNear );		dp += shadowBias;
		vec3 bd3D = normalize( lightToPosition );
		#if defined( SHADOWMAP_TYPE_PCF ) || defined( SHADOWMAP_TYPE_PCF_SOFT ) || defined( SHADOWMAP_TYPE_VSM )
			vec2 offset = vec2( - 1, 1 ) * shadowRadius * texelSize.y;
			return (
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xyy, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yyy, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xyx, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yyx, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xxy, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yxy, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xxx, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yxx, texelSize.y ), dp )
			) * ( 1.0 / 9.0 );
		#else
			return texture2DCompare( shadowMap, cubeToUV( bd3D, texelSize.y ), dp );
		#endif
	}
#endif`,Rd=`#if NUM_SPOT_LIGHT_COORDS > 0
	uniform mat4 spotLightMatrix[ NUM_SPOT_LIGHT_COORDS ];
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
		uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		struct SpotLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		uniform mat4 pointShadowMatrix[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
#endif`,Pd=`#if ( defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 || NUM_POINT_LIGHT_SHADOWS > 0 ) ) || ( NUM_SPOT_LIGHT_COORDS > 0 )
	vec3 shadowWorldNormal = inverseTransformDirection( transformedNormal, viewMatrix );
	vec4 shadowWorldPosition;
#endif
#if defined( USE_SHADOWMAP )
	#if NUM_DIR_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );
			vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * pointLightShadows[ i ].shadowNormalBias, 0 );
			vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
		shadowWorldPosition = worldPosition;
		#if ( defined( USE_SHADOWMAP ) && UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
			shadowWorldPosition.xyz += shadowWorldNormal * spotLightShadows[ i ].shadowNormalBias;
		#endif
		vSpotLightCoord[ i ] = spotLightMatrix[ i ] * shadowWorldPosition;
	}
	#pragma unroll_loop_end
#endif`,Ld=`float getShadowMask() {
	float shadow = 1.0;
	#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
		directionalLight = directionalLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLight.shadowMapSize, directionalLight.shadowBias, directionalLight.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_SHADOWS; i ++ ) {
		spotLight = spotLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( spotShadowMap[ i ], spotLight.shadowMapSize, spotLight.shadowBias, spotLight.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
		pointLight = pointLightShadows[ i ];
		shadow *= receiveShadow ? getPointShadow( pointShadowMap[ i ], pointLight.shadowMapSize, pointLight.shadowBias, pointLight.shadowRadius, vPointShadowCoord[ i ], pointLight.shadowCameraNear, pointLight.shadowCameraFar ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#endif
	return shadow;
}`,Id=`#ifdef USE_SKINNING
	mat4 boneMatX = getBoneMatrix( skinIndex.x );
	mat4 boneMatY = getBoneMatrix( skinIndex.y );
	mat4 boneMatZ = getBoneMatrix( skinIndex.z );
	mat4 boneMatW = getBoneMatrix( skinIndex.w );
#endif`,Dd=`#ifdef USE_SKINNING
	uniform mat4 bindMatrix;
	uniform mat4 bindMatrixInverse;
	uniform highp sampler2D boneTexture;
	mat4 getBoneMatrix( const in float i ) {
		int size = textureSize( boneTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( boneTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( boneTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( boneTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( boneTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
#endif`,Ud=`#ifdef USE_SKINNING
	vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
	vec4 skinned = vec4( 0.0 );
	skinned += boneMatX * skinVertex * skinWeight.x;
	skinned += boneMatY * skinVertex * skinWeight.y;
	skinned += boneMatZ * skinVertex * skinWeight.z;
	skinned += boneMatW * skinVertex * skinWeight.w;
	transformed = ( bindMatrixInverse * skinned ).xyz;
#endif`,Nd=`#ifdef USE_SKINNING
	mat4 skinMatrix = mat4( 0.0 );
	skinMatrix += skinWeight.x * boneMatX;
	skinMatrix += skinWeight.y * boneMatY;
	skinMatrix += skinWeight.z * boneMatZ;
	skinMatrix += skinWeight.w * boneMatW;
	skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
	objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
	#ifdef USE_TANGENT
		objectTangent = vec4( skinMatrix * vec4( objectTangent, 0.0 ) ).xyz;
	#endif
#endif`,Fd=`float specularStrength;
#ifdef USE_SPECULARMAP
	vec4 texelSpecular = texture2D( specularMap, vSpecularMapUv );
	specularStrength = texelSpecular.r;
#else
	specularStrength = 1.0;
#endif`,Od=`#ifdef USE_SPECULARMAP
	uniform sampler2D specularMap;
#endif`,Bd=`#if defined( TONE_MAPPING )
	gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
#endif`,zd=`#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
uniform float toneMappingExposure;
vec3 LinearToneMapping( vec3 color ) {
	return saturate( toneMappingExposure * color );
}
vec3 ReinhardToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	return saturate( color / ( vec3( 1.0 ) + color ) );
}
vec3 OptimizedCineonToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	color = max( vec3( 0.0 ), color - 0.004 );
	return pow( ( color * ( 6.2 * color + 0.5 ) ) / ( color * ( 6.2 * color + 1.7 ) + 0.06 ), vec3( 2.2 ) );
}
vec3 RRTAndODTFit( vec3 v ) {
	vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
	vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}
vec3 ACESFilmicToneMapping( vec3 color ) {
	const mat3 ACESInputMat = mat3(
		vec3( 0.59719, 0.07600, 0.02840 ),		vec3( 0.35458, 0.90834, 0.13383 ),
		vec3( 0.04823, 0.01566, 0.83777 )
	);
	const mat3 ACESOutputMat = mat3(
		vec3(  1.60475, -0.10208, -0.00327 ),		vec3( -0.53108,  1.10813, -0.07276 ),
		vec3( -0.07367, -0.00605,  1.07602 )
	);
	color *= toneMappingExposure / 0.6;
	color = ACESInputMat * color;
	color = RRTAndODTFit( color );
	color = ACESOutputMat * color;
	return saturate( color );
}
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
	vec3( 1.6605, - 0.1246, - 0.0182 ),
	vec3( - 0.5876, 1.1329, - 0.1006 ),
	vec3( - 0.0728, - 0.0083, 1.1187 )
);
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
	vec3( 0.6274, 0.0691, 0.0164 ),
	vec3( 0.3293, 0.9195, 0.0880 ),
	vec3( 0.0433, 0.0113, 0.8956 )
);
vec3 agxDefaultContrastApprox( vec3 x ) {
	vec3 x2 = x * x;
	vec3 x4 = x2 * x2;
	return + 15.5 * x4 * x2
		- 40.14 * x4 * x
		+ 31.96 * x4
		- 6.868 * x2 * x
		+ 0.4298 * x2
		+ 0.1191 * x
		- 0.00232;
}
vec3 AgXToneMapping( vec3 color ) {
	const mat3 AgXInsetMatrix = mat3(
		vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
		vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
		vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
	);
	const mat3 AgXOutsetMatrix = mat3(
		vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
		vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
		vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 )
	);
	const float AgxMinEv = - 12.47393;	const float AgxMaxEv = 4.026069;
	color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
	color *= toneMappingExposure;
	color = AgXInsetMatrix * color;
	color = max( color, 1e-10 );	color = log2( color );
	color = ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv );
	color = clamp( color, 0.0, 1.0 );
	color = agxDefaultContrastApprox( color );
	color = AgXOutsetMatrix * color;
	color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
	color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
	return color;
}
vec3 CustomToneMapping( vec3 color ) { return color; }`,kd=`#ifdef USE_TRANSMISSION
	material.transmission = transmission;
	material.transmissionAlpha = 1.0;
	material.thickness = thickness;
	material.attenuationDistance = attenuationDistance;
	material.attenuationColor = attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		material.transmission *= texture2D( transmissionMap, vTransmissionMapUv ).r;
	#endif
	#ifdef USE_THICKNESSMAP
		material.thickness *= texture2D( thicknessMap, vThicknessMapUv ).g;
	#endif
	vec3 pos = vWorldPosition;
	vec3 v = normalize( cameraPosition - pos );
	vec3 n = inverseTransformDirection( normal, viewMatrix );
	vec4 transmitted = getIBLVolumeRefraction(
		n, v, material.roughness, material.diffuseColor, material.specularColor, material.specularF90,
		pos, modelMatrix, viewMatrix, projectionMatrix, material.ior, material.thickness,
		material.attenuationColor, material.attenuationDistance );
	material.transmissionAlpha = mix( material.transmissionAlpha, transmitted.a, material.transmission );
	totalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );
#endif`,Vd=`#ifdef USE_TRANSMISSION
	uniform float transmission;
	uniform float thickness;
	uniform float attenuationDistance;
	uniform vec3 attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		uniform sampler2D transmissionMap;
	#endif
	#ifdef USE_THICKNESSMAP
		uniform sampler2D thicknessMap;
	#endif
	uniform vec2 transmissionSamplerSize;
	uniform sampler2D transmissionSamplerMap;
	uniform mat4 modelMatrix;
	uniform mat4 projectionMatrix;
	varying vec3 vWorldPosition;
	float w0( float a ) {
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - a + 3.0 ) - 3.0 ) + 1.0 );
	}
	float w1( float a ) {
		return ( 1.0 / 6.0 ) * ( a *  a * ( 3.0 * a - 6.0 ) + 4.0 );
	}
	float w2( float a ){
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - 3.0 * a + 3.0 ) + 3.0 ) + 1.0 );
	}
	float w3( float a ) {
		return ( 1.0 / 6.0 ) * ( a * a * a );
	}
	float g0( float a ) {
		return w0( a ) + w1( a );
	}
	float g1( float a ) {
		return w2( a ) + w3( a );
	}
	float h0( float a ) {
		return - 1.0 + w1( a ) / ( w0( a ) + w1( a ) );
	}
	float h1( float a ) {
		return 1.0 + w3( a ) / ( w2( a ) + w3( a ) );
	}
	vec4 bicubic( sampler2D tex, vec2 uv, vec4 texelSize, float lod ) {
		uv = uv * texelSize.zw + 0.5;
		vec2 iuv = floor( uv );
		vec2 fuv = fract( uv );
		float g0x = g0( fuv.x );
		float g1x = g1( fuv.x );
		float h0x = h0( fuv.x );
		float h1x = h1( fuv.x );
		float h0y = h0( fuv.y );
		float h1y = h1( fuv.y );
		vec2 p0 = ( vec2( iuv.x + h0x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p1 = ( vec2( iuv.x + h1x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p2 = ( vec2( iuv.x + h0x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		vec2 p3 = ( vec2( iuv.x + h1x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		return g0( fuv.y ) * ( g0x * textureLod( tex, p0, lod ) + g1x * textureLod( tex, p1, lod ) ) +
			g1( fuv.y ) * ( g0x * textureLod( tex, p2, lod ) + g1x * textureLod( tex, p3, lod ) );
	}
	vec4 textureBicubic( sampler2D sampler, vec2 uv, float lod ) {
		vec2 fLodSize = vec2( textureSize( sampler, int( lod ) ) );
		vec2 cLodSize = vec2( textureSize( sampler, int( lod + 1.0 ) ) );
		vec2 fLodSizeInv = 1.0 / fLodSize;
		vec2 cLodSizeInv = 1.0 / cLodSize;
		vec4 fSample = bicubic( sampler, uv, vec4( fLodSizeInv, fLodSize ), floor( lod ) );
		vec4 cSample = bicubic( sampler, uv, vec4( cLodSizeInv, cLodSize ), ceil( lod ) );
		return mix( fSample, cSample, fract( lod ) );
	}
	vec3 getVolumeTransmissionRay( const in vec3 n, const in vec3 v, const in float thickness, const in float ior, const in mat4 modelMatrix ) {
		vec3 refractionVector = refract( - v, normalize( n ), 1.0 / ior );
		vec3 modelScale;
		modelScale.x = length( vec3( modelMatrix[ 0 ].xyz ) );
		modelScale.y = length( vec3( modelMatrix[ 1 ].xyz ) );
		modelScale.z = length( vec3( modelMatrix[ 2 ].xyz ) );
		return normalize( refractionVector ) * thickness * modelScale;
	}
	float applyIorToRoughness( const in float roughness, const in float ior ) {
		return roughness * clamp( ior * 2.0 - 2.0, 0.0, 1.0 );
	}
	vec4 getTransmissionSample( const in vec2 fragCoord, const in float roughness, const in float ior ) {
		float lod = log2( transmissionSamplerSize.x ) * applyIorToRoughness( roughness, ior );
		return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );
	}
	vec3 volumeAttenuation( const in float transmissionDistance, const in vec3 attenuationColor, const in float attenuationDistance ) {
		if ( isinf( attenuationDistance ) ) {
			return vec3( 1.0 );
		} else {
			vec3 attenuationCoefficient = -log( attenuationColor ) / attenuationDistance;
			vec3 transmittance = exp( - attenuationCoefficient * transmissionDistance );			return transmittance;
		}
	}
	vec4 getIBLVolumeRefraction( const in vec3 n, const in vec3 v, const in float roughness, const in vec3 diffuseColor,
		const in vec3 specularColor, const in float specularF90, const in vec3 position, const in mat4 modelMatrix,
		const in mat4 viewMatrix, const in mat4 projMatrix, const in float ior, const in float thickness,
		const in vec3 attenuationColor, const in float attenuationDistance ) {
		vec3 transmissionRay = getVolumeTransmissionRay( n, v, thickness, ior, modelMatrix );
		vec3 refractedRayExit = position + transmissionRay;
		vec4 ndcPos = projMatrix * viewMatrix * vec4( refractedRayExit, 1.0 );
		vec2 refractionCoords = ndcPos.xy / ndcPos.w;
		refractionCoords += 1.0;
		refractionCoords /= 2.0;
		vec4 transmittedLight = getTransmissionSample( refractionCoords, roughness, ior );
		vec3 transmittance = diffuseColor * volumeAttenuation( length( transmissionRay ), attenuationColor, attenuationDistance );
		vec3 attenuatedColor = transmittance * transmittedLight.rgb;
		vec3 F = EnvironmentBRDF( n, v, specularColor, specularF90, roughness );
		float transmittanceFactor = ( transmittance.r + transmittance.g + transmittance.b ) / 3.0;
		return vec4( ( 1.0 - F ) * attenuatedColor, 1.0 - ( 1.0 - transmittedLight.a ) * transmittanceFactor );
	}
#endif`,Hd=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_SPECULARMAP
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,Gd=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	uniform mat3 mapTransform;
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	uniform mat3 alphaMapTransform;
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	uniform mat3 lightMapTransform;
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	uniform mat3 aoMapTransform;
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	uniform mat3 bumpMapTransform;
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	uniform mat3 normalMapTransform;
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_DISPLACEMENTMAP
	uniform mat3 displacementMapTransform;
	varying vec2 vDisplacementMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	uniform mat3 emissiveMapTransform;
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	uniform mat3 metalnessMapTransform;
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	uniform mat3 roughnessMapTransform;
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	uniform mat3 anisotropyMapTransform;
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	uniform mat3 clearcoatMapTransform;
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform mat3 clearcoatNormalMapTransform;
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform mat3 clearcoatRoughnessMapTransform;
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	uniform mat3 sheenColorMapTransform;
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	uniform mat3 sheenRoughnessMapTransform;
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	uniform mat3 iridescenceMapTransform;
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform mat3 iridescenceThicknessMapTransform;
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SPECULARMAP
	uniform mat3 specularMapTransform;
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	uniform mat3 specularColorMapTransform;
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	uniform mat3 specularIntensityMapTransform;
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,Wd=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	vUv = vec3( uv, 1 ).xy;
#endif
#ifdef USE_MAP
	vMapUv = ( mapTransform * vec3( MAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ALPHAMAP
	vAlphaMapUv = ( alphaMapTransform * vec3( ALPHAMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_LIGHTMAP
	vLightMapUv = ( lightMapTransform * vec3( LIGHTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_AOMAP
	vAoMapUv = ( aoMapTransform * vec3( AOMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_BUMPMAP
	vBumpMapUv = ( bumpMapTransform * vec3( BUMPMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_NORMALMAP
	vNormalMapUv = ( normalMapTransform * vec3( NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_DISPLACEMENTMAP
	vDisplacementMapUv = ( displacementMapTransform * vec3( DISPLACEMENTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_EMISSIVEMAP
	vEmissiveMapUv = ( emissiveMapTransform * vec3( EMISSIVEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_METALNESSMAP
	vMetalnessMapUv = ( metalnessMapTransform * vec3( METALNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ROUGHNESSMAP
	vRoughnessMapUv = ( roughnessMapTransform * vec3( ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ANISOTROPYMAP
	vAnisotropyMapUv = ( anisotropyMapTransform * vec3( ANISOTROPYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOATMAP
	vClearcoatMapUv = ( clearcoatMapTransform * vec3( CLEARCOATMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	vClearcoatNormalMapUv = ( clearcoatNormalMapTransform * vec3( CLEARCOAT_NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	vClearcoatRoughnessMapUv = ( clearcoatRoughnessMapTransform * vec3( CLEARCOAT_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCEMAP
	vIridescenceMapUv = ( iridescenceMapTransform * vec3( IRIDESCENCEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	vIridescenceThicknessMapUv = ( iridescenceThicknessMapTransform * vec3( IRIDESCENCE_THICKNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_COLORMAP
	vSheenColorMapUv = ( sheenColorMapTransform * vec3( SHEEN_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	vSheenRoughnessMapUv = ( sheenRoughnessMapTransform * vec3( SHEEN_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULARMAP
	vSpecularMapUv = ( specularMapTransform * vec3( SPECULARMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_COLORMAP
	vSpecularColorMapUv = ( specularColorMapTransform * vec3( SPECULAR_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	vSpecularIntensityMapUv = ( specularIntensityMapTransform * vec3( SPECULAR_INTENSITYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_TRANSMISSIONMAP
	vTransmissionMapUv = ( transmissionMapTransform * vec3( TRANSMISSIONMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_THICKNESSMAP
	vThicknessMapUv = ( thicknessMapTransform * vec3( THICKNESSMAP_UV, 1 ) ).xy;
#endif`,Xd=`#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
	vec4 worldPosition = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		worldPosition = batchingMatrix * worldPosition;
	#endif
	#ifdef USE_INSTANCING
		worldPosition = instanceMatrix * worldPosition;
	#endif
	worldPosition = modelMatrix * worldPosition;
#endif`,qd=`varying vec2 vUv;
uniform mat3 uvTransform;
void main() {
	vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	gl_Position = vec4( position.xy, 1.0, 1.0 );
}`,Yd=`uniform sampler2D t2D;
uniform float backgroundIntensity;
varying vec2 vUv;
void main() {
	vec4 texColor = texture2D( t2D, vUv );
	#ifdef DECODE_VIDEO_TEXTURE
		texColor = vec4( mix( pow( texColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), texColor.rgb * 0.0773993808, vec3( lessThanEqual( texColor.rgb, vec3( 0.04045 ) ) ) ), texColor.w );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,Zd=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,Jd=`#ifdef ENVMAP_TYPE_CUBE
	uniform samplerCube envMap;
#elif defined( ENVMAP_TYPE_CUBE_UV )
	uniform sampler2D envMap;
#endif
uniform float flipEnvMap;
uniform float backgroundBlurriness;
uniform float backgroundIntensity;
varying vec3 vWorldDirection;
#include <cube_uv_reflection_fragment>
void main() {
	#ifdef ENVMAP_TYPE_CUBE
		vec4 texColor = textureCube( envMap, vec3( flipEnvMap * vWorldDirection.x, vWorldDirection.yz ) );
	#elif defined( ENVMAP_TYPE_CUBE_UV )
		vec4 texColor = textureCubeUV( envMap, vWorldDirection, backgroundBlurriness );
	#else
		vec4 texColor = vec4( 0.0, 0.0, 0.0, 1.0 );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,Kd=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,$d=`uniform samplerCube tCube;
uniform float tFlip;
uniform float opacity;
varying vec3 vWorldDirection;
void main() {
	vec4 texColor = textureCube( tCube, vec3( tFlip * vWorldDirection.x, vWorldDirection.yz ) );
	gl_FragColor = texColor;
	gl_FragColor.a *= opacity;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,jd=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
varying vec2 vHighPrecisionZW;
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vHighPrecisionZW = gl_Position.zw;
}`,Qd=`#if DEPTH_PACKING == 3200
	uniform float opacity;
#endif
#include <common>
#include <packing>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
varying vec2 vHighPrecisionZW;
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( 1.0 );
	#if DEPTH_PACKING == 3200
		diffuseColor.a = opacity;
	#endif
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <logdepthbuf_fragment>
	float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
	#if DEPTH_PACKING == 3200
		gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );
	#elif DEPTH_PACKING == 3201
		gl_FragColor = packDepthToRGBA( fragCoordZ );
	#endif
}`,tf=`#define DISTANCE
varying vec3 vWorldPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <worldpos_vertex>
	#include <clipping_planes_vertex>
	vWorldPosition = worldPosition.xyz;
}`,ef=`#define DISTANCE
uniform vec3 referencePosition;
uniform float nearDistance;
uniform float farDistance;
varying vec3 vWorldPosition;
#include <common>
#include <packing>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <clipping_planes_pars_fragment>
void main () {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( 1.0 );
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	float dist = length( vWorldPosition - referencePosition );
	dist = ( dist - nearDistance ) / ( farDistance - nearDistance );
	dist = saturate( dist );
	gl_FragColor = packDepthToRGBA( dist );
}`,nf=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
}`,sf=`uniform sampler2D tEquirect;
varying vec3 vWorldDirection;
#include <common>
void main() {
	vec3 direction = normalize( vWorldDirection );
	vec2 sampleUV = equirectUv( direction );
	gl_FragColor = texture2D( tEquirect, sampleUV );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,rf=`uniform float scale;
attribute float lineDistance;
varying float vLineDistance;
#include <common>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	vLineDistance = scale * lineDistance;
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,of=`uniform vec3 diffuse;
uniform float opacity;
uniform float dashSize;
uniform float totalSize;
varying float vLineDistance;
#include <common>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	if ( mod( vLineDistance, totalSize ) > dashSize ) {
		discard;
	}
	vec3 outgoingLight = vec3( 0.0 );
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,af=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinbase_vertex>
		#include <skinnormal_vertex>
		#include <defaultnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <fog_vertex>
}`,cf=`uniform vec3 diffuse;
uniform float opacity;
#ifndef FLAT_SHADED
	varying vec3 vNormal;
#endif
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;
	#else
		reflectedLight.indirectDiffuse += vec3( 1.0 );
	#endif
	#include <aomap_fragment>
	reflectedLight.indirectDiffuse *= diffuseColor.rgb;
	vec3 outgoingLight = reflectedLight.indirectDiffuse;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,lf=`#define LAMBERT
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,hf=`#define LAMBERT
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_lambert_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_lambert_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,uf=`#define MATCAP
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <displacementmap_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
	vViewPosition = - mvPosition.xyz;
}`,df=`#define MATCAP
uniform vec3 diffuse;
uniform float opacity;
uniform sampler2D matcap;
varying vec3 vViewPosition;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	vec3 viewDir = normalize( vViewPosition );
	vec3 x = normalize( vec3( viewDir.z, 0.0, - viewDir.x ) );
	vec3 y = cross( viewDir, x );
	vec2 uv = vec2( dot( x, normal ), dot( y, normal ) ) * 0.495 + 0.5;
	#ifdef USE_MATCAP
		vec4 matcapColor = texture2D( matcap, uv );
	#else
		vec4 matcapColor = vec4( vec3( mix( 0.2, 0.8, uv.y ) ), 1.0 );
	#endif
	vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,ff=`#define NORMAL
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	vViewPosition = - mvPosition.xyz;
#endif
}`,pf=`#define NORMAL
uniform float opacity;
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <packing>
#include <uv_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	gl_FragColor = vec4( packNormalToRGB( normal ), opacity );
	#ifdef OPAQUE
		gl_FragColor.a = 1.0;
	#endif
}`,mf=`#define PHONG
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,gf=`#define PHONG
uniform vec3 diffuse;
uniform vec3 emissive;
uniform vec3 specular;
uniform float shininess;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_phong_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_phong_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,_f=`#define STANDARD
varying vec3 vViewPosition;
#ifdef USE_TRANSMISSION
	varying vec3 vWorldPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
#ifdef USE_TRANSMISSION
	vWorldPosition = worldPosition.xyz;
#endif
}`,vf=`#define STANDARD
#ifdef PHYSICAL
	#define IOR
	#define USE_SPECULAR
#endif
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float roughness;
uniform float metalness;
uniform float opacity;
#ifdef IOR
	uniform float ior;
#endif
#ifdef USE_SPECULAR
	uniform float specularIntensity;
	uniform vec3 specularColor;
	#ifdef USE_SPECULAR_COLORMAP
		uniform sampler2D specularColorMap;
	#endif
	#ifdef USE_SPECULAR_INTENSITYMAP
		uniform sampler2D specularIntensityMap;
	#endif
#endif
#ifdef USE_CLEARCOAT
	uniform float clearcoat;
	uniform float clearcoatRoughness;
#endif
#ifdef USE_IRIDESCENCE
	uniform float iridescence;
	uniform float iridescenceIOR;
	uniform float iridescenceThicknessMinimum;
	uniform float iridescenceThicknessMaximum;
#endif
#ifdef USE_SHEEN
	uniform vec3 sheenColor;
	uniform float sheenRoughness;
	#ifdef USE_SHEEN_COLORMAP
		uniform sampler2D sheenColorMap;
	#endif
	#ifdef USE_SHEEN_ROUGHNESSMAP
		uniform sampler2D sheenRoughnessMap;
	#endif
#endif
#ifdef USE_ANISOTROPY
	uniform vec2 anisotropyVector;
	#ifdef USE_ANISOTROPYMAP
		uniform sampler2D anisotropyMap;
	#endif
#endif
varying vec3 vViewPosition;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <iridescence_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_physical_pars_fragment>
#include <transmission_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <clearcoat_pars_fragment>
#include <iridescence_pars_fragment>
#include <roughnessmap_pars_fragment>
#include <metalnessmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <roughnessmap_fragment>
	#include <metalnessmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <clearcoat_normal_fragment_begin>
	#include <clearcoat_normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_physical_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
	vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
	#include <transmission_fragment>
	vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
	#ifdef USE_SHEEN
		float sheenEnergyComp = 1.0 - 0.157 * max3( material.sheenColor );
		outgoingLight = outgoingLight * sheenEnergyComp + sheenSpecularDirect + sheenSpecularIndirect;
	#endif
	#ifdef USE_CLEARCOAT
		float dotNVcc = saturate( dot( geometryClearcoatNormal, geometryViewDir ) );
		vec3 Fcc = F_Schlick( material.clearcoatF0, material.clearcoatF90, dotNVcc );
		outgoingLight = outgoingLight * ( 1.0 - material.clearcoat * Fcc ) + ( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * material.clearcoat;
	#endif
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,xf=`#define TOON
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,yf=`#define TOON
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <gradientmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_toon_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_toon_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,Mf=`uniform float size;
uniform float scale;
#include <common>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
#ifdef USE_POINTS_UV
	varying vec2 vUv;
	uniform mat3 uvTransform;
#endif
void main() {
	#ifdef USE_POINTS_UV
		vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	#endif
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	gl_PointSize = size;
	#ifdef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) gl_PointSize *= ( scale / - mvPosition.z );
	#endif
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <fog_vertex>
}`,bf=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <color_pars_fragment>
#include <map_particle_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_particle_fragment>
	#include <color_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,Sf=`#include <common>
#include <batching_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
void main() {
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,wf=`uniform vec3 color;
uniform float opacity;
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
void main() {
	#include <logdepthbuf_fragment>
	gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,Ef=`uniform float rotation;
uniform vec2 center;
#include <common>
#include <uv_pars_vertex>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	vec4 mvPosition = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
	vec2 scale;
	scale.x = length( vec3( modelMatrix[ 0 ].x, modelMatrix[ 0 ].y, modelMatrix[ 0 ].z ) );
	scale.y = length( vec3( modelMatrix[ 1 ].x, modelMatrix[ 1 ].y, modelMatrix[ 1 ].z ) );
	#ifndef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) scale *= - mvPosition.z;
	#endif
	vec2 alignedPosition = ( position.xy - ( center - vec2( 0.5 ) ) ) * scale;
	vec2 rotatedPosition;
	rotatedPosition.x = cos( rotation ) * alignedPosition.x - sin( rotation ) * alignedPosition.y;
	rotatedPosition.y = sin( rotation ) * alignedPosition.x + cos( rotation ) * alignedPosition.y;
	mvPosition.xy += rotatedPosition;
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,Af=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,kt={alphahash_fragment:Yh,alphahash_pars_fragment:Zh,alphamap_fragment:Jh,alphamap_pars_fragment:Kh,alphatest_fragment:$h,alphatest_pars_fragment:jh,aomap_fragment:Qh,aomap_pars_fragment:tu,batching_pars_vertex:eu,batching_vertex:nu,begin_vertex:iu,beginnormal_vertex:su,bsdfs:ru,iridescence_fragment:ou,bumpmap_pars_fragment:au,clipping_planes_fragment:cu,clipping_planes_pars_fragment:lu,clipping_planes_pars_vertex:hu,clipping_planes_vertex:uu,color_fragment:du,color_pars_fragment:fu,color_pars_vertex:pu,color_vertex:mu,common:gu,cube_uv_reflection_fragment:_u,defaultnormal_vertex:vu,displacementmap_pars_vertex:xu,displacementmap_vertex:yu,emissivemap_fragment:Mu,emissivemap_pars_fragment:bu,colorspace_fragment:Su,colorspace_pars_fragment:wu,envmap_fragment:Eu,envmap_common_pars_fragment:Au,envmap_pars_fragment:Tu,envmap_pars_vertex:Cu,envmap_physical_pars_fragment:ku,envmap_vertex:Ru,fog_vertex:Pu,fog_pars_vertex:Lu,fog_fragment:Iu,fog_pars_fragment:Du,gradientmap_pars_fragment:Uu,lightmap_fragment:Nu,lightmap_pars_fragment:Fu,lights_lambert_fragment:Ou,lights_lambert_pars_fragment:Bu,lights_pars_begin:zu,lights_toon_fragment:Vu,lights_toon_pars_fragment:Hu,lights_phong_fragment:Gu,lights_phong_pars_fragment:Wu,lights_physical_fragment:Xu,lights_physical_pars_fragment:qu,lights_fragment_begin:Yu,lights_fragment_maps:Zu,lights_fragment_end:Ju,logdepthbuf_fragment:Ku,logdepthbuf_pars_fragment:$u,logdepthbuf_pars_vertex:ju,logdepthbuf_vertex:Qu,map_fragment:td,map_pars_fragment:ed,map_particle_fragment:nd,map_particle_pars_fragment:id,metalnessmap_fragment:sd,metalnessmap_pars_fragment:rd,morphcolor_vertex:od,morphnormal_vertex:ad,morphtarget_pars_vertex:cd,morphtarget_vertex:ld,normal_fragment_begin:hd,normal_fragment_maps:ud,normal_pars_fragment:dd,normal_pars_vertex:fd,normal_vertex:pd,normalmap_pars_fragment:md,clearcoat_normal_fragment_begin:gd,clearcoat_normal_fragment_maps:_d,clearcoat_pars_fragment:vd,iridescence_pars_fragment:xd,opaque_fragment:yd,packing:Md,premultiplied_alpha_fragment:bd,project_vertex:Sd,dithering_fragment:wd,dithering_pars_fragment:Ed,roughnessmap_fragment:Ad,roughnessmap_pars_fragment:Td,shadowmap_pars_fragment:Cd,shadowmap_pars_vertex:Rd,shadowmap_vertex:Pd,shadowmask_pars_fragment:Ld,skinbase_vertex:Id,skinning_pars_vertex:Dd,skinning_vertex:Ud,skinnormal_vertex:Nd,specularmap_fragment:Fd,specularmap_pars_fragment:Od,tonemapping_fragment:Bd,tonemapping_pars_fragment:zd,transmission_fragment:kd,transmission_pars_fragment:Vd,uv_pars_fragment:Hd,uv_pars_vertex:Gd,uv_vertex:Wd,worldpos_vertex:Xd,background_vert:qd,background_frag:Yd,backgroundCube_vert:Zd,backgroundCube_frag:Jd,cube_vert:Kd,cube_frag:$d,depth_vert:jd,depth_frag:Qd,distanceRGBA_vert:tf,distanceRGBA_frag:ef,equirect_vert:nf,equirect_frag:sf,linedashed_vert:rf,linedashed_frag:of,meshbasic_vert:af,meshbasic_frag:cf,meshlambert_vert:lf,meshlambert_frag:hf,meshmatcap_vert:uf,meshmatcap_frag:df,meshnormal_vert:ff,meshnormal_frag:pf,meshphong_vert:mf,meshphong_frag:gf,meshphysical_vert:_f,meshphysical_frag:vf,meshtoon_vert:xf,meshtoon_frag:yf,points_vert:Mf,points_frag:bf,shadow_vert:Sf,shadow_frag:wf,sprite_vert:Ef,sprite_frag:Af},dt={common:{diffuse:{value:new zt(16777215)},opacity:{value:1},map:{value:null},mapTransform:{value:new Gt},alphaMap:{value:null},alphaMapTransform:{value:new Gt},alphaTest:{value:0}},specularmap:{specularMap:{value:null},specularMapTransform:{value:new Gt}},envmap:{envMap:{value:null},flipEnvMap:{value:-1},reflectivity:{value:1},ior:{value:1.5},refractionRatio:{value:.98}},aomap:{aoMap:{value:null},aoMapIntensity:{value:1},aoMapTransform:{value:new Gt}},lightmap:{lightMap:{value:null},lightMapIntensity:{value:1},lightMapTransform:{value:new Gt}},bumpmap:{bumpMap:{value:null},bumpMapTransform:{value:new Gt},bumpScale:{value:1}},normalmap:{normalMap:{value:null},normalMapTransform:{value:new Gt},normalScale:{value:new Lt(1,1)}},displacementmap:{displacementMap:{value:null},displacementMapTransform:{value:new Gt},displacementScale:{value:1},displacementBias:{value:0}},emissivemap:{emissiveMap:{value:null},emissiveMapTransform:{value:new Gt}},metalnessmap:{metalnessMap:{value:null},metalnessMapTransform:{value:new Gt}},roughnessmap:{roughnessMap:{value:null},roughnessMapTransform:{value:new Gt}},gradientmap:{gradientMap:{value:null}},fog:{fogDensity:{value:25e-5},fogNear:{value:1},fogFar:{value:2e3},fogColor:{value:new zt(16777215)}},lights:{ambientLightColor:{value:[]},lightProbe:{value:[]},directionalLights:{value:[],properties:{direction:{},color:{}}},directionalLightShadows:{value:[],properties:{shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},directionalShadowMap:{value:[]},directionalShadowMatrix:{value:[]},spotLights:{value:[],properties:{color:{},position:{},direction:{},distance:{},coneCos:{},penumbraCos:{},decay:{}}},spotLightShadows:{value:[],properties:{shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},spotLightMap:{value:[]},spotShadowMap:{value:[]},spotLightMatrix:{value:[]},pointLights:{value:[],properties:{color:{},position:{},decay:{},distance:{}}},pointLightShadows:{value:[],properties:{shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{},shadowCameraNear:{},shadowCameraFar:{}}},pointShadowMap:{value:[]},pointShadowMatrix:{value:[]},hemisphereLights:{value:[],properties:{direction:{},skyColor:{},groundColor:{}}},rectAreaLights:{value:[],properties:{color:{},position:{},width:{},height:{}}},ltc_1:{value:null},ltc_2:{value:null}},points:{diffuse:{value:new zt(16777215)},opacity:{value:1},size:{value:1},scale:{value:1},map:{value:null},alphaMap:{value:null},alphaMapTransform:{value:new Gt},alphaTest:{value:0},uvTransform:{value:new Gt}},sprite:{diffuse:{value:new zt(16777215)},opacity:{value:1},center:{value:new Lt(.5,.5)},rotation:{value:0},map:{value:null},mapTransform:{value:new Gt},alphaMap:{value:null},alphaMapTransform:{value:new Gt},alphaTest:{value:0}}},We={basic:{uniforms:Me([dt.common,dt.specularmap,dt.envmap,dt.aomap,dt.lightmap,dt.fog]),vertexShader:kt.meshbasic_vert,fragmentShader:kt.meshbasic_frag},lambert:{uniforms:Me([dt.common,dt.specularmap,dt.envmap,dt.aomap,dt.lightmap,dt.emissivemap,dt.bumpmap,dt.normalmap,dt.displacementmap,dt.fog,dt.lights,{emissive:{value:new zt(0)}}]),vertexShader:kt.meshlambert_vert,fragmentShader:kt.meshlambert_frag},phong:{uniforms:Me([dt.common,dt.specularmap,dt.envmap,dt.aomap,dt.lightmap,dt.emissivemap,dt.bumpmap,dt.normalmap,dt.displacementmap,dt.fog,dt.lights,{emissive:{value:new zt(0)},specular:{value:new zt(1118481)},shininess:{value:30}}]),vertexShader:kt.meshphong_vert,fragmentShader:kt.meshphong_frag},standard:{uniforms:Me([dt.common,dt.envmap,dt.aomap,dt.lightmap,dt.emissivemap,dt.bumpmap,dt.normalmap,dt.displacementmap,dt.roughnessmap,dt.metalnessmap,dt.fog,dt.lights,{emissive:{value:new zt(0)},roughness:{value:1},metalness:{value:0},envMapIntensity:{value:1}}]),vertexShader:kt.meshphysical_vert,fragmentShader:kt.meshphysical_frag},toon:{uniforms:Me([dt.common,dt.aomap,dt.lightmap,dt.emissivemap,dt.bumpmap,dt.normalmap,dt.displacementmap,dt.gradientmap,dt.fog,dt.lights,{emissive:{value:new zt(0)}}]),vertexShader:kt.meshtoon_vert,fragmentShader:kt.meshtoon_frag},matcap:{uniforms:Me([dt.common,dt.bumpmap,dt.normalmap,dt.displacementmap,dt.fog,{matcap:{value:null}}]),vertexShader:kt.meshmatcap_vert,fragmentShader:kt.meshmatcap_frag},points:{uniforms:Me([dt.points,dt.fog]),vertexShader:kt.points_vert,fragmentShader:kt.points_frag},dashed:{uniforms:Me([dt.common,dt.fog,{scale:{value:1},dashSize:{value:1},totalSize:{value:2}}]),vertexShader:kt.linedashed_vert,fragmentShader:kt.linedashed_frag},depth:{uniforms:Me([dt.common,dt.displacementmap]),vertexShader:kt.depth_vert,fragmentShader:kt.depth_frag},normal:{uniforms:Me([dt.common,dt.bumpmap,dt.normalmap,dt.displacementmap,{opacity:{value:1}}]),vertexShader:kt.meshnormal_vert,fragmentShader:kt.meshnormal_frag},sprite:{uniforms:Me([dt.sprite,dt.fog]),vertexShader:kt.sprite_vert,fragmentShader:kt.sprite_frag},background:{uniforms:{uvTransform:{value:new Gt},t2D:{value:null},backgroundIntensity:{value:1}},vertexShader:kt.background_vert,fragmentShader:kt.background_frag},backgroundCube:{uniforms:{envMap:{value:null},flipEnvMap:{value:-1},backgroundBlurriness:{value:0},backgroundIntensity:{value:1}},vertexShader:kt.backgroundCube_vert,fragmentShader:kt.backgroundCube_frag},cube:{uniforms:{tCube:{value:null},tFlip:{value:-1},opacity:{value:1}},vertexShader:kt.cube_vert,fragmentShader:kt.cube_frag},equirect:{uniforms:{tEquirect:{value:null}},vertexShader:kt.equirect_vert,fragmentShader:kt.equirect_frag},distanceRGBA:{uniforms:Me([dt.common,dt.displacementmap,{referencePosition:{value:new L},nearDistance:{value:1},farDistance:{value:1e3}}]),vertexShader:kt.distanceRGBA_vert,fragmentShader:kt.distanceRGBA_frag},shadow:{uniforms:Me([dt.lights,dt.fog,{color:{value:new zt(0)},opacity:{value:1}}]),vertexShader:kt.shadow_vert,fragmentShader:kt.shadow_frag}};We.physical={uniforms:Me([We.standard.uniforms,{clearcoat:{value:0},clearcoatMap:{value:null},clearcoatMapTransform:{value:new Gt},clearcoatNormalMap:{value:null},clearcoatNormalMapTransform:{value:new Gt},clearcoatNormalScale:{value:new Lt(1,1)},clearcoatRoughness:{value:0},clearcoatRoughnessMap:{value:null},clearcoatRoughnessMapTransform:{value:new Gt},iridescence:{value:0},iridescenceMap:{value:null},iridescenceMapTransform:{value:new Gt},iridescenceIOR:{value:1.3},iridescenceThicknessMinimum:{value:100},iridescenceThicknessMaximum:{value:400},iridescenceThicknessMap:{value:null},iridescenceThicknessMapTransform:{value:new Gt},sheen:{value:0},sheenColor:{value:new zt(0)},sheenColorMap:{value:null},sheenColorMapTransform:{value:new Gt},sheenRoughness:{value:1},sheenRoughnessMap:{value:null},sheenRoughnessMapTransform:{value:new Gt},transmission:{value:0},transmissionMap:{value:null},transmissionMapTransform:{value:new Gt},transmissionSamplerSize:{value:new Lt},transmissionSamplerMap:{value:null},thickness:{value:0},thicknessMap:{value:null},thicknessMapTransform:{value:new Gt},attenuationDistance:{value:0},attenuationColor:{value:new zt(0)},specularColor:{value:new zt(1,1,1)},specularColorMap:{value:null},specularColorMapTransform:{value:new Gt},specularIntensity:{value:1},specularIntensityMap:{value:null},specularIntensityMapTransform:{value:new Gt},anisotropyVector:{value:new Lt},anisotropyMap:{value:null},anisotropyMapTransform:{value:new Gt}}]),vertexShader:kt.meshphysical_vert,fragmentShader:kt.meshphysical_frag};var ws={r:0,b:0,g:0};function Tf(s,t,e,n,i,r,o){let a=new zt(0),c=r===!0?0:1,l,h,u=null,d=0,m=null;function v(p,f){let g=!1,_=f.isScene===!0?f.background:null;_&&_.isTexture&&(_=(f.backgroundBlurriness>0?e:t).get(_)),_===null?x(a,c):_&&_.isColor&&(x(_,1),g=!0);let b=s.xr.getEnvironmentBlendMode();b==="additive"?n.buffers.color.setClear(0,0,0,1,o):b==="alpha-blend"&&n.buffers.color.setClear(0,0,0,0,o),(s.autoClear||g)&&s.clear(s.autoClearColor,s.autoClearDepth,s.autoClearStencil),_&&(_.isCubeTexture||_.mapping===nr)?(h===void 0&&(h=new Ue(new Wi(1,1,1),new Fe({name:"BackgroundCubeMaterial",uniforms:yi(We.backgroundCube.uniforms),vertexShader:We.backgroundCube.vertexShader,fragmentShader:We.backgroundCube.fragmentShader,side:Ee,depthTest:!1,depthWrite:!1,fog:!1})),h.geometry.deleteAttribute("normal"),h.geometry.deleteAttribute("uv"),h.onBeforeRender=function(S,T,C){this.matrixWorld.copyPosition(C.matrixWorld)},Object.defineProperty(h.material,"envMap",{get:function(){return this.uniforms.envMap.value}}),i.update(h)),h.material.uniforms.envMap.value=_,h.material.uniforms.flipEnvMap.value=_.isCubeTexture&&_.isRenderTargetTexture===!1?-1:1,h.material.uniforms.backgroundBlurriness.value=f.backgroundBlurriness,h.material.uniforms.backgroundIntensity.value=f.backgroundIntensity,h.material.toneMapped=qt.getTransfer(_.colorSpace)!==Qt,(u!==_||d!==_.version||m!==s.toneMapping)&&(h.material.needsUpdate=!0,u=_,d=_.version,m=s.toneMapping),h.layers.enableAll(),p.unshift(h,h.geometry,h.material,0,0,null)):_&&_.isTexture&&(l===void 0&&(l=new Ue(new fo(2,2),new Fe({name:"BackgroundMaterial",uniforms:yi(We.background.uniforms),vertexShader:We.background.vertexShader,fragmentShader:We.background.fragmentShader,side:yn,depthTest:!1,depthWrite:!1,fog:!1})),l.geometry.deleteAttribute("normal"),Object.defineProperty(l.material,"map",{get:function(){return this.uniforms.t2D.value}}),i.update(l)),l.material.uniforms.t2D.value=_,l.material.uniforms.backgroundIntensity.value=f.backgroundIntensity,l.material.toneMapped=qt.getTransfer(_.colorSpace)!==Qt,_.matrixAutoUpdate===!0&&_.updateMatrix(),l.material.uniforms.uvTransform.value.copy(_.matrix),(u!==_||d!==_.version||m!==s.toneMapping)&&(l.material.needsUpdate=!0,u=_,d=_.version,m=s.toneMapping),l.layers.enableAll(),p.unshift(l,l.geometry,l.material,0,0,null))}function x(p,f){p.getRGB(ws,Kc(s)),n.buffers.color.setClear(ws.r,ws.g,ws.b,f,o)}return{getClearColor:function(){return a},setClearColor:function(p,f=1){a.set(p),c=f,x(a,c)},getClearAlpha:function(){return c},setClearAlpha:function(p){c=p,x(a,c)},render:v}}function Cf(s,t,e,n){let i=s.getParameter(s.MAX_VERTEX_ATTRIBS),r=n.isWebGL2?null:t.get("OES_vertex_array_object"),o=n.isWebGL2||r!==null,a={},c=p(null),l=c,h=!1;function u(R,D,H,k,N){let V=!1;if(o){let K=x(k,H,D);l!==K&&(l=K,m(l.object)),V=f(R,k,H,N),V&&g(R,k,H,N)}else{let K=D.wireframe===!0;(l.geometry!==k.id||l.program!==H.id||l.wireframe!==K)&&(l.geometry=k.id,l.program=H.id,l.wireframe=K,V=!0)}N!==null&&e.update(N,s.ELEMENT_ARRAY_BUFFER),(V||h)&&(h=!1,P(R,D,H,k),N!==null&&s.bindBuffer(s.ELEMENT_ARRAY_BUFFER,e.get(N).buffer))}function d(){return n.isWebGL2?s.createVertexArray():r.createVertexArrayOES()}function m(R){return n.isWebGL2?s.bindVertexArray(R):r.bindVertexArrayOES(R)}function v(R){return n.isWebGL2?s.deleteVertexArray(R):r.deleteVertexArrayOES(R)}function x(R,D,H){let k=H.wireframe===!0,N=a[R.id];N===void 0&&(N={},a[R.id]=N);let V=N[D.id];V===void 0&&(V={},N[D.id]=V);let K=V[k];return K===void 0&&(K=p(d()),V[k]=K),K}function p(R){let D=[],H=[],k=[];for(let N=0;N<i;N++)D[N]=0,H[N]=0,k[N]=0;return{geometry:null,program:null,wireframe:!1,newAttributes:D,enabledAttributes:H,attributeDivisors:k,object:R,attributes:{},index:null}}function f(R,D,H,k){let N=l.attributes,V=D.attributes,K=0,$=H.getAttributes();for(let ct in $)if($[ct].location>=0){let J=N[ct],ot=V[ct];if(ot===void 0&&(ct==="instanceMatrix"&&R.instanceMatrix&&(ot=R.instanceMatrix),ct==="instanceColor"&&R.instanceColor&&(ot=R.instanceColor)),J===void 0||J.attribute!==ot||ot&&J.data!==ot.data)return!0;K++}return l.attributesNum!==K||l.index!==k}function g(R,D,H,k){let N={},V=D.attributes,K=0,$=H.getAttributes();for(let ct in $)if($[ct].location>=0){let J=V[ct];J===void 0&&(ct==="instanceMatrix"&&R.instanceMatrix&&(J=R.instanceMatrix),ct==="instanceColor"&&R.instanceColor&&(J=R.instanceColor));let ot={};ot.attribute=J,J&&J.data&&(ot.data=J.data),N[ct]=ot,K++}l.attributes=N,l.attributesNum=K,l.index=k}function _(){let R=l.newAttributes;for(let D=0,H=R.length;D<H;D++)R[D]=0}function b(R){S(R,0)}function S(R,D){let H=l.newAttributes,k=l.enabledAttributes,N=l.attributeDivisors;H[R]=1,k[R]===0&&(s.enableVertexAttribArray(R),k[R]=1),N[R]!==D&&((n.isWebGL2?s:t.get("ANGLE_instanced_arrays"))[n.isWebGL2?"vertexAttribDivisor":"vertexAttribDivisorANGLE"](R,D),N[R]=D)}function T(){let R=l.newAttributes,D=l.enabledAttributes;for(let H=0,k=D.length;H<k;H++)D[H]!==R[H]&&(s.disableVertexAttribArray(H),D[H]=0)}function C(R,D,H,k,N,V,K){K===!0?s.vertexAttribIPointer(R,D,H,N,V):s.vertexAttribPointer(R,D,H,k,N,V)}function P(R,D,H,k){if(n.isWebGL2===!1&&(R.isInstancedMesh||k.isInstancedBufferGeometry)&&t.get("ANGLE_instanced_arrays")===null)return;_();let N=k.attributes,V=H.getAttributes(),K=D.defaultAttributeValues;for(let $ in V){let ct=V[$];if(ct.location>=0){let G=N[$];if(G===void 0&&($==="instanceMatrix"&&R.instanceMatrix&&(G=R.instanceMatrix),$==="instanceColor"&&R.instanceColor&&(G=R.instanceColor)),G!==void 0){let J=G.normalized,ot=G.itemSize,nt=e.get(G);if(nt===void 0)continue;let ht=nt.buffer,xt=nt.type,Y=nt.bytesPerElement,lt=n.isWebGL2===!0&&(xt===s.INT||xt===s.UNSIGNED_INT||G.gpuType===zc);if(G.isInterleavedBufferAttribute){let pt=G.data,U=pt.stride,bt=G.offset;if(pt.isInstancedInterleavedBuffer){for(let et=0;et<ct.locationSize;et++)S(ct.location+et,pt.meshPerAttribute);R.isInstancedMesh!==!0&&k._maxInstanceCount===void 0&&(k._maxInstanceCount=pt.meshPerAttribute*pt.count)}else for(let et=0;et<ct.locationSize;et++)b(ct.location+et);s.bindBuffer(s.ARRAY_BUFFER,ht);for(let et=0;et<ct.locationSize;et++)C(ct.location+et,ot/ct.locationSize,xt,J,U*Y,(bt+ot/ct.locationSize*et)*Y,lt)}else{if(G.isInstancedBufferAttribute){for(let pt=0;pt<ct.locationSize;pt++)S(ct.location+pt,G.meshPerAttribute);R.isInstancedMesh!==!0&&k._maxInstanceCount===void 0&&(k._maxInstanceCount=G.meshPerAttribute*G.count)}else for(let pt=0;pt<ct.locationSize;pt++)b(ct.location+pt);s.bindBuffer(s.ARRAY_BUFFER,ht);for(let pt=0;pt<ct.locationSize;pt++)C(ct.location+pt,ot/ct.locationSize,xt,J,ot*Y,ot/ct.locationSize*pt*Y,lt)}}else if(K!==void 0){let J=K[$];if(J!==void 0)switch(J.length){case 2:s.vertexAttrib2fv(ct.location,J);break;case 3:s.vertexAttrib3fv(ct.location,J);break;case 4:s.vertexAttrib4fv(ct.location,J);break;default:s.vertexAttrib1fv(ct.location,J)}}}}T()}function y(){B();for(let R in a){let D=a[R];for(let H in D){let k=D[H];for(let N in k)v(k[N].object),delete k[N];delete D[H]}delete a[R]}}function w(R){if(a[R.id]===void 0)return;let D=a[R.id];for(let H in D){let k=D[H];for(let N in k)v(k[N].object),delete k[N];delete D[H]}delete a[R.id]}function F(R){for(let D in a){let H=a[D];if(H[R.id]===void 0)continue;let k=H[R.id];for(let N in k)v(k[N].object),delete k[N];delete H[R.id]}}function B(){W(),h=!0,l!==c&&(l=c,m(l.object))}function W(){c.geometry=null,c.program=null,c.wireframe=!1}return{setup:u,reset:B,resetDefaultState:W,dispose:y,releaseStatesOfGeometry:w,releaseStatesOfProgram:F,initAttributes:_,enableAttribute:b,disableUnusedAttributes:T}}function Rf(s,t,e,n){let i=n.isWebGL2,r;function o(h){r=h}function a(h,u){s.drawArrays(r,h,u),e.update(u,r,1)}function c(h,u,d){if(d===0)return;let m,v;if(i)m=s,v="drawArraysInstanced";else if(m=t.get("ANGLE_instanced_arrays"),v="drawArraysInstancedANGLE",m===null){console.error("THREE.WebGLBufferRenderer: using THREE.InstancedBufferGeometry but hardware does not support extension ANGLE_instanced_arrays.");return}m[v](r,h,u,d),e.update(u,r,d)}function l(h,u,d){if(d===0)return;let m=t.get("WEBGL_multi_draw");if(m===null)for(let v=0;v<d;v++)this.render(h[v],u[v]);else{m.multiDrawArraysWEBGL(r,h,0,u,0,d);let v=0;for(let x=0;x<d;x++)v+=u[x];e.update(v,r,1)}}this.setMode=o,this.render=a,this.renderInstances=c,this.renderMultiDraw=l}function Pf(s,t,e){let n;function i(){if(n!==void 0)return n;if(t.has("EXT_texture_filter_anisotropic")===!0){let C=t.get("EXT_texture_filter_anisotropic");n=s.getParameter(C.MAX_TEXTURE_MAX_ANISOTROPY_EXT)}else n=0;return n}function r(C){if(C==="highp"){if(s.getShaderPrecisionFormat(s.VERTEX_SHADER,s.HIGH_FLOAT).precision>0&&s.getShaderPrecisionFormat(s.FRAGMENT_SHADER,s.HIGH_FLOAT).precision>0)return"highp";C="mediump"}return C==="mediump"&&s.getShaderPrecisionFormat(s.VERTEX_SHADER,s.MEDIUM_FLOAT).precision>0&&s.getShaderPrecisionFormat(s.FRAGMENT_SHADER,s.MEDIUM_FLOAT).precision>0?"mediump":"lowp"}let o=typeof WebGL2RenderingContext<"u"&&s.constructor.name==="WebGL2RenderingContext",a=e.precision!==void 0?e.precision:"highp",c=r(a);c!==a&&(console.warn("THREE.WebGLRenderer:",a,"not supported, using",c,"instead."),a=c);let l=o||t.has("WEBGL_draw_buffers"),h=e.logarithmicDepthBuffer===!0,u=s.getParameter(s.MAX_TEXTURE_IMAGE_UNITS),d=s.getParameter(s.MAX_VERTEX_TEXTURE_IMAGE_UNITS),m=s.getParameter(s.MAX_TEXTURE_SIZE),v=s.getParameter(s.MAX_CUBE_MAP_TEXTURE_SIZE),x=s.getParameter(s.MAX_VERTEX_ATTRIBS),p=s.getParameter(s.MAX_VERTEX_UNIFORM_VECTORS),f=s.getParameter(s.MAX_VARYING_VECTORS),g=s.getParameter(s.MAX_FRAGMENT_UNIFORM_VECTORS),_=d>0,b=o||t.has("OES_texture_float"),S=_&&b,T=o?s.getParameter(s.MAX_SAMPLES):0;return{isWebGL2:o,drawBuffers:l,getMaxAnisotropy:i,getMaxPrecision:r,precision:a,logarithmicDepthBuffer:h,maxTextures:u,maxVertexTextures:d,maxTextureSize:m,maxCubemapSize:v,maxAttributes:x,maxVertexUniforms:p,maxVaryings:f,maxFragmentUniforms:g,vertexTextures:_,floatFragmentTextures:b,floatVertexTextures:S,maxSamples:T}}function Lf(s){let t=this,e=null,n=0,i=!1,r=!1,o=new je,a=new Gt,c={value:null,needsUpdate:!1};this.uniform=c,this.numPlanes=0,this.numIntersection=0,this.init=function(u,d){let m=u.length!==0||d||n!==0||i;return i=d,n=u.length,m},this.beginShadows=function(){r=!0,h(null)},this.endShadows=function(){r=!1},this.setGlobalState=function(u,d){e=h(u,d,0)},this.setState=function(u,d,m){let v=u.clippingPlanes,x=u.clipIntersection,p=u.clipShadows,f=s.get(u);if(!i||v===null||v.length===0||r&&!p)r?h(null):l();else{let g=r?0:n,_=g*4,b=f.clippingState||null;c.value=b,b=h(v,d,_,m);for(let S=0;S!==_;++S)b[S]=e[S];f.clippingState=b,this.numIntersection=x?this.numPlanes:0,this.numPlanes+=g}};function l(){c.value!==e&&(c.value=e,c.needsUpdate=n>0),t.numPlanes=n,t.numIntersection=0}function h(u,d,m,v){let x=u!==null?u.length:0,p=null;if(x!==0){if(p=c.value,v!==!0||p===null){let f=m+x*4,g=d.matrixWorldInverse;a.getNormalMatrix(g),(p===null||p.length<f)&&(p=new Float32Array(f));for(let _=0,b=m;_!==x;++_,b+=4)o.copy(u[_]).applyMatrix4(g,a),o.normal.toArray(p,b),p[b+3]=o.constant}c.value=p,c.needsUpdate=!0}return t.numPlanes=x,t.numIntersection=0,p}}function If(s){let t=new WeakMap;function e(o,a){return a===to?o.mapping=mi:a===eo&&(o.mapping=gi),o}function n(o){if(o&&o.isTexture){let a=o.mapping;if(a===to||a===eo)if(t.has(o)){let c=t.get(o).texture;return e(c,o.mapping)}else{let c=o.image;if(c&&c.height>0){let l=new uo(c.height/2);return l.fromEquirectangularTexture(s,o),t.set(o,l),o.addEventListener("dispose",i),e(l.texture,o.mapping)}else return null}}return o}function i(o){let a=o.target;a.removeEventListener("dispose",i);let c=t.get(a);c!==void 0&&(t.delete(a),c.dispose())}function r(){t=new WeakMap}return{get:n,dispose:r}}var zn=class extends Zs{constructor(t=-1,e=1,n=1,i=-1,r=.1,o=2e3){super(),this.isOrthographicCamera=!0,this.type="OrthographicCamera",this.zoom=1,this.view=null,this.left=t,this.right=e,this.top=n,this.bottom=i,this.near=r,this.far=o,this.updateProjectionMatrix()}copy(t,e){return super.copy(t,e),this.left=t.left,this.right=t.right,this.top=t.top,this.bottom=t.bottom,this.near=t.near,this.far=t.far,this.zoom=t.zoom,this.view=t.view===null?null:Object.assign({},t.view),this}setViewOffset(t,e,n,i,r,o){this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=t,this.view.fullHeight=e,this.view.offsetX=n,this.view.offsetY=i,this.view.width=r,this.view.height=o,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){let t=(this.right-this.left)/(2*this.zoom),e=(this.top-this.bottom)/(2*this.zoom),n=(this.right+this.left)/2,i=(this.top+this.bottom)/2,r=n-t,o=n+t,a=i+e,c=i-e;if(this.view!==null&&this.view.enabled){let l=(this.right-this.left)/this.view.fullWidth/this.zoom,h=(this.top-this.bottom)/this.view.fullHeight/this.zoom;r+=l*this.view.offsetX,o=r+l*this.view.width,a-=h*this.view.offsetY,c=a-h*this.view.height}this.projectionMatrix.makeOrthographic(r,o,a,c,this.near,this.far,this.coordinateSystem),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(t){let e=super.toJSON(t);return e.object.zoom=this.zoom,e.object.left=this.left,e.object.right=this.right,e.object.top=this.top,e.object.bottom=this.bottom,e.object.near=this.near,e.object.far=this.far,this.view!==null&&(e.object.view=Object.assign({},this.view)),e}},li=4,ic=[.125,.215,.35,.446,.526,.582],Dn=20,Xr=new zn,sc=new zt,qr=null,Yr=0,Zr=0,Ln=(1+Math.sqrt(5))/2,ii=1/Ln,rc=[new L(1,1,1),new L(-1,1,1),new L(1,1,-1),new L(-1,1,-1),new L(0,Ln,ii),new L(0,Ln,-ii),new L(ii,0,Ln),new L(-ii,0,Ln),new L(Ln,ii,0),new L(-Ln,ii,0)],Ks=class{constructor(t){this._renderer=t,this._pingPongRenderTarget=null,this._lodMax=0,this._cubeSize=0,this._lodPlanes=[],this._sizeLods=[],this._sigmas=[],this._blurMaterial=null,this._cubemapMaterial=null,this._equirectMaterial=null,this._compileMaterial(this._blurMaterial)}fromScene(t,e=0,n=.1,i=100){qr=this._renderer.getRenderTarget(),Yr=this._renderer.getActiveCubeFace(),Zr=this._renderer.getActiveMipmapLevel(),this._setSize(256);let r=this._allocateTargets();return r.depthBuffer=!0,this._sceneToCubeUV(t,n,i,r),e>0&&this._blur(r,0,0,e),this._applyPMREM(r),this._cleanup(r),r}fromEquirectangular(t,e=null){return this._fromTexture(t,e)}fromCubemap(t,e=null){return this._fromTexture(t,e)}compileCubemapShader(){this._cubemapMaterial===null&&(this._cubemapMaterial=cc(),this._compileMaterial(this._cubemapMaterial))}compileEquirectangularShader(){this._equirectMaterial===null&&(this._equirectMaterial=ac(),this._compileMaterial(this._equirectMaterial))}dispose(){this._dispose(),this._cubemapMaterial!==null&&this._cubemapMaterial.dispose(),this._equirectMaterial!==null&&this._equirectMaterial.dispose()}_setSize(t){this._lodMax=Math.floor(Math.log2(t)),this._cubeSize=Math.pow(2,this._lodMax)}_dispose(){this._blurMaterial!==null&&this._blurMaterial.dispose(),this._pingPongRenderTarget!==null&&this._pingPongRenderTarget.dispose();for(let t=0;t<this._lodPlanes.length;t++)this._lodPlanes[t].dispose()}_cleanup(t){this._renderer.setRenderTarget(qr,Yr,Zr),t.scissorTest=!1,Es(t,0,0,t.width,t.height)}_fromTexture(t,e){t.mapping===mi||t.mapping===gi?this._setSize(t.image.length===0?16:t.image[0].width||t.image[0].image.width):this._setSize(t.image.width/4),qr=this._renderer.getRenderTarget(),Yr=this._renderer.getActiveCubeFace(),Zr=this._renderer.getActiveMipmapLevel();let n=e||this._allocateTargets();return this._textureToCubeUV(t,n),this._applyPMREM(n),this._cleanup(n),n}_allocateTargets(){let t=3*Math.max(this._cubeSize,112),e=4*this._cubeSize,n={magFilter:Ie,minFilter:Ie,generateMipmaps:!1,type:Hi,format:Ve,colorSpace:nn,depthBuffer:!1},i=oc(t,e,n);if(this._pingPongRenderTarget===null||this._pingPongRenderTarget.width!==t||this._pingPongRenderTarget.height!==e){this._pingPongRenderTarget!==null&&this._dispose(),this._pingPongRenderTarget=oc(t,e,n);let{_lodMax:r}=this;({sizeLods:this._sizeLods,lodPlanes:this._lodPlanes,sigmas:this._sigmas}=Df(r)),this._blurMaterial=Uf(r,t,e)}return i}_compileMaterial(t){let e=new Ue(this._lodPlanes[0],t);this._renderer.compile(e,Xr)}_sceneToCubeUV(t,e,n,i){let a=new Se(90,1,e,n),c=[1,-1,1,1,1,1],l=[1,1,1,-1,-1,-1],h=this._renderer,u=h.autoClear,d=h.toneMapping;h.getClearColor(sc),h.toneMapping=_n,h.autoClear=!1;let m=new xi({name:"PMREM.Background",side:Ee,depthWrite:!1,depthTest:!1}),v=new Ue(new Wi,m),x=!1,p=t.background;p?p.isColor&&(m.color.copy(p),t.background=null,x=!0):(m.color.copy(sc),x=!0);for(let f=0;f<6;f++){let g=f%3;g===0?(a.up.set(0,c[f],0),a.lookAt(l[f],0,0)):g===1?(a.up.set(0,0,c[f]),a.lookAt(0,l[f],0)):(a.up.set(0,c[f],0),a.lookAt(0,0,l[f]));let _=this._cubeSize;Es(i,g*_,f>2?_:0,_,_),h.setRenderTarget(i),x&&h.render(v,a),h.render(t,a)}v.geometry.dispose(),v.material.dispose(),h.toneMapping=d,h.autoClear=u,t.background=p}_textureToCubeUV(t,e){let n=this._renderer,i=t.mapping===mi||t.mapping===gi;i?(this._cubemapMaterial===null&&(this._cubemapMaterial=cc()),this._cubemapMaterial.uniforms.flipEnvMap.value=t.isRenderTargetTexture===!1?-1:1):this._equirectMaterial===null&&(this._equirectMaterial=ac());let r=i?this._cubemapMaterial:this._equirectMaterial,o=new Ue(this._lodPlanes[0],r),a=r.uniforms;a.envMap.value=t;let c=this._cubeSize;Es(e,0,0,3*c,2*c),n.setRenderTarget(e),n.render(o,Xr)}_applyPMREM(t){let e=this._renderer,n=e.autoClear;e.autoClear=!1;for(let i=1;i<this._lodPlanes.length;i++){let r=Math.sqrt(this._sigmas[i]*this._sigmas[i]-this._sigmas[i-1]*this._sigmas[i-1]),o=rc[(i-1)%rc.length];this._blur(t,i-1,i,r,o)}e.autoClear=n}_blur(t,e,n,i,r){let o=this._pingPongRenderTarget;this._halfBlur(t,o,e,n,i,"latitudinal",r),this._halfBlur(o,t,n,n,i,"longitudinal",r)}_halfBlur(t,e,n,i,r,o,a){let c=this._renderer,l=this._blurMaterial;o!=="latitudinal"&&o!=="longitudinal"&&console.error("blur direction must be either latitudinal or longitudinal!");let h=3,u=new Ue(this._lodPlanes[i],l),d=l.uniforms,m=this._sizeLods[n]-1,v=isFinite(r)?Math.PI/(2*m):2*Math.PI/(2*Dn-1),x=r/v,p=isFinite(r)?1+Math.floor(h*x):Dn;p>Dn&&console.warn(`sigmaRadians, ${r}, is too large and will clip, as it requested ${p} samples when the maximum is set to ${Dn}`);let f=[],g=0;for(let C=0;C<Dn;++C){let P=C/x,y=Math.exp(-P*P/2);f.push(y),C===0?g+=y:C<p&&(g+=2*y)}for(let C=0;C<f.length;C++)f[C]=f[C]/g;d.envMap.value=t.texture,d.samples.value=p,d.weights.value=f,d.latitudinal.value=o==="latitudinal",a&&(d.poleAxis.value=a);let{_lodMax:_}=this;d.dTheta.value=v,d.mipInt.value=_-n;let b=this._sizeLods[i],S=3*b*(i>_-li?i-_+li:0),T=4*(this._cubeSize-b);Es(e,S,T,3*b,2*b),c.setRenderTarget(e),c.render(u,Xr)}};function Df(s){let t=[],e=[],n=[],i=s,r=s-li+1+ic.length;for(let o=0;o<r;o++){let a=Math.pow(2,i);e.push(a);let c=1/a;o>s-li?c=ic[o-s+li-1]:o===0&&(c=0),n.push(c);let l=1/(a-2),h=-l,u=1+l,d=[h,h,u,h,u,u,h,h,u,u,h,u],m=6,v=6,x=3,p=2,f=1,g=new Float32Array(x*v*m),_=new Float32Array(p*v*m),b=new Float32Array(f*v*m);for(let T=0;T<m;T++){let C=T%3*2/3-1,P=T>2?0:-1,y=[C,P,0,C+2/3,P,0,C+2/3,P+1,0,C,P,0,C+2/3,P+1,0,C,P+1,0];g.set(y,x*v*T),_.set(d,p*v*T);let w=[T,T,T,T,T,T];b.set(w,f*v*T)}let S=new pe;S.setAttribute("position",new ee(g,x)),S.setAttribute("uv",new ee(_,p)),S.setAttribute("faceIndex",new ee(b,f)),t.push(S),i>li&&i--}return{lodPlanes:t,sizeLods:e,sigmas:n}}function oc(s,t,e){let n=new sn(s,t,e);return n.texture.mapping=nr,n.texture.name="PMREM.cubeUv",n.scissorTest=!0,n}function Es(s,t,e,n,i){s.viewport.set(t,e,n,i),s.scissor.set(t,e,n,i)}function Uf(s,t,e){let n=new Float32Array(Dn),i=new L(0,1,0);return new Fe({name:"SphericalGaussianBlur",defines:{n:Dn,CUBEUV_TEXEL_WIDTH:1/t,CUBEUV_TEXEL_HEIGHT:1/e,CUBEUV_MAX_MIP:`${s}.0`},uniforms:{envMap:{value:null},samples:{value:1},weights:{value:n},latitudinal:{value:!1},dTheta:{value:0},mipInt:{value:0},poleAxis:{value:i}},vertexShader:Go(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;
			uniform int samples;
			uniform float weights[ n ];
			uniform bool latitudinal;
			uniform float dTheta;
			uniform float mipInt;
			uniform vec3 poleAxis;

			#define ENVMAP_TYPE_CUBE_UV
			#include <cube_uv_reflection_fragment>

			vec3 getSample( float theta, vec3 axis ) {

				float cosTheta = cos( theta );
				// Rodrigues' axis-angle rotation
				vec3 sampleDirection = vOutputDirection * cosTheta
					+ cross( axis, vOutputDirection ) * sin( theta )
					+ axis * dot( axis, vOutputDirection ) * ( 1.0 - cosTheta );

				return bilinearCubeUV( envMap, sampleDirection, mipInt );

			}

			void main() {

				vec3 axis = latitudinal ? poleAxis : cross( poleAxis, vOutputDirection );

				if ( all( equal( axis, vec3( 0.0 ) ) ) ) {

					axis = vec3( vOutputDirection.z, 0.0, - vOutputDirection.x );

				}

				axis = normalize( axis );

				gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
				gl_FragColor.rgb += weights[ 0 ] * getSample( 0.0, axis );

				for ( int i = 1; i < n; i++ ) {

					if ( i >= samples ) {

						break;

					}

					float theta = dTheta * float( i );
					gl_FragColor.rgb += weights[ i ] * getSample( -1.0 * theta, axis );
					gl_FragColor.rgb += weights[ i ] * getSample( theta, axis );

				}

			}
		`,blending:gn,depthTest:!1,depthWrite:!1})}function ac(){return new Fe({name:"EquirectangularToCubeUV",uniforms:{envMap:{value:null}},vertexShader:Go(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;

			#include <common>

			void main() {

				vec3 outputDirection = normalize( vOutputDirection );
				vec2 uv = equirectUv( outputDirection );

				gl_FragColor = vec4( texture2D ( envMap, uv ).rgb, 1.0 );

			}
		`,blending:gn,depthTest:!1,depthWrite:!1})}function cc(){return new Fe({name:"CubemapToCubeUV",uniforms:{envMap:{value:null},flipEnvMap:{value:-1}},vertexShader:Go(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			uniform float flipEnvMap;

			varying vec3 vOutputDirection;

			uniform samplerCube envMap;

			void main() {

				gl_FragColor = textureCube( envMap, vec3( flipEnvMap * vOutputDirection.x, vOutputDirection.yz ) );

			}
		`,blending:gn,depthTest:!1,depthWrite:!1})}function Go(){return`

		precision mediump float;
		precision mediump int;

		attribute float faceIndex;

		varying vec3 vOutputDirection;

		// RH coordinate system; PMREM face-indexing convention
		vec3 getDirection( vec2 uv, float face ) {

			uv = 2.0 * uv - 1.0;

			vec3 direction = vec3( uv, 1.0 );

			if ( face == 0.0 ) {

				direction = direction.zyx; // ( 1, v, u ) pos x

			} else if ( face == 1.0 ) {

				direction = direction.xzy;
				direction.xz *= -1.0; // ( -u, 1, -v ) pos y

			} else if ( face == 2.0 ) {

				direction.x *= -1.0; // ( -u, v, 1 ) pos z

			} else if ( face == 3.0 ) {

				direction = direction.zyx;
				direction.xz *= -1.0; // ( -1, v, -u ) neg x

			} else if ( face == 4.0 ) {

				direction = direction.xzy;
				direction.xy *= -1.0; // ( -u, -1, v ) neg y

			} else if ( face == 5.0 ) {

				direction.z *= -1.0; // ( u, v, -1 ) neg z

			}

			return direction;

		}

		void main() {

			vOutputDirection = getDirection( uv, faceIndex );
			gl_Position = vec4( position, 1.0 );

		}
	`}function Nf(s){let t=new WeakMap,e=null;function n(a){if(a&&a.isTexture){let c=a.mapping,l=c===to||c===eo,h=c===mi||c===gi;if(l||h)if(a.isRenderTargetTexture&&a.needsPMREMUpdate===!0){a.needsPMREMUpdate=!1;let u=t.get(a);return e===null&&(e=new Ks(s)),u=l?e.fromEquirectangular(a,u):e.fromCubemap(a,u),t.set(a,u),u.texture}else{if(t.has(a))return t.get(a).texture;{let u=a.image;if(l&&u&&u.height>0||h&&u&&i(u)){e===null&&(e=new Ks(s));let d=l?e.fromEquirectangular(a):e.fromCubemap(a);return t.set(a,d),a.addEventListener("dispose",r),d.texture}else return null}}}return a}function i(a){let c=0,l=6;for(let h=0;h<l;h++)a[h]!==void 0&&c++;return c===l}function r(a){let c=a.target;c.removeEventListener("dispose",r);let l=t.get(c);l!==void 0&&(t.delete(c),l.dispose())}function o(){t=new WeakMap,e!==null&&(e.dispose(),e=null)}return{get:n,dispose:o}}function Ff(s){let t={};function e(n){if(t[n]!==void 0)return t[n];let i;switch(n){case"WEBGL_depth_texture":i=s.getExtension("WEBGL_depth_texture")||s.getExtension("MOZ_WEBGL_depth_texture")||s.getExtension("WEBKIT_WEBGL_depth_texture");break;case"EXT_texture_filter_anisotropic":i=s.getExtension("EXT_texture_filter_anisotropic")||s.getExtension("MOZ_EXT_texture_filter_anisotropic")||s.getExtension("WEBKIT_EXT_texture_filter_anisotropic");break;case"WEBGL_compressed_texture_s3tc":i=s.getExtension("WEBGL_compressed_texture_s3tc")||s.getExtension("MOZ_WEBGL_compressed_texture_s3tc")||s.getExtension("WEBKIT_WEBGL_compressed_texture_s3tc");break;case"WEBGL_compressed_texture_pvrtc":i=s.getExtension("WEBGL_compressed_texture_pvrtc")||s.getExtension("WEBKIT_WEBGL_compressed_texture_pvrtc");break;default:i=s.getExtension(n)}return t[n]=i,i}return{has:function(n){return e(n)!==null},init:function(n){n.isWebGL2?(e("EXT_color_buffer_float"),e("WEBGL_clip_cull_distance")):(e("WEBGL_depth_texture"),e("OES_texture_float"),e("OES_texture_half_float"),e("OES_texture_half_float_linear"),e("OES_standard_derivatives"),e("OES_element_index_uint"),e("OES_vertex_array_object"),e("ANGLE_instanced_arrays")),e("OES_texture_float_linear"),e("EXT_color_buffer_half_float"),e("WEBGL_multisampled_render_to_texture")},get:function(n){let i=e(n);return i===null&&console.warn("THREE.WebGLRenderer: "+n+" extension not supported."),i}}}function Of(s,t,e,n){let i={},r=new WeakMap;function o(u){let d=u.target;d.index!==null&&t.remove(d.index);for(let v in d.attributes)t.remove(d.attributes[v]);for(let v in d.morphAttributes){let x=d.morphAttributes[v];for(let p=0,f=x.length;p<f;p++)t.remove(x[p])}d.removeEventListener("dispose",o),delete i[d.id];let m=r.get(d);m&&(t.remove(m),r.delete(d)),n.releaseStatesOfGeometry(d),d.isInstancedBufferGeometry===!0&&delete d._maxInstanceCount,e.memory.geometries--}function a(u,d){return i[d.id]===!0||(d.addEventListener("dispose",o),i[d.id]=!0,e.memory.geometries++),d}function c(u){let d=u.attributes;for(let v in d)t.update(d[v],s.ARRAY_BUFFER);let m=u.morphAttributes;for(let v in m){let x=m[v];for(let p=0,f=x.length;p<f;p++)t.update(x[p],s.ARRAY_BUFFER)}}function l(u){let d=[],m=u.index,v=u.attributes.position,x=0;if(m!==null){let g=m.array;x=m.version;for(let _=0,b=g.length;_<b;_+=3){let S=g[_+0],T=g[_+1],C=g[_+2];d.push(S,T,T,C,C,S)}}else if(v!==void 0){let g=v.array;x=v.version;for(let _=0,b=g.length/3-1;_<b;_+=3){let S=_+0,T=_+1,C=_+2;d.push(S,T,T,C,C,S)}}else return;let p=new(Zc(d)?Ys:qs)(d,1);p.version=x;let f=r.get(u);f&&t.remove(f),r.set(u,p)}function h(u){let d=r.get(u);if(d){let m=u.index;m!==null&&d.version<m.version&&l(u)}else l(u);return r.get(u)}return{get:a,update:c,getWireframeAttribute:h}}function Bf(s,t,e,n){let i=n.isWebGL2,r;function o(m){r=m}let a,c;function l(m){a=m.type,c=m.bytesPerElement}function h(m,v){s.drawElements(r,v,a,m*c),e.update(v,r,1)}function u(m,v,x){if(x===0)return;let p,f;if(i)p=s,f="drawElementsInstanced";else if(p=t.get("ANGLE_instanced_arrays"),f="drawElementsInstancedANGLE",p===null){console.error("THREE.WebGLIndexedBufferRenderer: using THREE.InstancedBufferGeometry but hardware does not support extension ANGLE_instanced_arrays.");return}p[f](r,v,a,m*c,x),e.update(v,r,x)}function d(m,v,x){if(x===0)return;let p=t.get("WEBGL_multi_draw");if(p===null)for(let f=0;f<x;f++)this.render(m[f]/c,v[f]);else{p.multiDrawElementsWEBGL(r,v,0,a,m,0,x);let f=0;for(let g=0;g<x;g++)f+=v[g];e.update(f,r,1)}}this.setMode=o,this.setIndex=l,this.render=h,this.renderInstances=u,this.renderMultiDraw=d}function zf(s){let t={geometries:0,textures:0},e={frame:0,calls:0,triangles:0,points:0,lines:0};function n(r,o,a){switch(e.calls++,o){case s.TRIANGLES:e.triangles+=a*(r/3);break;case s.LINES:e.lines+=a*(r/2);break;case s.LINE_STRIP:e.lines+=a*(r-1);break;case s.LINE_LOOP:e.lines+=a*r;break;case s.POINTS:e.points+=a*r;break;default:console.error("THREE.WebGLInfo: Unknown draw mode:",o);break}}function i(){e.calls=0,e.triangles=0,e.points=0,e.lines=0}return{memory:t,render:e,programs:null,autoReset:!0,reset:i,update:n}}function kf(s,t){return s[0]-t[0]}function Vf(s,t){return Math.abs(t[1])-Math.abs(s[1])}function Hf(s,t,e){let n={},i=new Float32Array(8),r=new WeakMap,o=new de,a=[];for(let l=0;l<8;l++)a[l]=[l,0];function c(l,h,u){let d=l.morphTargetInfluences;if(t.isWebGL2===!0){let m=h.morphAttributes.position||h.morphAttributes.normal||h.morphAttributes.color,v=m!==void 0?m.length:0,x=r.get(h);if(x===void 0||x.count!==v){let R=function(){B.dispose(),r.delete(h),h.removeEventListener("dispose",R)};x!==void 0&&x.texture.dispose();let g=h.morphAttributes.position!==void 0,_=h.morphAttributes.normal!==void 0,b=h.morphAttributes.color!==void 0,S=h.morphAttributes.position||[],T=h.morphAttributes.normal||[],C=h.morphAttributes.color||[],P=0;g===!0&&(P=1),_===!0&&(P=2),b===!0&&(P=3);let y=h.attributes.position.count*P,w=1;y>t.maxTextureSize&&(w=Math.ceil(y/t.maxTextureSize),y=t.maxTextureSize);let F=new Float32Array(y*w*4*v),B=new Ws(F,y,w,v);B.type=mn,B.needsUpdate=!0;let W=P*4;for(let D=0;D<v;D++){let H=S[D],k=T[D],N=C[D],V=y*w*4*D;for(let K=0;K<H.count;K++){let $=K*W;g===!0&&(o.fromBufferAttribute(H,K),F[V+$+0]=o.x,F[V+$+1]=o.y,F[V+$+2]=o.z,F[V+$+3]=0),_===!0&&(o.fromBufferAttribute(k,K),F[V+$+4]=o.x,F[V+$+5]=o.y,F[V+$+6]=o.z,F[V+$+7]=0),b===!0&&(o.fromBufferAttribute(N,K),F[V+$+8]=o.x,F[V+$+9]=o.y,F[V+$+10]=o.z,F[V+$+11]=N.itemSize===4?o.w:1)}}x={count:v,texture:B,size:new Lt(y,w)},r.set(h,x),h.addEventListener("dispose",R)}let p=0;for(let g=0;g<d.length;g++)p+=d[g];let f=h.morphTargetsRelative?1:1-p;u.getUniforms().setValue(s,"morphTargetBaseInfluence",f),u.getUniforms().setValue(s,"morphTargetInfluences",d),u.getUniforms().setValue(s,"morphTargetsTexture",x.texture,e),u.getUniforms().setValue(s,"morphTargetsTextureSize",x.size)}else{let m=d===void 0?0:d.length,v=n[h.id];if(v===void 0||v.length!==m){v=[];for(let _=0;_<m;_++)v[_]=[_,0];n[h.id]=v}for(let _=0;_<m;_++){let b=v[_];b[0]=_,b[1]=d[_]}v.sort(Vf);for(let _=0;_<8;_++)_<m&&v[_][1]?(a[_][0]=v[_][0],a[_][1]=v[_][1]):(a[_][0]=Number.MAX_SAFE_INTEGER,a[_][1]=0);a.sort(kf);let x=h.morphAttributes.position,p=h.morphAttributes.normal,f=0;for(let _=0;_<8;_++){let b=a[_],S=b[0],T=b[1];S!==Number.MAX_SAFE_INTEGER&&T?(x&&h.getAttribute("morphTarget"+_)!==x[S]&&h.setAttribute("morphTarget"+_,x[S]),p&&h.getAttribute("morphNormal"+_)!==p[S]&&h.setAttribute("morphNormal"+_,p[S]),i[_]=T,f+=T):(x&&h.hasAttribute("morphTarget"+_)===!0&&h.deleteAttribute("morphTarget"+_),p&&h.hasAttribute("morphNormal"+_)===!0&&h.deleteAttribute("morphNormal"+_),i[_]=0)}let g=h.morphTargetsRelative?1:1-f;u.getUniforms().setValue(s,"morphTargetBaseInfluence",g),u.getUniforms().setValue(s,"morphTargetInfluences",i)}}return{update:c}}function Gf(s,t,e,n){let i=new WeakMap;function r(c){let l=n.render.frame,h=c.geometry,u=t.get(c,h);if(i.get(u)!==l&&(t.update(u),i.set(u,l)),c.isInstancedMesh&&(c.hasEventListener("dispose",a)===!1&&c.addEventListener("dispose",a),i.get(c)!==l&&(e.update(c.instanceMatrix,s.ARRAY_BUFFER),c.instanceColor!==null&&e.update(c.instanceColor,s.ARRAY_BUFFER),i.set(c,l))),c.isSkinnedMesh){let d=c.skeleton;i.get(d)!==l&&(d.update(),i.set(d,l))}return u}function o(){i=new WeakMap}function a(c){let l=c.target;l.removeEventListener("dispose",a),e.remove(l.instanceMatrix),l.instanceColor!==null&&e.remove(l.instanceColor)}return{update:r,dispose:o}}var $s=class extends Ne{constructor(t,e,n,i,r,o,a,c,l,h){if(h=h!==void 0?h:Fn,h!==Fn&&h!==_i)throw new Error("DepthTexture format must be either THREE.DepthFormat or THREE.DepthStencilFormat");n===void 0&&h===Fn&&(n=pn),n===void 0&&h===_i&&(n=Nn),super(null,i,r,o,a,c,h,n,l),this.isDepthTexture=!0,this.image={width:t,height:e},this.magFilter=a!==void 0?a:be,this.minFilter=c!==void 0?c:be,this.flipY=!1,this.generateMipmaps=!1,this.compareFunction=null}copy(t){return super.copy(t),this.compareFunction=t.compareFunction,this}toJSON(t){let e=super.toJSON(t);return this.compareFunction!==null&&(e.compareFunction=this.compareFunction),e}},jc=new Ne,Qc=new $s(1,1);Qc.compareFunction=Yc;var tl=new Ws,el=new lo,nl=new Js,lc=[],hc=[],uc=new Float32Array(16),dc=new Float32Array(9),fc=new Float32Array(4);function Ti(s,t,e){let n=s[0];if(n<=0||n>0)return s;let i=t*e,r=lc[i];if(r===void 0&&(r=new Float32Array(i),lc[i]=r),t!==0){n.toArray(r,0);for(let o=1,a=0;o!==t;++o)a+=e,s[o].toArray(r,a)}return r}function ae(s,t){if(s.length!==t.length)return!1;for(let e=0,n=s.length;e<n;e++)if(s[e]!==t[e])return!1;return!0}function ce(s,t){for(let e=0,n=t.length;e<n;e++)s[e]=t[e]}function sr(s,t){let e=hc[t];e===void 0&&(e=new Int32Array(t),hc[t]=e);for(let n=0;n!==t;++n)e[n]=s.allocateTextureUnit();return e}function Wf(s,t){let e=this.cache;e[0]!==t&&(s.uniform1f(this.addr,t),e[0]=t)}function Xf(s,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y)&&(s.uniform2f(this.addr,t.x,t.y),e[0]=t.x,e[1]=t.y);else{if(ae(e,t))return;s.uniform2fv(this.addr,t),ce(e,t)}}function qf(s,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z)&&(s.uniform3f(this.addr,t.x,t.y,t.z),e[0]=t.x,e[1]=t.y,e[2]=t.z);else if(t.r!==void 0)(e[0]!==t.r||e[1]!==t.g||e[2]!==t.b)&&(s.uniform3f(this.addr,t.r,t.g,t.b),e[0]=t.r,e[1]=t.g,e[2]=t.b);else{if(ae(e,t))return;s.uniform3fv(this.addr,t),ce(e,t)}}function Yf(s,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z||e[3]!==t.w)&&(s.uniform4f(this.addr,t.x,t.y,t.z,t.w),e[0]=t.x,e[1]=t.y,e[2]=t.z,e[3]=t.w);else{if(ae(e,t))return;s.uniform4fv(this.addr,t),ce(e,t)}}function Zf(s,t){let e=this.cache,n=t.elements;if(n===void 0){if(ae(e,t))return;s.uniformMatrix2fv(this.addr,!1,t),ce(e,t)}else{if(ae(e,n))return;fc.set(n),s.uniformMatrix2fv(this.addr,!1,fc),ce(e,n)}}function Jf(s,t){let e=this.cache,n=t.elements;if(n===void 0){if(ae(e,t))return;s.uniformMatrix3fv(this.addr,!1,t),ce(e,t)}else{if(ae(e,n))return;dc.set(n),s.uniformMatrix3fv(this.addr,!1,dc),ce(e,n)}}function Kf(s,t){let e=this.cache,n=t.elements;if(n===void 0){if(ae(e,t))return;s.uniformMatrix4fv(this.addr,!1,t),ce(e,t)}else{if(ae(e,n))return;uc.set(n),s.uniformMatrix4fv(this.addr,!1,uc),ce(e,n)}}function $f(s,t){let e=this.cache;e[0]!==t&&(s.uniform1i(this.addr,t),e[0]=t)}function jf(s,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y)&&(s.uniform2i(this.addr,t.x,t.y),e[0]=t.x,e[1]=t.y);else{if(ae(e,t))return;s.uniform2iv(this.addr,t),ce(e,t)}}function Qf(s,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z)&&(s.uniform3i(this.addr,t.x,t.y,t.z),e[0]=t.x,e[1]=t.y,e[2]=t.z);else{if(ae(e,t))return;s.uniform3iv(this.addr,t),ce(e,t)}}function tp(s,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z||e[3]!==t.w)&&(s.uniform4i(this.addr,t.x,t.y,t.z,t.w),e[0]=t.x,e[1]=t.y,e[2]=t.z,e[3]=t.w);else{if(ae(e,t))return;s.uniform4iv(this.addr,t),ce(e,t)}}function ep(s,t){let e=this.cache;e[0]!==t&&(s.uniform1ui(this.addr,t),e[0]=t)}function np(s,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y)&&(s.uniform2ui(this.addr,t.x,t.y),e[0]=t.x,e[1]=t.y);else{if(ae(e,t))return;s.uniform2uiv(this.addr,t),ce(e,t)}}function ip(s,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z)&&(s.uniform3ui(this.addr,t.x,t.y,t.z),e[0]=t.x,e[1]=t.y,e[2]=t.z);else{if(ae(e,t))return;s.uniform3uiv(this.addr,t),ce(e,t)}}function sp(s,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z||e[3]!==t.w)&&(s.uniform4ui(this.addr,t.x,t.y,t.z,t.w),e[0]=t.x,e[1]=t.y,e[2]=t.z,e[3]=t.w);else{if(ae(e,t))return;s.uniform4uiv(this.addr,t),ce(e,t)}}function rp(s,t,e){let n=this.cache,i=e.allocateTextureUnit();n[0]!==i&&(s.uniform1i(this.addr,i),n[0]=i);let r=this.type===s.SAMPLER_2D_SHADOW?Qc:jc;e.setTexture2D(t||r,i)}function op(s,t,e){let n=this.cache,i=e.allocateTextureUnit();n[0]!==i&&(s.uniform1i(this.addr,i),n[0]=i),e.setTexture3D(t||el,i)}function ap(s,t,e){let n=this.cache,i=e.allocateTextureUnit();n[0]!==i&&(s.uniform1i(this.addr,i),n[0]=i),e.setTextureCube(t||nl,i)}function cp(s,t,e){let n=this.cache,i=e.allocateTextureUnit();n[0]!==i&&(s.uniform1i(this.addr,i),n[0]=i),e.setTexture2DArray(t||tl,i)}function lp(s){switch(s){case 5126:return Wf;case 35664:return Xf;case 35665:return qf;case 35666:return Yf;case 35674:return Zf;case 35675:return Jf;case 35676:return Kf;case 5124:case 35670:return $f;case 35667:case 35671:return jf;case 35668:case 35672:return Qf;case 35669:case 35673:return tp;case 5125:return ep;case 36294:return np;case 36295:return ip;case 36296:return sp;case 35678:case 36198:case 36298:case 36306:case 35682:return rp;case 35679:case 36299:case 36307:return op;case 35680:case 36300:case 36308:case 36293:return ap;case 36289:case 36303:case 36311:case 36292:return cp}}function hp(s,t){s.uniform1fv(this.addr,t)}function up(s,t){let e=Ti(t,this.size,2);s.uniform2fv(this.addr,e)}function dp(s,t){let e=Ti(t,this.size,3);s.uniform3fv(this.addr,e)}function fp(s,t){let e=Ti(t,this.size,4);s.uniform4fv(this.addr,e)}function pp(s,t){let e=Ti(t,this.size,4);s.uniformMatrix2fv(this.addr,!1,e)}function mp(s,t){let e=Ti(t,this.size,9);s.uniformMatrix3fv(this.addr,!1,e)}function gp(s,t){let e=Ti(t,this.size,16);s.uniformMatrix4fv(this.addr,!1,e)}function _p(s,t){s.uniform1iv(this.addr,t)}function vp(s,t){s.uniform2iv(this.addr,t)}function xp(s,t){s.uniform3iv(this.addr,t)}function yp(s,t){s.uniform4iv(this.addr,t)}function Mp(s,t){s.uniform1uiv(this.addr,t)}function bp(s,t){s.uniform2uiv(this.addr,t)}function Sp(s,t){s.uniform3uiv(this.addr,t)}function wp(s,t){s.uniform4uiv(this.addr,t)}function Ep(s,t,e){let n=this.cache,i=t.length,r=sr(e,i);ae(n,r)||(s.uniform1iv(this.addr,r),ce(n,r));for(let o=0;o!==i;++o)e.setTexture2D(t[o]||jc,r[o])}function Ap(s,t,e){let n=this.cache,i=t.length,r=sr(e,i);ae(n,r)||(s.uniform1iv(this.addr,r),ce(n,r));for(let o=0;o!==i;++o)e.setTexture3D(t[o]||el,r[o])}function Tp(s,t,e){let n=this.cache,i=t.length,r=sr(e,i);ae(n,r)||(s.uniform1iv(this.addr,r),ce(n,r));for(let o=0;o!==i;++o)e.setTextureCube(t[o]||nl,r[o])}function Cp(s,t,e){let n=this.cache,i=t.length,r=sr(e,i);ae(n,r)||(s.uniform1iv(this.addr,r),ce(n,r));for(let o=0;o!==i;++o)e.setTexture2DArray(t[o]||tl,r[o])}function Rp(s){switch(s){case 5126:return hp;case 35664:return up;case 35665:return dp;case 35666:return fp;case 35674:return pp;case 35675:return mp;case 35676:return gp;case 5124:case 35670:return _p;case 35667:case 35671:return vp;case 35668:case 35672:return xp;case 35669:case 35673:return yp;case 5125:return Mp;case 36294:return bp;case 36295:return Sp;case 36296:return wp;case 35678:case 36198:case 36298:case 36306:case 35682:return Ep;case 35679:case 36299:case 36307:return Ap;case 35680:case 36300:case 36308:case 36293:return Tp;case 36289:case 36303:case 36311:case 36292:return Cp}}var po=class{constructor(t,e,n){this.id=t,this.addr=n,this.cache=[],this.type=e.type,this.setValue=lp(e.type)}},mo=class{constructor(t,e,n){this.id=t,this.addr=n,this.cache=[],this.type=e.type,this.size=e.size,this.setValue=Rp(e.type)}},go=class{constructor(t){this.id=t,this.seq=[],this.map={}}setValue(t,e,n){let i=this.seq;for(let r=0,o=i.length;r!==o;++r){let a=i[r];a.setValue(t,e[a.id],n)}}},Jr=/(\w+)(\])?(\[|\.)?/g;function pc(s,t){s.seq.push(t),s.map[t.id]=t}function Pp(s,t,e){let n=s.name,i=n.length;for(Jr.lastIndex=0;;){let r=Jr.exec(n),o=Jr.lastIndex,a=r[1],c=r[2]==="]",l=r[3];if(c&&(a=a|0),l===void 0||l==="["&&o+2===i){pc(e,l===void 0?new po(a,s,t):new mo(a,s,t));break}else{let u=e.map[a];u===void 0&&(u=new go(a),pc(e,u)),e=u}}}var pi=class{constructor(t,e){this.seq=[],this.map={};let n=t.getProgramParameter(e,t.ACTIVE_UNIFORMS);for(let i=0;i<n;++i){let r=t.getActiveUniform(e,i),o=t.getUniformLocation(e,r.name);Pp(r,o,this)}}setValue(t,e,n,i){let r=this.map[e];r!==void 0&&r.setValue(t,n,i)}setOptional(t,e,n){let i=e[n];i!==void 0&&this.setValue(t,n,i)}static upload(t,e,n,i){for(let r=0,o=e.length;r!==o;++r){let a=e[r],c=n[a.id];c.needsUpdate!==!1&&a.setValue(t,c.value,i)}}static seqWithValue(t,e){let n=[];for(let i=0,r=t.length;i!==r;++i){let o=t[i];o.id in e&&n.push(o)}return n}};function mc(s,t,e){let n=s.createShader(t);return s.shaderSource(n,e),s.compileShader(n),n}var Lp=37297,Ip=0;function Dp(s,t){let e=s.split(`
`),n=[],i=Math.max(t-6,0),r=Math.min(t+6,e.length);for(let o=i;o<r;o++){let a=o+1;n.push(`${a===t?">":" "} ${a}: ${e[o]}`)}return n.join(`
`)}function Up(s){let t=qt.getPrimaries(qt.workingColorSpace),e=qt.getPrimaries(s),n;switch(t===e?n="":t===zs&&e===Bs?n="LinearDisplayP3ToLinearSRGB":t===Bs&&e===zs&&(n="LinearSRGBToLinearDisplayP3"),s){case nn:case ir:return[n,"LinearTransferOETF"];case oe:case Vo:return[n,"sRGBTransferOETF"];default:return console.warn("THREE.WebGLProgram: Unsupported color space:",s),[n,"LinearTransferOETF"]}}function gc(s,t,e){let n=s.getShaderParameter(t,s.COMPILE_STATUS),i=s.getShaderInfoLog(t).trim();if(n&&i==="")return"";let r=/ERROR: 0:(\d+)/.exec(i);if(r){let o=parseInt(r[1]);return e.toUpperCase()+`

`+i+`

`+Dp(s.getShaderSource(t),o)}else return i}function Np(s,t){let e=Up(t);return`vec4 ${s}( vec4 value ) { return ${e[0]}( ${e[1]}( value ) ); }`}function Fp(s,t){let e;switch(t){case jl:e="Linear";break;case Ql:e="Reinhard";break;case th:e="OptimizedCineon";break;case eh:e="ACESFilmic";break;case ih:e="AgX";break;case nh:e="Custom";break;default:console.warn("THREE.WebGLProgram: Unsupported toneMapping:",t),e="Linear"}return"vec3 "+s+"( vec3 color ) { return "+e+"ToneMapping( color ); }"}function Op(s){return[s.extensionDerivatives||s.envMapCubeUVHeight||s.bumpMap||s.normalMapTangentSpace||s.clearcoatNormalMap||s.flatShading||s.shaderID==="physical"?"#extension GL_OES_standard_derivatives : enable":"",(s.extensionFragDepth||s.logarithmicDepthBuffer)&&s.rendererExtensionFragDepth?"#extension GL_EXT_frag_depth : enable":"",s.extensionDrawBuffers&&s.rendererExtensionDrawBuffers?"#extension GL_EXT_draw_buffers : require":"",(s.extensionShaderTextureLOD||s.envMap||s.transmission)&&s.rendererExtensionShaderTextureLod?"#extension GL_EXT_shader_texture_lod : enable":""].filter(hi).join(`
`)}function Bp(s){return[s.extensionClipCullDistance?"#extension GL_ANGLE_clip_cull_distance : require":""].filter(hi).join(`
`)}function zp(s){let t=[];for(let e in s){let n=s[e];n!==!1&&t.push("#define "+e+" "+n)}return t.join(`
`)}function kp(s,t){let e={},n=s.getProgramParameter(t,s.ACTIVE_ATTRIBUTES);for(let i=0;i<n;i++){let r=s.getActiveAttrib(t,i),o=r.name,a=1;r.type===s.FLOAT_MAT2&&(a=2),r.type===s.FLOAT_MAT3&&(a=3),r.type===s.FLOAT_MAT4&&(a=4),e[o]={type:r.type,location:s.getAttribLocation(t,o),locationSize:a}}return e}function hi(s){return s!==""}function _c(s,t){let e=t.numSpotLightShadows+t.numSpotLightMaps-t.numSpotLightShadowsWithMaps;return s.replace(/NUM_DIR_LIGHTS/g,t.numDirLights).replace(/NUM_SPOT_LIGHTS/g,t.numSpotLights).replace(/NUM_SPOT_LIGHT_MAPS/g,t.numSpotLightMaps).replace(/NUM_SPOT_LIGHT_COORDS/g,e).replace(/NUM_RECT_AREA_LIGHTS/g,t.numRectAreaLights).replace(/NUM_POINT_LIGHTS/g,t.numPointLights).replace(/NUM_HEMI_LIGHTS/g,t.numHemiLights).replace(/NUM_DIR_LIGHT_SHADOWS/g,t.numDirLightShadows).replace(/NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS/g,t.numSpotLightShadowsWithMaps).replace(/NUM_SPOT_LIGHT_SHADOWS/g,t.numSpotLightShadows).replace(/NUM_POINT_LIGHT_SHADOWS/g,t.numPointLightShadows)}function vc(s,t){return s.replace(/NUM_CLIPPING_PLANES/g,t.numClippingPlanes).replace(/UNION_CLIPPING_PLANES/g,t.numClippingPlanes-t.numClipIntersection)}var Vp=/^[ \t]*#include +<([\w\d./]+)>/gm;function _o(s){return s.replace(Vp,Gp)}var Hp=new Map([["encodings_fragment","colorspace_fragment"],["encodings_pars_fragment","colorspace_pars_fragment"],["output_fragment","opaque_fragment"]]);function Gp(s,t){let e=kt[t];if(e===void 0){let n=Hp.get(t);if(n!==void 0)e=kt[n],console.warn('THREE.WebGLRenderer: Shader chunk "%s" has been deprecated. Use "%s" instead.',t,n);else throw new Error("Can not resolve #include <"+t+">")}return _o(e)}var Wp=/#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;function xc(s){return s.replace(Wp,Xp)}function Xp(s,t,e,n){let i="";for(let r=parseInt(t);r<parseInt(e);r++)i+=n.replace(/\[\s*i\s*\]/g,"[ "+r+" ]").replace(/UNROLLED_LOOP_INDEX/g,r);return i}function yc(s){let t="precision "+s.precision+` float;
precision `+s.precision+" int;";return s.precision==="highp"?t+=`
#define HIGH_PRECISION`:s.precision==="mediump"?t+=`
#define MEDIUM_PRECISION`:s.precision==="lowp"&&(t+=`
#define LOW_PRECISION`),t}function qp(s){let t="SHADOWMAP_TYPE_BASIC";return s.shadowMapType===Fc?t="SHADOWMAP_TYPE_PCF":s.shadowMapType===Al?t="SHADOWMAP_TYPE_PCF_SOFT":s.shadowMapType===$e&&(t="SHADOWMAP_TYPE_VSM"),t}function Yp(s){let t="ENVMAP_TYPE_CUBE";if(s.envMap)switch(s.envMapMode){case mi:case gi:t="ENVMAP_TYPE_CUBE";break;case nr:t="ENVMAP_TYPE_CUBE_UV";break}return t}function Zp(s){let t="ENVMAP_MODE_REFLECTION";if(s.envMap)switch(s.envMapMode){case gi:t="ENVMAP_MODE_REFRACTION";break}return t}function Jp(s){let t="ENVMAP_BLENDING_NONE";if(s.envMap)switch(s.combine){case Oc:t="ENVMAP_BLENDING_MULTIPLY";break;case Kl:t="ENVMAP_BLENDING_MIX";break;case $l:t="ENVMAP_BLENDING_ADD";break}return t}function Kp(s){let t=s.envMapCubeUVHeight;if(t===null)return null;let e=Math.log2(t)-2,n=1/t;return{texelWidth:1/(3*Math.max(Math.pow(2,e),112)),texelHeight:n,maxMip:e}}function $p(s,t,e,n){let i=s.getContext(),r=e.defines,o=e.vertexShader,a=e.fragmentShader,c=qp(e),l=Yp(e),h=Zp(e),u=Jp(e),d=Kp(e),m=e.isWebGL2?"":Op(e),v=Bp(e),x=zp(r),p=i.createProgram(),f,g,_=e.glslVersion?"#version "+e.glslVersion+`
`:"";e.isRawShaderMaterial?(f=["#define SHADER_TYPE "+e.shaderType,"#define SHADER_NAME "+e.shaderName,x].filter(hi).join(`
`),f.length>0&&(f+=`
`),g=[m,"#define SHADER_TYPE "+e.shaderType,"#define SHADER_NAME "+e.shaderName,x].filter(hi).join(`
`),g.length>0&&(g+=`
`)):(f=[yc(e),"#define SHADER_TYPE "+e.shaderType,"#define SHADER_NAME "+e.shaderName,x,e.extensionClipCullDistance?"#define USE_CLIP_DISTANCE":"",e.batching?"#define USE_BATCHING":"",e.instancing?"#define USE_INSTANCING":"",e.instancingColor?"#define USE_INSTANCING_COLOR":"",e.useFog&&e.fog?"#define USE_FOG":"",e.useFog&&e.fogExp2?"#define FOG_EXP2":"",e.map?"#define USE_MAP":"",e.envMap?"#define USE_ENVMAP":"",e.envMap?"#define "+h:"",e.lightMap?"#define USE_LIGHTMAP":"",e.aoMap?"#define USE_AOMAP":"",e.bumpMap?"#define USE_BUMPMAP":"",e.normalMap?"#define USE_NORMALMAP":"",e.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",e.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",e.displacementMap?"#define USE_DISPLACEMENTMAP":"",e.emissiveMap?"#define USE_EMISSIVEMAP":"",e.anisotropy?"#define USE_ANISOTROPY":"",e.anisotropyMap?"#define USE_ANISOTROPYMAP":"",e.clearcoatMap?"#define USE_CLEARCOATMAP":"",e.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",e.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",e.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",e.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",e.specularMap?"#define USE_SPECULARMAP":"",e.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",e.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",e.roughnessMap?"#define USE_ROUGHNESSMAP":"",e.metalnessMap?"#define USE_METALNESSMAP":"",e.alphaMap?"#define USE_ALPHAMAP":"",e.alphaHash?"#define USE_ALPHAHASH":"",e.transmission?"#define USE_TRANSMISSION":"",e.transmissionMap?"#define USE_TRANSMISSIONMAP":"",e.thicknessMap?"#define USE_THICKNESSMAP":"",e.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",e.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",e.mapUv?"#define MAP_UV "+e.mapUv:"",e.alphaMapUv?"#define ALPHAMAP_UV "+e.alphaMapUv:"",e.lightMapUv?"#define LIGHTMAP_UV "+e.lightMapUv:"",e.aoMapUv?"#define AOMAP_UV "+e.aoMapUv:"",e.emissiveMapUv?"#define EMISSIVEMAP_UV "+e.emissiveMapUv:"",e.bumpMapUv?"#define BUMPMAP_UV "+e.bumpMapUv:"",e.normalMapUv?"#define NORMALMAP_UV "+e.normalMapUv:"",e.displacementMapUv?"#define DISPLACEMENTMAP_UV "+e.displacementMapUv:"",e.metalnessMapUv?"#define METALNESSMAP_UV "+e.metalnessMapUv:"",e.roughnessMapUv?"#define ROUGHNESSMAP_UV "+e.roughnessMapUv:"",e.anisotropyMapUv?"#define ANISOTROPYMAP_UV "+e.anisotropyMapUv:"",e.clearcoatMapUv?"#define CLEARCOATMAP_UV "+e.clearcoatMapUv:"",e.clearcoatNormalMapUv?"#define CLEARCOAT_NORMALMAP_UV "+e.clearcoatNormalMapUv:"",e.clearcoatRoughnessMapUv?"#define CLEARCOAT_ROUGHNESSMAP_UV "+e.clearcoatRoughnessMapUv:"",e.iridescenceMapUv?"#define IRIDESCENCEMAP_UV "+e.iridescenceMapUv:"",e.iridescenceThicknessMapUv?"#define IRIDESCENCE_THICKNESSMAP_UV "+e.iridescenceThicknessMapUv:"",e.sheenColorMapUv?"#define SHEEN_COLORMAP_UV "+e.sheenColorMapUv:"",e.sheenRoughnessMapUv?"#define SHEEN_ROUGHNESSMAP_UV "+e.sheenRoughnessMapUv:"",e.specularMapUv?"#define SPECULARMAP_UV "+e.specularMapUv:"",e.specularColorMapUv?"#define SPECULAR_COLORMAP_UV "+e.specularColorMapUv:"",e.specularIntensityMapUv?"#define SPECULAR_INTENSITYMAP_UV "+e.specularIntensityMapUv:"",e.transmissionMapUv?"#define TRANSMISSIONMAP_UV "+e.transmissionMapUv:"",e.thicknessMapUv?"#define THICKNESSMAP_UV "+e.thicknessMapUv:"",e.vertexTangents&&e.flatShading===!1?"#define USE_TANGENT":"",e.vertexColors?"#define USE_COLOR":"",e.vertexAlphas?"#define USE_COLOR_ALPHA":"",e.vertexUv1s?"#define USE_UV1":"",e.vertexUv2s?"#define USE_UV2":"",e.vertexUv3s?"#define USE_UV3":"",e.pointsUvs?"#define USE_POINTS_UV":"",e.flatShading?"#define FLAT_SHADED":"",e.skinning?"#define USE_SKINNING":"",e.morphTargets?"#define USE_MORPHTARGETS":"",e.morphNormals&&e.flatShading===!1?"#define USE_MORPHNORMALS":"",e.morphColors&&e.isWebGL2?"#define USE_MORPHCOLORS":"",e.morphTargetsCount>0&&e.isWebGL2?"#define MORPHTARGETS_TEXTURE":"",e.morphTargetsCount>0&&e.isWebGL2?"#define MORPHTARGETS_TEXTURE_STRIDE "+e.morphTextureStride:"",e.morphTargetsCount>0&&e.isWebGL2?"#define MORPHTARGETS_COUNT "+e.morphTargetsCount:"",e.doubleSided?"#define DOUBLE_SIDED":"",e.flipSided?"#define FLIP_SIDED":"",e.shadowMapEnabled?"#define USE_SHADOWMAP":"",e.shadowMapEnabled?"#define "+c:"",e.sizeAttenuation?"#define USE_SIZEATTENUATION":"",e.numLightProbes>0?"#define USE_LIGHT_PROBES":"",e.useLegacyLights?"#define LEGACY_LIGHTS":"",e.logarithmicDepthBuffer?"#define USE_LOGDEPTHBUF":"",e.logarithmicDepthBuffer&&e.rendererExtensionFragDepth?"#define USE_LOGDEPTHBUF_EXT":"","uniform mat4 modelMatrix;","uniform mat4 modelViewMatrix;","uniform mat4 projectionMatrix;","uniform mat4 viewMatrix;","uniform mat3 normalMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;","#ifdef USE_INSTANCING","	attribute mat4 instanceMatrix;","#endif","#ifdef USE_INSTANCING_COLOR","	attribute vec3 instanceColor;","#endif","attribute vec3 position;","attribute vec3 normal;","attribute vec2 uv;","#ifdef USE_UV1","	attribute vec2 uv1;","#endif","#ifdef USE_UV2","	attribute vec2 uv2;","#endif","#ifdef USE_UV3","	attribute vec2 uv3;","#endif","#ifdef USE_TANGENT","	attribute vec4 tangent;","#endif","#if defined( USE_COLOR_ALPHA )","	attribute vec4 color;","#elif defined( USE_COLOR )","	attribute vec3 color;","#endif","#if ( defined( USE_MORPHTARGETS ) && ! defined( MORPHTARGETS_TEXTURE ) )","	attribute vec3 morphTarget0;","	attribute vec3 morphTarget1;","	attribute vec3 morphTarget2;","	attribute vec3 morphTarget3;","	#ifdef USE_MORPHNORMALS","		attribute vec3 morphNormal0;","		attribute vec3 morphNormal1;","		attribute vec3 morphNormal2;","		attribute vec3 morphNormal3;","	#else","		attribute vec3 morphTarget4;","		attribute vec3 morphTarget5;","		attribute vec3 morphTarget6;","		attribute vec3 morphTarget7;","	#endif","#endif","#ifdef USE_SKINNING","	attribute vec4 skinIndex;","	attribute vec4 skinWeight;","#endif",`
`].filter(hi).join(`
`),g=[m,yc(e),"#define SHADER_TYPE "+e.shaderType,"#define SHADER_NAME "+e.shaderName,x,e.useFog&&e.fog?"#define USE_FOG":"",e.useFog&&e.fogExp2?"#define FOG_EXP2":"",e.map?"#define USE_MAP":"",e.matcap?"#define USE_MATCAP":"",e.envMap?"#define USE_ENVMAP":"",e.envMap?"#define "+l:"",e.envMap?"#define "+h:"",e.envMap?"#define "+u:"",d?"#define CUBEUV_TEXEL_WIDTH "+d.texelWidth:"",d?"#define CUBEUV_TEXEL_HEIGHT "+d.texelHeight:"",d?"#define CUBEUV_MAX_MIP "+d.maxMip+".0":"",e.lightMap?"#define USE_LIGHTMAP":"",e.aoMap?"#define USE_AOMAP":"",e.bumpMap?"#define USE_BUMPMAP":"",e.normalMap?"#define USE_NORMALMAP":"",e.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",e.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",e.emissiveMap?"#define USE_EMISSIVEMAP":"",e.anisotropy?"#define USE_ANISOTROPY":"",e.anisotropyMap?"#define USE_ANISOTROPYMAP":"",e.clearcoat?"#define USE_CLEARCOAT":"",e.clearcoatMap?"#define USE_CLEARCOATMAP":"",e.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",e.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",e.iridescence?"#define USE_IRIDESCENCE":"",e.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",e.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",e.specularMap?"#define USE_SPECULARMAP":"",e.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",e.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",e.roughnessMap?"#define USE_ROUGHNESSMAP":"",e.metalnessMap?"#define USE_METALNESSMAP":"",e.alphaMap?"#define USE_ALPHAMAP":"",e.alphaTest?"#define USE_ALPHATEST":"",e.alphaHash?"#define USE_ALPHAHASH":"",e.sheen?"#define USE_SHEEN":"",e.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",e.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",e.transmission?"#define USE_TRANSMISSION":"",e.transmissionMap?"#define USE_TRANSMISSIONMAP":"",e.thicknessMap?"#define USE_THICKNESSMAP":"",e.vertexTangents&&e.flatShading===!1?"#define USE_TANGENT":"",e.vertexColors||e.instancingColor?"#define USE_COLOR":"",e.vertexAlphas?"#define USE_COLOR_ALPHA":"",e.vertexUv1s?"#define USE_UV1":"",e.vertexUv2s?"#define USE_UV2":"",e.vertexUv3s?"#define USE_UV3":"",e.pointsUvs?"#define USE_POINTS_UV":"",e.gradientMap?"#define USE_GRADIENTMAP":"",e.flatShading?"#define FLAT_SHADED":"",e.doubleSided?"#define DOUBLE_SIDED":"",e.flipSided?"#define FLIP_SIDED":"",e.shadowMapEnabled?"#define USE_SHADOWMAP":"",e.shadowMapEnabled?"#define "+c:"",e.premultipliedAlpha?"#define PREMULTIPLIED_ALPHA":"",e.numLightProbes>0?"#define USE_LIGHT_PROBES":"",e.useLegacyLights?"#define LEGACY_LIGHTS":"",e.decodeVideoTexture?"#define DECODE_VIDEO_TEXTURE":"",e.logarithmicDepthBuffer?"#define USE_LOGDEPTHBUF":"",e.logarithmicDepthBuffer&&e.rendererExtensionFragDepth?"#define USE_LOGDEPTHBUF_EXT":"","uniform mat4 viewMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;",e.toneMapping!==_n?"#define TONE_MAPPING":"",e.toneMapping!==_n?kt.tonemapping_pars_fragment:"",e.toneMapping!==_n?Fp("toneMapping",e.toneMapping):"",e.dithering?"#define DITHERING":"",e.opaque?"#define OPAQUE":"",kt.colorspace_pars_fragment,Np("linearToOutputTexel",e.outputColorSpace),e.useDepthPacking?"#define DEPTH_PACKING "+e.depthPacking:"",`
`].filter(hi).join(`
`)),o=_o(o),o=_c(o,e),o=vc(o,e),a=_o(a),a=_c(a,e),a=vc(a,e),o=xc(o),a=xc(a),e.isWebGL2&&e.isRawShaderMaterial!==!0&&(_=`#version 300 es
`,f=[v,"precision mediump sampler2DArray;","#define attribute in","#define varying out","#define texture2D texture"].join(`
`)+`
`+f,g=["precision mediump sampler2DArray;","#define varying in",e.glslVersion===za?"":"layout(location = 0) out highp vec4 pc_fragColor;",e.glslVersion===za?"":"#define gl_FragColor pc_fragColor","#define gl_FragDepthEXT gl_FragDepth","#define texture2D texture","#define textureCube texture","#define texture2DProj textureProj","#define texture2DLodEXT textureLod","#define texture2DProjLodEXT textureProjLod","#define textureCubeLodEXT textureLod","#define texture2DGradEXT textureGrad","#define texture2DProjGradEXT textureProjGrad","#define textureCubeGradEXT textureGrad"].join(`
`)+`
`+g);let b=_+f+o,S=_+g+a,T=mc(i,i.VERTEX_SHADER,b),C=mc(i,i.FRAGMENT_SHADER,S);i.attachShader(p,T),i.attachShader(p,C),e.index0AttributeName!==void 0?i.bindAttribLocation(p,0,e.index0AttributeName):e.morphTargets===!0&&i.bindAttribLocation(p,0,"position"),i.linkProgram(p);function P(B){if(s.debug.checkShaderErrors){let W=i.getProgramInfoLog(p).trim(),R=i.getShaderInfoLog(T).trim(),D=i.getShaderInfoLog(C).trim(),H=!0,k=!0;if(i.getProgramParameter(p,i.LINK_STATUS)===!1)if(H=!1,typeof s.debug.onShaderError=="function")s.debug.onShaderError(i,p,T,C);else{let N=gc(i,T,"vertex"),V=gc(i,C,"fragment");console.error("THREE.WebGLProgram: Shader Error "+i.getError()+" - VALIDATE_STATUS "+i.getProgramParameter(p,i.VALIDATE_STATUS)+`

Program Info Log: `+W+`
`+N+`
`+V)}else W!==""?console.warn("THREE.WebGLProgram: Program Info Log:",W):(R===""||D==="")&&(k=!1);k&&(B.diagnostics={runnable:H,programLog:W,vertexShader:{log:R,prefix:f},fragmentShader:{log:D,prefix:g}})}i.deleteShader(T),i.deleteShader(C),y=new pi(i,p),w=kp(i,p)}let y;this.getUniforms=function(){return y===void 0&&P(this),y};let w;this.getAttributes=function(){return w===void 0&&P(this),w};let F=e.rendererExtensionParallelShaderCompile===!1;return this.isReady=function(){return F===!1&&(F=i.getProgramParameter(p,Lp)),F},this.destroy=function(){n.releaseStatesOfProgram(this),i.deleteProgram(p),this.program=void 0},this.type=e.shaderType,this.name=e.shaderName,this.id=Ip++,this.cacheKey=t,this.usedTimes=1,this.program=p,this.vertexShader=T,this.fragmentShader=C,this}var jp=0,vo=class{constructor(){this.shaderCache=new Map,this.materialCache=new Map}update(t){let e=t.vertexShader,n=t.fragmentShader,i=this._getShaderStage(e),r=this._getShaderStage(n),o=this._getShaderCacheForMaterial(t);return o.has(i)===!1&&(o.add(i),i.usedTimes++),o.has(r)===!1&&(o.add(r),r.usedTimes++),this}remove(t){let e=this.materialCache.get(t);for(let n of e)n.usedTimes--,n.usedTimes===0&&this.shaderCache.delete(n.code);return this.materialCache.delete(t),this}getVertexShaderID(t){return this._getShaderStage(t.vertexShader).id}getFragmentShaderID(t){return this._getShaderStage(t.fragmentShader).id}dispose(){this.shaderCache.clear(),this.materialCache.clear()}_getShaderCacheForMaterial(t){let e=this.materialCache,n=e.get(t);return n===void 0&&(n=new Set,e.set(t,n)),n}_getShaderStage(t){let e=this.shaderCache,n=e.get(t);return n===void 0&&(n=new xo(t),e.set(t,n)),n}},xo=class{constructor(t){this.id=jp++,this.code=t,this.usedTimes=0}};function Qp(s,t,e,n,i,r,o){let a=new Gi,c=new vo,l=[],h=i.isWebGL2,u=i.logarithmicDepthBuffer,d=i.vertexTextures,m=i.precision,v={MeshDepthMaterial:"depth",MeshDistanceMaterial:"distanceRGBA",MeshNormalMaterial:"normal",MeshBasicMaterial:"basic",MeshLambertMaterial:"lambert",MeshPhongMaterial:"phong",MeshToonMaterial:"toon",MeshStandardMaterial:"physical",MeshPhysicalMaterial:"physical",MeshMatcapMaterial:"matcap",LineBasicMaterial:"basic",LineDashedMaterial:"dashed",PointsMaterial:"points",ShadowMaterial:"shadow",SpriteMaterial:"sprite"};function x(y){return y===0?"uv":`uv${y}`}function p(y,w,F,B,W){let R=B.fog,D=W.geometry,H=y.isMeshStandardMaterial?B.environment:null,k=(y.isMeshStandardMaterial?e:t).get(y.envMap||H),N=k&&k.mapping===nr?k.image.height:null,V=v[y.type];y.precision!==null&&(m=i.getMaxPrecision(y.precision),m!==y.precision&&console.warn("THREE.WebGLProgram.getParameters:",y.precision,"not supported, using",m,"instead."));let K=D.morphAttributes.position||D.morphAttributes.normal||D.morphAttributes.color,$=K!==void 0?K.length:0,ct=0;D.morphAttributes.position!==void 0&&(ct=1),D.morphAttributes.normal!==void 0&&(ct=2),D.morphAttributes.color!==void 0&&(ct=3);let G,J,ot,nt;if(V){let ve=We[V];G=ve.vertexShader,J=ve.fragmentShader}else G=y.vertexShader,J=y.fragmentShader,c.update(y),ot=c.getVertexShaderID(y),nt=c.getFragmentShaderID(y);let ht=s.getRenderTarget(),xt=W.isInstancedMesh===!0,Y=W.isBatchedMesh===!0,lt=!!y.map,pt=!!y.matcap,U=!!k,bt=!!y.aoMap,et=!!y.lightMap,at=!!y.bumpMap,it=!!y.normalMap,wt=!!y.displacementMap,Mt=!!y.emissiveMap,E=!!y.metalnessMap,M=!!y.roughnessMap,O=y.anisotropy>0,tt=y.clearcoat>0,j=y.iridescence>0,Q=y.sheen>0,_t=y.transmission>0,ft=O&&!!y.anisotropyMap,yt=tt&&!!y.clearcoatMap,At=tt&&!!y.clearcoatNormalMap,Ut=tt&&!!y.clearcoatRoughnessMap,st=j&&!!y.iridescenceMap,Xt=j&&!!y.iridescenceThicknessMap,Ft=Q&&!!y.sheenColorMap,Ct=Q&&!!y.sheenRoughnessMap,Tt=!!y.specularMap,rt=!!y.specularColorMap,St=!!y.specularIntensityMap,Wt=_t&&!!y.transmissionMap,jt=_t&&!!y.thicknessMap,Ot=!!y.gradientMap,ut=!!y.alphaMap,I=y.alphaTest>0,mt=!!y.alphaHash,gt=!!y.extensions,It=!!D.attributes.uv1,Rt=!!D.attributes.uv2,Jt=!!D.attributes.uv3,Kt=_n;return y.toneMapped&&(ht===null||ht.isXRRenderTarget===!0)&&(Kt=s.toneMapping),{isWebGL2:h,shaderID:V,shaderType:y.type,shaderName:y.name,vertexShader:G,fragmentShader:J,defines:y.defines,customVertexShaderID:ot,customFragmentShaderID:nt,isRawShaderMaterial:y.isRawShaderMaterial===!0,glslVersion:y.glslVersion,precision:m,batching:Y,instancing:xt,instancingColor:xt&&W.instanceColor!==null,supportsVertexTextures:d,outputColorSpace:ht===null?s.outputColorSpace:ht.isXRRenderTarget===!0?ht.texture.colorSpace:nn,map:lt,matcap:pt,envMap:U,envMapMode:U&&k.mapping,envMapCubeUVHeight:N,aoMap:bt,lightMap:et,bumpMap:at,normalMap:it,displacementMap:d&&wt,emissiveMap:Mt,normalMapObjectSpace:it&&y.normalMapType===gh,normalMapTangentSpace:it&&y.normalMapType===mh,metalnessMap:E,roughnessMap:M,anisotropy:O,anisotropyMap:ft,clearcoat:tt,clearcoatMap:yt,clearcoatNormalMap:At,clearcoatRoughnessMap:Ut,iridescence:j,iridescenceMap:st,iridescenceThicknessMap:Xt,sheen:Q,sheenColorMap:Ft,sheenRoughnessMap:Ct,specularMap:Tt,specularColorMap:rt,specularIntensityMap:St,transmission:_t,transmissionMap:Wt,thicknessMap:jt,gradientMap:Ot,opaque:y.transparent===!1&&y.blending===di,alphaMap:ut,alphaTest:I,alphaHash:mt,combine:y.combine,mapUv:lt&&x(y.map.channel),aoMapUv:bt&&x(y.aoMap.channel),lightMapUv:et&&x(y.lightMap.channel),bumpMapUv:at&&x(y.bumpMap.channel),normalMapUv:it&&x(y.normalMap.channel),displacementMapUv:wt&&x(y.displacementMap.channel),emissiveMapUv:Mt&&x(y.emissiveMap.channel),metalnessMapUv:E&&x(y.metalnessMap.channel),roughnessMapUv:M&&x(y.roughnessMap.channel),anisotropyMapUv:ft&&x(y.anisotropyMap.channel),clearcoatMapUv:yt&&x(y.clearcoatMap.channel),clearcoatNormalMapUv:At&&x(y.clearcoatNormalMap.channel),clearcoatRoughnessMapUv:Ut&&x(y.clearcoatRoughnessMap.channel),iridescenceMapUv:st&&x(y.iridescenceMap.channel),iridescenceThicknessMapUv:Xt&&x(y.iridescenceThicknessMap.channel),sheenColorMapUv:Ft&&x(y.sheenColorMap.channel),sheenRoughnessMapUv:Ct&&x(y.sheenRoughnessMap.channel),specularMapUv:Tt&&x(y.specularMap.channel),specularColorMapUv:rt&&x(y.specularColorMap.channel),specularIntensityMapUv:St&&x(y.specularIntensityMap.channel),transmissionMapUv:Wt&&x(y.transmissionMap.channel),thicknessMapUv:jt&&x(y.thicknessMap.channel),alphaMapUv:ut&&x(y.alphaMap.channel),vertexTangents:!!D.attributes.tangent&&(it||O),vertexColors:y.vertexColors,vertexAlphas:y.vertexColors===!0&&!!D.attributes.color&&D.attributes.color.itemSize===4,vertexUv1s:It,vertexUv2s:Rt,vertexUv3s:Jt,pointsUvs:W.isPoints===!0&&!!D.attributes.uv&&(lt||ut),fog:!!R,useFog:y.fog===!0,fogExp2:R&&R.isFogExp2,flatShading:y.flatShading===!0,sizeAttenuation:y.sizeAttenuation===!0,logarithmicDepthBuffer:u,skinning:W.isSkinnedMesh===!0,morphTargets:D.morphAttributes.position!==void 0,morphNormals:D.morphAttributes.normal!==void 0,morphColors:D.morphAttributes.color!==void 0,morphTargetsCount:$,morphTextureStride:ct,numDirLights:w.directional.length,numPointLights:w.point.length,numSpotLights:w.spot.length,numSpotLightMaps:w.spotLightMap.length,numRectAreaLights:w.rectArea.length,numHemiLights:w.hemi.length,numDirLightShadows:w.directionalShadowMap.length,numPointLightShadows:w.pointShadowMap.length,numSpotLightShadows:w.spotShadowMap.length,numSpotLightShadowsWithMaps:w.numSpotLightShadowsWithMaps,numLightProbes:w.numLightProbes,numClippingPlanes:o.numPlanes,numClipIntersection:o.numIntersection,dithering:y.dithering,shadowMapEnabled:s.shadowMap.enabled&&F.length>0,shadowMapType:s.shadowMap.type,toneMapping:Kt,useLegacyLights:s._useLegacyLights,decodeVideoTexture:lt&&y.map.isVideoTexture===!0&&qt.getTransfer(y.map.colorSpace)===Qt,premultipliedAlpha:y.premultipliedAlpha,doubleSided:y.side===Qe,flipSided:y.side===Ee,useDepthPacking:y.depthPacking>=0,depthPacking:y.depthPacking||0,index0AttributeName:y.index0AttributeName,extensionDerivatives:gt&&y.extensions.derivatives===!0,extensionFragDepth:gt&&y.extensions.fragDepth===!0,extensionDrawBuffers:gt&&y.extensions.drawBuffers===!0,extensionShaderTextureLOD:gt&&y.extensions.shaderTextureLOD===!0,extensionClipCullDistance:gt&&y.extensions.clipCullDistance&&n.has("WEBGL_clip_cull_distance"),rendererExtensionFragDepth:h||n.has("EXT_frag_depth"),rendererExtensionDrawBuffers:h||n.has("WEBGL_draw_buffers"),rendererExtensionShaderTextureLod:h||n.has("EXT_shader_texture_lod"),rendererExtensionParallelShaderCompile:n.has("KHR_parallel_shader_compile"),customProgramCacheKey:y.customProgramCacheKey()}}function f(y){let w=[];if(y.shaderID?w.push(y.shaderID):(w.push(y.customVertexShaderID),w.push(y.customFragmentShaderID)),y.defines!==void 0)for(let F in y.defines)w.push(F),w.push(y.defines[F]);return y.isRawShaderMaterial===!1&&(g(w,y),_(w,y),w.push(s.outputColorSpace)),w.push(y.customProgramCacheKey),w.join()}function g(y,w){y.push(w.precision),y.push(w.outputColorSpace),y.push(w.envMapMode),y.push(w.envMapCubeUVHeight),y.push(w.mapUv),y.push(w.alphaMapUv),y.push(w.lightMapUv),y.push(w.aoMapUv),y.push(w.bumpMapUv),y.push(w.normalMapUv),y.push(w.displacementMapUv),y.push(w.emissiveMapUv),y.push(w.metalnessMapUv),y.push(w.roughnessMapUv),y.push(w.anisotropyMapUv),y.push(w.clearcoatMapUv),y.push(w.clearcoatNormalMapUv),y.push(w.clearcoatRoughnessMapUv),y.push(w.iridescenceMapUv),y.push(w.iridescenceThicknessMapUv),y.push(w.sheenColorMapUv),y.push(w.sheenRoughnessMapUv),y.push(w.specularMapUv),y.push(w.specularColorMapUv),y.push(w.specularIntensityMapUv),y.push(w.transmissionMapUv),y.push(w.thicknessMapUv),y.push(w.combine),y.push(w.fogExp2),y.push(w.sizeAttenuation),y.push(w.morphTargetsCount),y.push(w.morphAttributeCount),y.push(w.numDirLights),y.push(w.numPointLights),y.push(w.numSpotLights),y.push(w.numSpotLightMaps),y.push(w.numHemiLights),y.push(w.numRectAreaLights),y.push(w.numDirLightShadows),y.push(w.numPointLightShadows),y.push(w.numSpotLightShadows),y.push(w.numSpotLightShadowsWithMaps),y.push(w.numLightProbes),y.push(w.shadowMapType),y.push(w.toneMapping),y.push(w.numClippingPlanes),y.push(w.numClipIntersection),y.push(w.depthPacking)}function _(y,w){a.disableAll(),w.isWebGL2&&a.enable(0),w.supportsVertexTextures&&a.enable(1),w.instancing&&a.enable(2),w.instancingColor&&a.enable(3),w.matcap&&a.enable(4),w.envMap&&a.enable(5),w.normalMapObjectSpace&&a.enable(6),w.normalMapTangentSpace&&a.enable(7),w.clearcoat&&a.enable(8),w.iridescence&&a.enable(9),w.alphaTest&&a.enable(10),w.vertexColors&&a.enable(11),w.vertexAlphas&&a.enable(12),w.vertexUv1s&&a.enable(13),w.vertexUv2s&&a.enable(14),w.vertexUv3s&&a.enable(15),w.vertexTangents&&a.enable(16),w.anisotropy&&a.enable(17),w.alphaHash&&a.enable(18),w.batching&&a.enable(19),y.push(a.mask),a.disableAll(),w.fog&&a.enable(0),w.useFog&&a.enable(1),w.flatShading&&a.enable(2),w.logarithmicDepthBuffer&&a.enable(3),w.skinning&&a.enable(4),w.morphTargets&&a.enable(5),w.morphNormals&&a.enable(6),w.morphColors&&a.enable(7),w.premultipliedAlpha&&a.enable(8),w.shadowMapEnabled&&a.enable(9),w.useLegacyLights&&a.enable(10),w.doubleSided&&a.enable(11),w.flipSided&&a.enable(12),w.useDepthPacking&&a.enable(13),w.dithering&&a.enable(14),w.transmission&&a.enable(15),w.sheen&&a.enable(16),w.opaque&&a.enable(17),w.pointsUvs&&a.enable(18),w.decodeVideoTexture&&a.enable(19),y.push(a.mask)}function b(y){let w=v[y.type],F;if(w){let B=We[w];F=Vh.clone(B.uniforms)}else F=y.uniforms;return F}function S(y,w){let F;for(let B=0,W=l.length;B<W;B++){let R=l[B];if(R.cacheKey===w){F=R,++F.usedTimes;break}}return F===void 0&&(F=new $p(s,w,y,r),l.push(F)),F}function T(y){if(--y.usedTimes===0){let w=l.indexOf(y);l[w]=l[l.length-1],l.pop(),y.destroy()}}function C(y){c.remove(y)}function P(){c.dispose()}return{getParameters:p,getProgramCacheKey:f,getUniforms:b,acquireProgram:S,releaseProgram:T,releaseShaderCache:C,programs:l,dispose:P}}function tm(){let s=new WeakMap;function t(r){let o=s.get(r);return o===void 0&&(o={},s.set(r,o)),o}function e(r){s.delete(r)}function n(r,o,a){s.get(r)[o]=a}function i(){s=new WeakMap}return{get:t,remove:e,update:n,dispose:i}}function em(s,t){return s.groupOrder!==t.groupOrder?s.groupOrder-t.groupOrder:s.renderOrder!==t.renderOrder?s.renderOrder-t.renderOrder:s.material.id!==t.material.id?s.material.id-t.material.id:s.z!==t.z?s.z-t.z:s.id-t.id}function Mc(s,t){return s.groupOrder!==t.groupOrder?s.groupOrder-t.groupOrder:s.renderOrder!==t.renderOrder?s.renderOrder-t.renderOrder:s.z!==t.z?t.z-s.z:s.id-t.id}function bc(){let s=[],t=0,e=[],n=[],i=[];function r(){t=0,e.length=0,n.length=0,i.length=0}function o(u,d,m,v,x,p){let f=s[t];return f===void 0?(f={id:u.id,object:u,geometry:d,material:m,groupOrder:v,renderOrder:u.renderOrder,z:x,group:p},s[t]=f):(f.id=u.id,f.object=u,f.geometry=d,f.material=m,f.groupOrder=v,f.renderOrder=u.renderOrder,f.z=x,f.group=p),t++,f}function a(u,d,m,v,x,p){let f=o(u,d,m,v,x,p);m.transmission>0?n.push(f):m.transparent===!0?i.push(f):e.push(f)}function c(u,d,m,v,x,p){let f=o(u,d,m,v,x,p);m.transmission>0?n.unshift(f):m.transparent===!0?i.unshift(f):e.unshift(f)}function l(u,d){e.length>1&&e.sort(u||em),n.length>1&&n.sort(d||Mc),i.length>1&&i.sort(d||Mc)}function h(){for(let u=t,d=s.length;u<d;u++){let m=s[u];if(m.id===null)break;m.id=null,m.object=null,m.geometry=null,m.material=null,m.group=null}}return{opaque:e,transmissive:n,transparent:i,init:r,push:a,unshift:c,finish:h,sort:l}}function nm(){let s=new WeakMap;function t(n,i){let r=s.get(n),o;return r===void 0?(o=new bc,s.set(n,[o])):i>=r.length?(o=new bc,r.push(o)):o=r[i],o}function e(){s=new WeakMap}return{get:t,dispose:e}}function im(){let s={};return{get:function(t){if(s[t.id]!==void 0)return s[t.id];let e;switch(t.type){case"DirectionalLight":e={direction:new L,color:new zt};break;case"SpotLight":e={position:new L,direction:new L,color:new zt,distance:0,coneCos:0,penumbraCos:0,decay:0};break;case"PointLight":e={position:new L,color:new zt,distance:0,decay:0};break;case"HemisphereLight":e={direction:new L,skyColor:new zt,groundColor:new zt};break;case"RectAreaLight":e={color:new zt,position:new L,halfWidth:new L,halfHeight:new L};break}return s[t.id]=e,e}}}function sm(){let s={};return{get:function(t){if(s[t.id]!==void 0)return s[t.id];let e;switch(t.type){case"DirectionalLight":e={shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new Lt};break;case"SpotLight":e={shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new Lt};break;case"PointLight":e={shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new Lt,shadowCameraNear:1,shadowCameraFar:1e3};break}return s[t.id]=e,e}}}var rm=0;function om(s,t){return(t.castShadow?2:0)-(s.castShadow?2:0)+(t.map?1:0)-(s.map?1:0)}function am(s,t){let e=new im,n=sm(),i={version:0,hash:{directionalLength:-1,pointLength:-1,spotLength:-1,rectAreaLength:-1,hemiLength:-1,numDirectionalShadows:-1,numPointShadows:-1,numSpotShadows:-1,numSpotMaps:-1,numLightProbes:-1},ambient:[0,0,0],probe:[],directional:[],directionalShadow:[],directionalShadowMap:[],directionalShadowMatrix:[],spot:[],spotLightMap:[],spotShadow:[],spotShadowMap:[],spotLightMatrix:[],rectArea:[],rectAreaLTC1:null,rectAreaLTC2:null,point:[],pointShadow:[],pointShadowMap:[],pointShadowMatrix:[],hemi:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};for(let h=0;h<9;h++)i.probe.push(new L);let r=new L,o=new Zt,a=new Zt;function c(h,u){let d=0,m=0,v=0;for(let B=0;B<9;B++)i.probe[B].set(0,0,0);let x=0,p=0,f=0,g=0,_=0,b=0,S=0,T=0,C=0,P=0,y=0;h.sort(om);let w=u===!0?Math.PI:1;for(let B=0,W=h.length;B<W;B++){let R=h[B],D=R.color,H=R.intensity,k=R.distance,N=R.shadow&&R.shadow.map?R.shadow.map.texture:null;if(R.isAmbientLight)d+=D.r*H*w,m+=D.g*H*w,v+=D.b*H*w;else if(R.isLightProbe){for(let V=0;V<9;V++)i.probe[V].addScaledVector(R.sh.coefficients[V],H);y++}else if(R.isDirectionalLight){let V=e.get(R);if(V.color.copy(R.color).multiplyScalar(R.intensity*w),R.castShadow){let K=R.shadow,$=n.get(R);$.shadowBias=K.bias,$.shadowNormalBias=K.normalBias,$.shadowRadius=K.radius,$.shadowMapSize=K.mapSize,i.directionalShadow[x]=$,i.directionalShadowMap[x]=N,i.directionalShadowMatrix[x]=R.shadow.matrix,b++}i.directional[x]=V,x++}else if(R.isSpotLight){let V=e.get(R);V.position.setFromMatrixPosition(R.matrixWorld),V.color.copy(D).multiplyScalar(H*w),V.distance=k,V.coneCos=Math.cos(R.angle),V.penumbraCos=Math.cos(R.angle*(1-R.penumbra)),V.decay=R.decay,i.spot[f]=V;let K=R.shadow;if(R.map&&(i.spotLightMap[C]=R.map,C++,K.updateMatrices(R),R.castShadow&&P++),i.spotLightMatrix[f]=K.matrix,R.castShadow){let $=n.get(R);$.shadowBias=K.bias,$.shadowNormalBias=K.normalBias,$.shadowRadius=K.radius,$.shadowMapSize=K.mapSize,i.spotShadow[f]=$,i.spotShadowMap[f]=N,T++}f++}else if(R.isRectAreaLight){let V=e.get(R);V.color.copy(D).multiplyScalar(H),V.halfWidth.set(R.width*.5,0,0),V.halfHeight.set(0,R.height*.5,0),i.rectArea[g]=V,g++}else if(R.isPointLight){let V=e.get(R);if(V.color.copy(R.color).multiplyScalar(R.intensity*w),V.distance=R.distance,V.decay=R.decay,R.castShadow){let K=R.shadow,$=n.get(R);$.shadowBias=K.bias,$.shadowNormalBias=K.normalBias,$.shadowRadius=K.radius,$.shadowMapSize=K.mapSize,$.shadowCameraNear=K.camera.near,$.shadowCameraFar=K.camera.far,i.pointShadow[p]=$,i.pointShadowMap[p]=N,i.pointShadowMatrix[p]=R.shadow.matrix,S++}i.point[p]=V,p++}else if(R.isHemisphereLight){let V=e.get(R);V.skyColor.copy(R.color).multiplyScalar(H*w),V.groundColor.copy(R.groundColor).multiplyScalar(H*w),i.hemi[_]=V,_++}}g>0&&(t.isWebGL2?s.has("OES_texture_float_linear")===!0?(i.rectAreaLTC1=dt.LTC_FLOAT_1,i.rectAreaLTC2=dt.LTC_FLOAT_2):(i.rectAreaLTC1=dt.LTC_HALF_1,i.rectAreaLTC2=dt.LTC_HALF_2):s.has("OES_texture_float_linear")===!0?(i.rectAreaLTC1=dt.LTC_FLOAT_1,i.rectAreaLTC2=dt.LTC_FLOAT_2):s.has("OES_texture_half_float_linear")===!0?(i.rectAreaLTC1=dt.LTC_HALF_1,i.rectAreaLTC2=dt.LTC_HALF_2):console.error("THREE.WebGLRenderer: Unable to use RectAreaLight. Missing WebGL extensions.")),i.ambient[0]=d,i.ambient[1]=m,i.ambient[2]=v;let F=i.hash;(F.directionalLength!==x||F.pointLength!==p||F.spotLength!==f||F.rectAreaLength!==g||F.hemiLength!==_||F.numDirectionalShadows!==b||F.numPointShadows!==S||F.numSpotShadows!==T||F.numSpotMaps!==C||F.numLightProbes!==y)&&(i.directional.length=x,i.spot.length=f,i.rectArea.length=g,i.point.length=p,i.hemi.length=_,i.directionalShadow.length=b,i.directionalShadowMap.length=b,i.pointShadow.length=S,i.pointShadowMap.length=S,i.spotShadow.length=T,i.spotShadowMap.length=T,i.directionalShadowMatrix.length=b,i.pointShadowMatrix.length=S,i.spotLightMatrix.length=T+C-P,i.spotLightMap.length=C,i.numSpotLightShadowsWithMaps=P,i.numLightProbes=y,F.directionalLength=x,F.pointLength=p,F.spotLength=f,F.rectAreaLength=g,F.hemiLength=_,F.numDirectionalShadows=b,F.numPointShadows=S,F.numSpotShadows=T,F.numSpotMaps=C,F.numLightProbes=y,i.version=rm++)}function l(h,u){let d=0,m=0,v=0,x=0,p=0,f=u.matrixWorldInverse;for(let g=0,_=h.length;g<_;g++){let b=h[g];if(b.isDirectionalLight){let S=i.directional[d];S.direction.setFromMatrixPosition(b.matrixWorld),r.setFromMatrixPosition(b.target.matrixWorld),S.direction.sub(r),S.direction.transformDirection(f),d++}else if(b.isSpotLight){let S=i.spot[v];S.position.setFromMatrixPosition(b.matrixWorld),S.position.applyMatrix4(f),S.direction.setFromMatrixPosition(b.matrixWorld),r.setFromMatrixPosition(b.target.matrixWorld),S.direction.sub(r),S.direction.transformDirection(f),v++}else if(b.isRectAreaLight){let S=i.rectArea[x];S.position.setFromMatrixPosition(b.matrixWorld),S.position.applyMatrix4(f),a.identity(),o.copy(b.matrixWorld),o.premultiply(f),a.extractRotation(o),S.halfWidth.set(b.width*.5,0,0),S.halfHeight.set(0,b.height*.5,0),S.halfWidth.applyMatrix4(a),S.halfHeight.applyMatrix4(a),x++}else if(b.isPointLight){let S=i.point[m];S.position.setFromMatrixPosition(b.matrixWorld),S.position.applyMatrix4(f),m++}else if(b.isHemisphereLight){let S=i.hemi[p];S.direction.setFromMatrixPosition(b.matrixWorld),S.direction.transformDirection(f),p++}}}return{setup:c,setupView:l,state:i}}function Sc(s,t){let e=new am(s,t),n=[],i=[];function r(){n.length=0,i.length=0}function o(u){n.push(u)}function a(u){i.push(u)}function c(u){e.setup(n,u)}function l(u){e.setupView(n,u)}return{init:r,state:{lightsArray:n,shadowsArray:i,lights:e},setupLights:c,setupLightsView:l,pushLight:o,pushShadow:a}}function cm(s,t){let e=new WeakMap;function n(r,o=0){let a=e.get(r),c;return a===void 0?(c=new Sc(s,t),e.set(r,[c])):o>=a.length?(c=new Sc(s,t),a.push(c)):c=a[o],c}function i(){e=new WeakMap}return{get:n,dispose:i}}var yo=class extends an{constructor(t){super(),this.isMeshDepthMaterial=!0,this.type="MeshDepthMaterial",this.depthPacking=fh,this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.wireframe=!1,this.wireframeLinewidth=1,this.setValues(t)}copy(t){return super.copy(t),this.depthPacking=t.depthPacking,this.map=t.map,this.alphaMap=t.alphaMap,this.displacementMap=t.displacementMap,this.displacementScale=t.displacementScale,this.displacementBias=t.displacementBias,this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this}},Mo=class extends an{constructor(t){super(),this.isMeshDistanceMaterial=!0,this.type="MeshDistanceMaterial",this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.setValues(t)}copy(t){return super.copy(t),this.map=t.map,this.alphaMap=t.alphaMap,this.displacementMap=t.displacementMap,this.displacementScale=t.displacementScale,this.displacementBias=t.displacementBias,this}},lm=`void main() {
	gl_Position = vec4( position, 1.0 );
}`,hm=`uniform sampler2D shadow_pass;
uniform vec2 resolution;
uniform float radius;
#include <packing>
void main() {
	const float samples = float( VSM_SAMPLES );
	float mean = 0.0;
	float squared_mean = 0.0;
	float uvStride = samples <= 1.0 ? 0.0 : 2.0 / ( samples - 1.0 );
	float uvStart = samples <= 1.0 ? 0.0 : - 1.0;
	for ( float i = 0.0; i < samples; i ++ ) {
		float uvOffset = uvStart + i * uvStride;
		#ifdef HORIZONTAL_PASS
			vec2 distribution = unpackRGBATo2Half( texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( uvOffset, 0.0 ) * radius ) / resolution ) );
			mean += distribution.x;
			squared_mean += distribution.y * distribution.y + distribution.x * distribution.x;
		#else
			float depth = unpackRGBAToDepth( texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( 0.0, uvOffset ) * radius ) / resolution ) );
			mean += depth;
			squared_mean += depth * depth;
		#endif
	}
	mean = mean / samples;
	squared_mean = squared_mean / samples;
	float std_dev = sqrt( squared_mean - mean * mean );
	gl_FragColor = pack2HalfToRGBA( vec2( mean, std_dev ) );
}`;function um(s,t,e){let n=new Mi,i=new Lt,r=new Lt,o=new de,a=new yo({depthPacking:ph}),c=new Mo,l={},h=e.maxTextureSize,u={[yn]:Ee,[Ee]:yn,[Qe]:Qe},d=new Fe({defines:{VSM_SAMPLES:8},uniforms:{shadow_pass:{value:null},resolution:{value:new Lt},radius:{value:4}},vertexShader:lm,fragmentShader:hm}),m=d.clone();m.defines.HORIZONTAL_PASS=1;let v=new pe;v.setAttribute("position",new ee(new Float32Array([-1,-1,.5,3,-1,.5,-1,3,.5]),3));let x=new Ue(v,d),p=this;this.enabled=!1,this.autoUpdate=!0,this.needsUpdate=!1,this.type=Fc;let f=this.type;this.render=function(T,C,P){if(p.enabled===!1||p.autoUpdate===!1&&p.needsUpdate===!1||T.length===0)return;let y=s.getRenderTarget(),w=s.getActiveCubeFace(),F=s.getActiveMipmapLevel(),B=s.state;B.setBlending(gn),B.buffers.color.setClear(1,1,1,1),B.buffers.depth.setTest(!0),B.setScissorTest(!1);let W=f!==$e&&this.type===$e,R=f===$e&&this.type!==$e;for(let D=0,H=T.length;D<H;D++){let k=T[D],N=k.shadow;if(N===void 0){console.warn("THREE.WebGLShadowMap:",k,"has no shadow.");continue}if(N.autoUpdate===!1&&N.needsUpdate===!1)continue;i.copy(N.mapSize);let V=N.getFrameExtents();if(i.multiply(V),r.copy(N.mapSize),(i.x>h||i.y>h)&&(i.x>h&&(r.x=Math.floor(h/V.x),i.x=r.x*V.x,N.mapSize.x=r.x),i.y>h&&(r.y=Math.floor(h/V.y),i.y=r.y*V.y,N.mapSize.y=r.y)),N.map===null||W===!0||R===!0){let $=this.type!==$e?{minFilter:be,magFilter:be}:{};N.map!==null&&N.map.dispose(),N.map=new sn(i.x,i.y,$),N.map.texture.name=k.name+".shadowMap",N.camera.updateProjectionMatrix()}s.setRenderTarget(N.map),s.clear();let K=N.getViewportCount();for(let $=0;$<K;$++){let ct=N.getViewport($);o.set(r.x*ct.x,r.y*ct.y,r.x*ct.z,r.y*ct.w),B.viewport(o),N.updateMatrices(k,$),n=N.getFrustum(),b(C,P,N.camera,k,this.type)}N.isPointLightShadow!==!0&&this.type===$e&&g(N,P),N.needsUpdate=!1}f=this.type,p.needsUpdate=!1,s.setRenderTarget(y,w,F)};function g(T,C){let P=t.update(x);d.defines.VSM_SAMPLES!==T.blurSamples&&(d.defines.VSM_SAMPLES=T.blurSamples,m.defines.VSM_SAMPLES=T.blurSamples,d.needsUpdate=!0,m.needsUpdate=!0),T.mapPass===null&&(T.mapPass=new sn(i.x,i.y)),d.uniforms.shadow_pass.value=T.map.texture,d.uniforms.resolution.value=T.mapSize,d.uniforms.radius.value=T.radius,s.setRenderTarget(T.mapPass),s.clear(),s.renderBufferDirect(C,null,P,d,x,null),m.uniforms.shadow_pass.value=T.mapPass.texture,m.uniforms.resolution.value=T.mapSize,m.uniforms.radius.value=T.radius,s.setRenderTarget(T.map),s.clear(),s.renderBufferDirect(C,null,P,m,x,null)}function _(T,C,P,y){let w=null,F=P.isPointLight===!0?T.customDistanceMaterial:T.customDepthMaterial;if(F!==void 0)w=F;else if(w=P.isPointLight===!0?c:a,s.localClippingEnabled&&C.clipShadows===!0&&Array.isArray(C.clippingPlanes)&&C.clippingPlanes.length!==0||C.displacementMap&&C.displacementScale!==0||C.alphaMap&&C.alphaTest>0||C.map&&C.alphaTest>0){let B=w.uuid,W=C.uuid,R=l[B];R===void 0&&(R={},l[B]=R);let D=R[W];D===void 0&&(D=w.clone(),R[W]=D,C.addEventListener("dispose",S)),w=D}if(w.visible=C.visible,w.wireframe=C.wireframe,y===$e?w.side=C.shadowSide!==null?C.shadowSide:C.side:w.side=C.shadowSide!==null?C.shadowSide:u[C.side],w.alphaMap=C.alphaMap,w.alphaTest=C.alphaTest,w.map=C.map,w.clipShadows=C.clipShadows,w.clippingPlanes=C.clippingPlanes,w.clipIntersection=C.clipIntersection,w.displacementMap=C.displacementMap,w.displacementScale=C.displacementScale,w.displacementBias=C.displacementBias,w.wireframeLinewidth=C.wireframeLinewidth,w.linewidth=C.linewidth,P.isPointLight===!0&&w.isMeshDistanceMaterial===!0){let B=s.properties.get(w);B.light=P}return w}function b(T,C,P,y,w){if(T.visible===!1)return;if(T.layers.test(C.layers)&&(T.isMesh||T.isLine||T.isPoints)&&(T.castShadow||T.receiveShadow&&w===$e)&&(!T.frustumCulled||n.intersectsObject(T))){T.modelViewMatrix.multiplyMatrices(P.matrixWorldInverse,T.matrixWorld);let W=t.update(T),R=T.material;if(Array.isArray(R)){let D=W.groups;for(let H=0,k=D.length;H<k;H++){let N=D[H],V=R[N.materialIndex];if(V&&V.visible){let K=_(T,V,y,w);T.onBeforeShadow(s,T,C,P,W,K,N),s.renderBufferDirect(P,null,W,K,T,N),T.onAfterShadow(s,T,C,P,W,K,N)}}}else if(R.visible){let D=_(T,R,y,w);T.onBeforeShadow(s,T,C,P,W,D,null),s.renderBufferDirect(P,null,W,D,T,null),T.onAfterShadow(s,T,C,P,W,D,null)}}let B=T.children;for(let W=0,R=B.length;W<R;W++)b(B[W],C,P,y,w)}function S(T){T.target.removeEventListener("dispose",S);for(let P in l){let y=l[P],w=T.target.uuid;w in y&&(y[w].dispose(),delete y[w])}}}function dm(s,t,e){let n=e.isWebGL2;function i(){let I=!1,mt=new de,gt=null,It=new de(0,0,0,0);return{setMask:function(Rt){gt!==Rt&&!I&&(s.colorMask(Rt,Rt,Rt,Rt),gt=Rt)},setLocked:function(Rt){I=Rt},setClear:function(Rt,Jt,Kt,le,ve){ve===!0&&(Rt*=le,Jt*=le,Kt*=le),mt.set(Rt,Jt,Kt,le),It.equals(mt)===!1&&(s.clearColor(Rt,Jt,Kt,le),It.copy(mt))},reset:function(){I=!1,gt=null,It.set(-1,0,0,0)}}}function r(){let I=!1,mt=null,gt=null,It=null;return{setTest:function(Rt){Rt?Y(s.DEPTH_TEST):lt(s.DEPTH_TEST)},setMask:function(Rt){mt!==Rt&&!I&&(s.depthMask(Rt),mt=Rt)},setFunc:function(Rt){if(gt!==Rt){switch(Rt){case Gl:s.depthFunc(s.NEVER);break;case Wl:s.depthFunc(s.ALWAYS);break;case Xl:s.depthFunc(s.LESS);break;case Us:s.depthFunc(s.LEQUAL);break;case ql:s.depthFunc(s.EQUAL);break;case Yl:s.depthFunc(s.GEQUAL);break;case Zl:s.depthFunc(s.GREATER);break;case Jl:s.depthFunc(s.NOTEQUAL);break;default:s.depthFunc(s.LEQUAL)}gt=Rt}},setLocked:function(Rt){I=Rt},setClear:function(Rt){It!==Rt&&(s.clearDepth(Rt),It=Rt)},reset:function(){I=!1,mt=null,gt=null,It=null}}}function o(){let I=!1,mt=null,gt=null,It=null,Rt=null,Jt=null,Kt=null,le=null,ve=null;return{setTest:function($t){I||($t?Y(s.STENCIL_TEST):lt(s.STENCIL_TEST))},setMask:function($t){mt!==$t&&!I&&(s.stencilMask($t),mt=$t)},setFunc:function($t,xe,Ge){(gt!==$t||It!==xe||Rt!==Ge)&&(s.stencilFunc($t,xe,Ge),gt=$t,It=xe,Rt=Ge)},setOp:function($t,xe,Ge){(Jt!==$t||Kt!==xe||le!==Ge)&&(s.stencilOp($t,xe,Ge),Jt=$t,Kt=xe,le=Ge)},setLocked:function($t){I=$t},setClear:function($t){ve!==$t&&(s.clearStencil($t),ve=$t)},reset:function(){I=!1,mt=null,gt=null,It=null,Rt=null,Jt=null,Kt=null,le=null,ve=null}}}let a=new i,c=new r,l=new o,h=new WeakMap,u=new WeakMap,d={},m={},v=new WeakMap,x=[],p=null,f=!1,g=null,_=null,b=null,S=null,T=null,C=null,P=null,y=new zt(0,0,0),w=0,F=!1,B=null,W=null,R=null,D=null,H=null,k=s.getParameter(s.MAX_COMBINED_TEXTURE_IMAGE_UNITS),N=!1,V=0,K=s.getParameter(s.VERSION);K.indexOf("WebGL")!==-1?(V=parseFloat(/^WebGL (\d)/.exec(K)[1]),N=V>=1):K.indexOf("OpenGL ES")!==-1&&(V=parseFloat(/^OpenGL ES (\d)/.exec(K)[1]),N=V>=2);let $=null,ct={},G=s.getParameter(s.SCISSOR_BOX),J=s.getParameter(s.VIEWPORT),ot=new de().fromArray(G),nt=new de().fromArray(J);function ht(I,mt,gt,It){let Rt=new Uint8Array(4),Jt=s.createTexture();s.bindTexture(I,Jt),s.texParameteri(I,s.TEXTURE_MIN_FILTER,s.NEAREST),s.texParameteri(I,s.TEXTURE_MAG_FILTER,s.NEAREST);for(let Kt=0;Kt<gt;Kt++)n&&(I===s.TEXTURE_3D||I===s.TEXTURE_2D_ARRAY)?s.texImage3D(mt,0,s.RGBA,1,1,It,0,s.RGBA,s.UNSIGNED_BYTE,Rt):s.texImage2D(mt+Kt,0,s.RGBA,1,1,0,s.RGBA,s.UNSIGNED_BYTE,Rt);return Jt}let xt={};xt[s.TEXTURE_2D]=ht(s.TEXTURE_2D,s.TEXTURE_2D,1),xt[s.TEXTURE_CUBE_MAP]=ht(s.TEXTURE_CUBE_MAP,s.TEXTURE_CUBE_MAP_POSITIVE_X,6),n&&(xt[s.TEXTURE_2D_ARRAY]=ht(s.TEXTURE_2D_ARRAY,s.TEXTURE_2D_ARRAY,1,1),xt[s.TEXTURE_3D]=ht(s.TEXTURE_3D,s.TEXTURE_3D,1,1)),a.setClear(0,0,0,1),c.setClear(1),l.setClear(0),Y(s.DEPTH_TEST),c.setFunc(Us),Mt(!1),E(sa),Y(s.CULL_FACE),it(gn);function Y(I){d[I]!==!0&&(s.enable(I),d[I]=!0)}function lt(I){d[I]!==!1&&(s.disable(I),d[I]=!1)}function pt(I,mt){return m[I]!==mt?(s.bindFramebuffer(I,mt),m[I]=mt,n&&(I===s.DRAW_FRAMEBUFFER&&(m[s.FRAMEBUFFER]=mt),I===s.FRAMEBUFFER&&(m[s.DRAW_FRAMEBUFFER]=mt)),!0):!1}function U(I,mt){let gt=x,It=!1;if(I)if(gt=v.get(mt),gt===void 0&&(gt=[],v.set(mt,gt)),I.isWebGLMultipleRenderTargets){let Rt=I.texture;if(gt.length!==Rt.length||gt[0]!==s.COLOR_ATTACHMENT0){for(let Jt=0,Kt=Rt.length;Jt<Kt;Jt++)gt[Jt]=s.COLOR_ATTACHMENT0+Jt;gt.length=Rt.length,It=!0}}else gt[0]!==s.COLOR_ATTACHMENT0&&(gt[0]=s.COLOR_ATTACHMENT0,It=!0);else gt[0]!==s.BACK&&(gt[0]=s.BACK,It=!0);It&&(e.isWebGL2?s.drawBuffers(gt):t.get("WEBGL_draw_buffers").drawBuffersWEBGL(gt))}function bt(I){return p!==I?(s.useProgram(I),p=I,!0):!1}let et={[In]:s.FUNC_ADD,[Cl]:s.FUNC_SUBTRACT,[Rl]:s.FUNC_REVERSE_SUBTRACT};if(n)et[aa]=s.MIN,et[ca]=s.MAX;else{let I=t.get("EXT_blend_minmax");I!==null&&(et[aa]=I.MIN_EXT,et[ca]=I.MAX_EXT)}let at={[Pl]:s.ZERO,[Ll]:s.ONE,[Il]:s.SRC_COLOR,[jr]:s.SRC_ALPHA,[Bl]:s.SRC_ALPHA_SATURATE,[Fl]:s.DST_COLOR,[Ul]:s.DST_ALPHA,[Dl]:s.ONE_MINUS_SRC_COLOR,[Qr]:s.ONE_MINUS_SRC_ALPHA,[Ol]:s.ONE_MINUS_DST_COLOR,[Nl]:s.ONE_MINUS_DST_ALPHA,[zl]:s.CONSTANT_COLOR,[kl]:s.ONE_MINUS_CONSTANT_COLOR,[Vl]:s.CONSTANT_ALPHA,[Hl]:s.ONE_MINUS_CONSTANT_ALPHA};function it(I,mt,gt,It,Rt,Jt,Kt,le,ve,$t){if(I===gn){f===!0&&(lt(s.BLEND),f=!1);return}if(f===!1&&(Y(s.BLEND),f=!0),I!==Tl){if(I!==g||$t!==F){if((_!==In||T!==In)&&(s.blendEquation(s.FUNC_ADD),_=In,T=In),$t)switch(I){case di:s.blendFuncSeparate(s.ONE,s.ONE_MINUS_SRC_ALPHA,s.ONE,s.ONE_MINUS_SRC_ALPHA);break;case Bn:s.blendFunc(s.ONE,s.ONE);break;case ra:s.blendFuncSeparate(s.ZERO,s.ONE_MINUS_SRC_COLOR,s.ZERO,s.ONE);break;case oa:s.blendFuncSeparate(s.ZERO,s.SRC_COLOR,s.ZERO,s.SRC_ALPHA);break;default:console.error("THREE.WebGLState: Invalid blending: ",I);break}else switch(I){case di:s.blendFuncSeparate(s.SRC_ALPHA,s.ONE_MINUS_SRC_ALPHA,s.ONE,s.ONE_MINUS_SRC_ALPHA);break;case Bn:s.blendFunc(s.SRC_ALPHA,s.ONE);break;case ra:s.blendFuncSeparate(s.ZERO,s.ONE_MINUS_SRC_COLOR,s.ZERO,s.ONE);break;case oa:s.blendFunc(s.ZERO,s.SRC_COLOR);break;default:console.error("THREE.WebGLState: Invalid blending: ",I);break}b=null,S=null,C=null,P=null,y.set(0,0,0),w=0,g=I,F=$t}return}Rt=Rt||mt,Jt=Jt||gt,Kt=Kt||It,(mt!==_||Rt!==T)&&(s.blendEquationSeparate(et[mt],et[Rt]),_=mt,T=Rt),(gt!==b||It!==S||Jt!==C||Kt!==P)&&(s.blendFuncSeparate(at[gt],at[It],at[Jt],at[Kt]),b=gt,S=It,C=Jt,P=Kt),(le.equals(y)===!1||ve!==w)&&(s.blendColor(le.r,le.g,le.b,ve),y.copy(le),w=ve),g=I,F=!1}function wt(I,mt){I.side===Qe?lt(s.CULL_FACE):Y(s.CULL_FACE);let gt=I.side===Ee;mt&&(gt=!gt),Mt(gt),I.blending===di&&I.transparent===!1?it(gn):it(I.blending,I.blendEquation,I.blendSrc,I.blendDst,I.blendEquationAlpha,I.blendSrcAlpha,I.blendDstAlpha,I.blendColor,I.blendAlpha,I.premultipliedAlpha),c.setFunc(I.depthFunc),c.setTest(I.depthTest),c.setMask(I.depthWrite),a.setMask(I.colorWrite);let It=I.stencilWrite;l.setTest(It),It&&(l.setMask(I.stencilWriteMask),l.setFunc(I.stencilFunc,I.stencilRef,I.stencilFuncMask),l.setOp(I.stencilFail,I.stencilZFail,I.stencilZPass)),O(I.polygonOffset,I.polygonOffsetFactor,I.polygonOffsetUnits),I.alphaToCoverage===!0?Y(s.SAMPLE_ALPHA_TO_COVERAGE):lt(s.SAMPLE_ALPHA_TO_COVERAGE)}function Mt(I){B!==I&&(I?s.frontFace(s.CW):s.frontFace(s.CCW),B=I)}function E(I){I!==wl?(Y(s.CULL_FACE),I!==W&&(I===sa?s.cullFace(s.BACK):I===El?s.cullFace(s.FRONT):s.cullFace(s.FRONT_AND_BACK))):lt(s.CULL_FACE),W=I}function M(I){I!==R&&(N&&s.lineWidth(I),R=I)}function O(I,mt,gt){I?(Y(s.POLYGON_OFFSET_FILL),(D!==mt||H!==gt)&&(s.polygonOffset(mt,gt),D=mt,H=gt)):lt(s.POLYGON_OFFSET_FILL)}function tt(I){I?Y(s.SCISSOR_TEST):lt(s.SCISSOR_TEST)}function j(I){I===void 0&&(I=s.TEXTURE0+k-1),$!==I&&(s.activeTexture(I),$=I)}function Q(I,mt,gt){gt===void 0&&($===null?gt=s.TEXTURE0+k-1:gt=$);let It=ct[gt];It===void 0&&(It={type:void 0,texture:void 0},ct[gt]=It),(It.type!==I||It.texture!==mt)&&($!==gt&&(s.activeTexture(gt),$=gt),s.bindTexture(I,mt||xt[I]),It.type=I,It.texture=mt)}function _t(){let I=ct[$];I!==void 0&&I.type!==void 0&&(s.bindTexture(I.type,null),I.type=void 0,I.texture=void 0)}function ft(){try{s.compressedTexImage2D.apply(s,arguments)}catch(I){console.error("THREE.WebGLState:",I)}}function yt(){try{s.compressedTexImage3D.apply(s,arguments)}catch(I){console.error("THREE.WebGLState:",I)}}function At(){try{s.texSubImage2D.apply(s,arguments)}catch(I){console.error("THREE.WebGLState:",I)}}function Ut(){try{s.texSubImage3D.apply(s,arguments)}catch(I){console.error("THREE.WebGLState:",I)}}function st(){try{s.compressedTexSubImage2D.apply(s,arguments)}catch(I){console.error("THREE.WebGLState:",I)}}function Xt(){try{s.compressedTexSubImage3D.apply(s,arguments)}catch(I){console.error("THREE.WebGLState:",I)}}function Ft(){try{s.texStorage2D.apply(s,arguments)}catch(I){console.error("THREE.WebGLState:",I)}}function Ct(){try{s.texStorage3D.apply(s,arguments)}catch(I){console.error("THREE.WebGLState:",I)}}function Tt(){try{s.texImage2D.apply(s,arguments)}catch(I){console.error("THREE.WebGLState:",I)}}function rt(){try{s.texImage3D.apply(s,arguments)}catch(I){console.error("THREE.WebGLState:",I)}}function St(I){ot.equals(I)===!1&&(s.scissor(I.x,I.y,I.z,I.w),ot.copy(I))}function Wt(I){nt.equals(I)===!1&&(s.viewport(I.x,I.y,I.z,I.w),nt.copy(I))}function jt(I,mt){let gt=u.get(mt);gt===void 0&&(gt=new WeakMap,u.set(mt,gt));let It=gt.get(I);It===void 0&&(It=s.getUniformBlockIndex(mt,I.name),gt.set(I,It))}function Ot(I,mt){let It=u.get(mt).get(I);h.get(mt)!==It&&(s.uniformBlockBinding(mt,It,I.__bindingPointIndex),h.set(mt,It))}function ut(){s.disable(s.BLEND),s.disable(s.CULL_FACE),s.disable(s.DEPTH_TEST),s.disable(s.POLYGON_OFFSET_FILL),s.disable(s.SCISSOR_TEST),s.disable(s.STENCIL_TEST),s.disable(s.SAMPLE_ALPHA_TO_COVERAGE),s.blendEquation(s.FUNC_ADD),s.blendFunc(s.ONE,s.ZERO),s.blendFuncSeparate(s.ONE,s.ZERO,s.ONE,s.ZERO),s.blendColor(0,0,0,0),s.colorMask(!0,!0,!0,!0),s.clearColor(0,0,0,0),s.depthMask(!0),s.depthFunc(s.LESS),s.clearDepth(1),s.stencilMask(4294967295),s.stencilFunc(s.ALWAYS,0,4294967295),s.stencilOp(s.KEEP,s.KEEP,s.KEEP),s.clearStencil(0),s.cullFace(s.BACK),s.frontFace(s.CCW),s.polygonOffset(0,0),s.activeTexture(s.TEXTURE0),s.bindFramebuffer(s.FRAMEBUFFER,null),n===!0&&(s.bindFramebuffer(s.DRAW_FRAMEBUFFER,null),s.bindFramebuffer(s.READ_FRAMEBUFFER,null)),s.useProgram(null),s.lineWidth(1),s.scissor(0,0,s.canvas.width,s.canvas.height),s.viewport(0,0,s.canvas.width,s.canvas.height),d={},$=null,ct={},m={},v=new WeakMap,x=[],p=null,f=!1,g=null,_=null,b=null,S=null,T=null,C=null,P=null,y=new zt(0,0,0),w=0,F=!1,B=null,W=null,R=null,D=null,H=null,ot.set(0,0,s.canvas.width,s.canvas.height),nt.set(0,0,s.canvas.width,s.canvas.height),a.reset(),c.reset(),l.reset()}return{buffers:{color:a,depth:c,stencil:l},enable:Y,disable:lt,bindFramebuffer:pt,drawBuffers:U,useProgram:bt,setBlending:it,setMaterial:wt,setFlipSided:Mt,setCullFace:E,setLineWidth:M,setPolygonOffset:O,setScissorTest:tt,activeTexture:j,bindTexture:Q,unbindTexture:_t,compressedTexImage2D:ft,compressedTexImage3D:yt,texImage2D:Tt,texImage3D:rt,updateUBOMapping:jt,uniformBlockBinding:Ot,texStorage2D:Ft,texStorage3D:Ct,texSubImage2D:At,texSubImage3D:Ut,compressedTexSubImage2D:st,compressedTexSubImage3D:Xt,scissor:St,viewport:Wt,reset:ut}}function fm(s,t,e,n,i,r,o){let a=i.isWebGL2,c=t.has("WEBGL_multisampled_render_to_texture")?t.get("WEBGL_multisampled_render_to_texture"):null,l=typeof navigator>"u"?!1:/OculusBrowser/g.test(navigator.userAgent),h=new WeakMap,u,d=new WeakMap,m=!1;try{m=typeof OffscreenCanvas<"u"&&new OffscreenCanvas(1,1).getContext("2d")!==null}catch{}function v(E,M){return m?new OffscreenCanvas(E,M):Vs("canvas")}function x(E,M,O,tt){let j=1;if((E.width>tt||E.height>tt)&&(j=tt/Math.max(E.width,E.height)),j<1||M===!0)if(typeof HTMLImageElement<"u"&&E instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&E instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&E instanceof ImageBitmap){let Q=M?ao:Math.floor,_t=Q(j*E.width),ft=Q(j*E.height);u===void 0&&(u=v(_t,ft));let yt=O?v(_t,ft):u;return yt.width=_t,yt.height=ft,yt.getContext("2d").drawImage(E,0,0,_t,ft),console.warn("THREE.WebGLRenderer: Texture has been resized from ("+E.width+"x"+E.height+") to ("+_t+"x"+ft+")."),yt}else return"data"in E&&console.warn("THREE.WebGLRenderer: Image in DataTexture is too big ("+E.width+"x"+E.height+")."),E;return E}function p(E){return ka(E.width)&&ka(E.height)}function f(E){return a?!1:E.wrapS!==ke||E.wrapT!==ke||E.minFilter!==be&&E.minFilter!==Ie}function g(E,M){return E.generateMipmaps&&M&&E.minFilter!==be&&E.minFilter!==Ie}function _(E){s.generateMipmap(E)}function b(E,M,O,tt,j=!1){if(a===!1)return M;if(E!==null){if(s[E]!==void 0)return s[E];console.warn("THREE.WebGLRenderer: Attempt to use non-existing WebGL internal format '"+E+"'")}let Q=M;if(M===s.RED&&(O===s.FLOAT&&(Q=s.R32F),O===s.HALF_FLOAT&&(Q=s.R16F),O===s.UNSIGNED_BYTE&&(Q=s.R8)),M===s.RED_INTEGER&&(O===s.UNSIGNED_BYTE&&(Q=s.R8UI),O===s.UNSIGNED_SHORT&&(Q=s.R16UI),O===s.UNSIGNED_INT&&(Q=s.R32UI),O===s.BYTE&&(Q=s.R8I),O===s.SHORT&&(Q=s.R16I),O===s.INT&&(Q=s.R32I)),M===s.RG&&(O===s.FLOAT&&(Q=s.RG32F),O===s.HALF_FLOAT&&(Q=s.RG16F),O===s.UNSIGNED_BYTE&&(Q=s.RG8)),M===s.RGBA){let _t=j?Os:qt.getTransfer(tt);O===s.FLOAT&&(Q=s.RGBA32F),O===s.HALF_FLOAT&&(Q=s.RGBA16F),O===s.UNSIGNED_BYTE&&(Q=_t===Qt?s.SRGB8_ALPHA8:s.RGBA8),O===s.UNSIGNED_SHORT_4_4_4_4&&(Q=s.RGBA4),O===s.UNSIGNED_SHORT_5_5_5_1&&(Q=s.RGB5_A1)}return(Q===s.R16F||Q===s.R32F||Q===s.RG16F||Q===s.RG32F||Q===s.RGBA16F||Q===s.RGBA32F)&&t.get("EXT_color_buffer_float"),Q}function S(E,M,O){return g(E,O)===!0||E.isFramebufferTexture&&E.minFilter!==be&&E.minFilter!==Ie?Math.log2(Math.max(M.width,M.height))+1:E.mipmaps!==void 0&&E.mipmaps.length>0?E.mipmaps.length:E.isCompressedTexture&&Array.isArray(E.image)?M.mipmaps.length:1}function T(E){return E===be||E===la||E===xr?s.NEAREST:s.LINEAR}function C(E){let M=E.target;M.removeEventListener("dispose",C),y(M),M.isVideoTexture&&h.delete(M)}function P(E){let M=E.target;M.removeEventListener("dispose",P),F(M)}function y(E){let M=n.get(E);if(M.__webglInit===void 0)return;let O=E.source,tt=d.get(O);if(tt){let j=tt[M.__cacheKey];j.usedTimes--,j.usedTimes===0&&w(E),Object.keys(tt).length===0&&d.delete(O)}n.remove(E)}function w(E){let M=n.get(E);s.deleteTexture(M.__webglTexture);let O=E.source,tt=d.get(O);delete tt[M.__cacheKey],o.memory.textures--}function F(E){let M=E.texture,O=n.get(E),tt=n.get(M);if(tt.__webglTexture!==void 0&&(s.deleteTexture(tt.__webglTexture),o.memory.textures--),E.depthTexture&&E.depthTexture.dispose(),E.isWebGLCubeRenderTarget)for(let j=0;j<6;j++){if(Array.isArray(O.__webglFramebuffer[j]))for(let Q=0;Q<O.__webglFramebuffer[j].length;Q++)s.deleteFramebuffer(O.__webglFramebuffer[j][Q]);else s.deleteFramebuffer(O.__webglFramebuffer[j]);O.__webglDepthbuffer&&s.deleteRenderbuffer(O.__webglDepthbuffer[j])}else{if(Array.isArray(O.__webglFramebuffer))for(let j=0;j<O.__webglFramebuffer.length;j++)s.deleteFramebuffer(O.__webglFramebuffer[j]);else s.deleteFramebuffer(O.__webglFramebuffer);if(O.__webglDepthbuffer&&s.deleteRenderbuffer(O.__webglDepthbuffer),O.__webglMultisampledFramebuffer&&s.deleteFramebuffer(O.__webglMultisampledFramebuffer),O.__webglColorRenderbuffer)for(let j=0;j<O.__webglColorRenderbuffer.length;j++)O.__webglColorRenderbuffer[j]&&s.deleteRenderbuffer(O.__webglColorRenderbuffer[j]);O.__webglDepthRenderbuffer&&s.deleteRenderbuffer(O.__webglDepthRenderbuffer)}if(E.isWebGLMultipleRenderTargets)for(let j=0,Q=M.length;j<Q;j++){let _t=n.get(M[j]);_t.__webglTexture&&(s.deleteTexture(_t.__webglTexture),o.memory.textures--),n.remove(M[j])}n.remove(M),n.remove(E)}let B=0;function W(){B=0}function R(){let E=B;return E>=i.maxTextures&&console.warn("THREE.WebGLTextures: Trying to use "+E+" texture units while this GPU supports only "+i.maxTextures),B+=1,E}function D(E){let M=[];return M.push(E.wrapS),M.push(E.wrapT),M.push(E.wrapR||0),M.push(E.magFilter),M.push(E.minFilter),M.push(E.anisotropy),M.push(E.internalFormat),M.push(E.format),M.push(E.type),M.push(E.generateMipmaps),M.push(E.premultiplyAlpha),M.push(E.flipY),M.push(E.unpackAlignment),M.push(E.colorSpace),M.join()}function H(E,M){let O=n.get(E);if(E.isVideoTexture&&wt(E),E.isRenderTargetTexture===!1&&E.version>0&&O.__version!==E.version){let tt=E.image;if(tt===null)console.warn("THREE.WebGLRenderer: Texture marked for update but no image data found.");else if(tt.complete===!1)console.warn("THREE.WebGLRenderer: Texture marked for update but image is incomplete");else{ot(O,E,M);return}}e.bindTexture(s.TEXTURE_2D,O.__webglTexture,s.TEXTURE0+M)}function k(E,M){let O=n.get(E);if(E.version>0&&O.__version!==E.version){ot(O,E,M);return}e.bindTexture(s.TEXTURE_2D_ARRAY,O.__webglTexture,s.TEXTURE0+M)}function N(E,M){let O=n.get(E);if(E.version>0&&O.__version!==E.version){ot(O,E,M);return}e.bindTexture(s.TEXTURE_3D,O.__webglTexture,s.TEXTURE0+M)}function V(E,M){let O=n.get(E);if(E.version>0&&O.__version!==E.version){nt(O,E,M);return}e.bindTexture(s.TEXTURE_CUBE_MAP,O.__webglTexture,s.TEXTURE0+M)}let K={[no]:s.REPEAT,[ke]:s.CLAMP_TO_EDGE,[io]:s.MIRRORED_REPEAT},$={[be]:s.NEAREST,[la]:s.NEAREST_MIPMAP_NEAREST,[xr]:s.NEAREST_MIPMAP_LINEAR,[Ie]:s.LINEAR,[sh]:s.LINEAR_MIPMAP_NEAREST,[Vi]:s.LINEAR_MIPMAP_LINEAR},ct={[_h]:s.NEVER,[Sh]:s.ALWAYS,[vh]:s.LESS,[Yc]:s.LEQUAL,[xh]:s.EQUAL,[bh]:s.GEQUAL,[yh]:s.GREATER,[Mh]:s.NOTEQUAL};function G(E,M,O){if(O?(s.texParameteri(E,s.TEXTURE_WRAP_S,K[M.wrapS]),s.texParameteri(E,s.TEXTURE_WRAP_T,K[M.wrapT]),(E===s.TEXTURE_3D||E===s.TEXTURE_2D_ARRAY)&&s.texParameteri(E,s.TEXTURE_WRAP_R,K[M.wrapR]),s.texParameteri(E,s.TEXTURE_MAG_FILTER,$[M.magFilter]),s.texParameteri(E,s.TEXTURE_MIN_FILTER,$[M.minFilter])):(s.texParameteri(E,s.TEXTURE_WRAP_S,s.CLAMP_TO_EDGE),s.texParameteri(E,s.TEXTURE_WRAP_T,s.CLAMP_TO_EDGE),(E===s.TEXTURE_3D||E===s.TEXTURE_2D_ARRAY)&&s.texParameteri(E,s.TEXTURE_WRAP_R,s.CLAMP_TO_EDGE),(M.wrapS!==ke||M.wrapT!==ke)&&console.warn("THREE.WebGLRenderer: Texture is not power of two. Texture.wrapS and Texture.wrapT should be set to THREE.ClampToEdgeWrapping."),s.texParameteri(E,s.TEXTURE_MAG_FILTER,T(M.magFilter)),s.texParameteri(E,s.TEXTURE_MIN_FILTER,T(M.minFilter)),M.minFilter!==be&&M.minFilter!==Ie&&console.warn("THREE.WebGLRenderer: Texture is not power of two. Texture.minFilter should be set to THREE.NearestFilter or THREE.LinearFilter.")),M.compareFunction&&(s.texParameteri(E,s.TEXTURE_COMPARE_MODE,s.COMPARE_REF_TO_TEXTURE),s.texParameteri(E,s.TEXTURE_COMPARE_FUNC,ct[M.compareFunction])),t.has("EXT_texture_filter_anisotropic")===!0){let tt=t.get("EXT_texture_filter_anisotropic");if(M.magFilter===be||M.minFilter!==xr&&M.minFilter!==Vi||M.type===mn&&t.has("OES_texture_float_linear")===!1||a===!1&&M.type===Hi&&t.has("OES_texture_half_float_linear")===!1)return;(M.anisotropy>1||n.get(M).__currentAnisotropy)&&(s.texParameterf(E,tt.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(M.anisotropy,i.getMaxAnisotropy())),n.get(M).__currentAnisotropy=M.anisotropy)}}function J(E,M){let O=!1;E.__webglInit===void 0&&(E.__webglInit=!0,M.addEventListener("dispose",C));let tt=M.source,j=d.get(tt);j===void 0&&(j={},d.set(tt,j));let Q=D(M);if(Q!==E.__cacheKey){j[Q]===void 0&&(j[Q]={texture:s.createTexture(),usedTimes:0},o.memory.textures++,O=!0),j[Q].usedTimes++;let _t=j[E.__cacheKey];_t!==void 0&&(j[E.__cacheKey].usedTimes--,_t.usedTimes===0&&w(M)),E.__cacheKey=Q,E.__webglTexture=j[Q].texture}return O}function ot(E,M,O){let tt=s.TEXTURE_2D;(M.isDataArrayTexture||M.isCompressedArrayTexture)&&(tt=s.TEXTURE_2D_ARRAY),M.isData3DTexture&&(tt=s.TEXTURE_3D);let j=J(E,M),Q=M.source;e.bindTexture(tt,E.__webglTexture,s.TEXTURE0+O);let _t=n.get(Q);if(Q.version!==_t.__version||j===!0){e.activeTexture(s.TEXTURE0+O);let ft=qt.getPrimaries(qt.workingColorSpace),yt=M.colorSpace===De?null:qt.getPrimaries(M.colorSpace),At=M.colorSpace===De||ft===yt?s.NONE:s.BROWSER_DEFAULT_WEBGL;s.pixelStorei(s.UNPACK_FLIP_Y_WEBGL,M.flipY),s.pixelStorei(s.UNPACK_PREMULTIPLY_ALPHA_WEBGL,M.premultiplyAlpha),s.pixelStorei(s.UNPACK_ALIGNMENT,M.unpackAlignment),s.pixelStorei(s.UNPACK_COLORSPACE_CONVERSION_WEBGL,At);let Ut=f(M)&&p(M.image)===!1,st=x(M.image,Ut,!1,i.maxTextureSize);st=Mt(M,st);let Xt=p(st)||a,Ft=r.convert(M.format,M.colorSpace),Ct=r.convert(M.type),Tt=b(M.internalFormat,Ft,Ct,M.colorSpace,M.isVideoTexture);G(tt,M,Xt);let rt,St=M.mipmaps,Wt=a&&M.isVideoTexture!==!0&&Tt!==Xc,jt=_t.__version===void 0||j===!0,Ot=S(M,st,Xt);if(M.isDepthTexture)Tt=s.DEPTH_COMPONENT,a?M.type===mn?Tt=s.DEPTH_COMPONENT32F:M.type===pn?Tt=s.DEPTH_COMPONENT24:M.type===Nn?Tt=s.DEPTH24_STENCIL8:Tt=s.DEPTH_COMPONENT16:M.type===mn&&console.error("WebGLRenderer: Floating point depth texture requires WebGL2."),M.format===Fn&&Tt===s.DEPTH_COMPONENT&&M.type!==ko&&M.type!==pn&&(console.warn("THREE.WebGLRenderer: Use UnsignedShortType or UnsignedIntType for DepthFormat DepthTexture."),M.type=pn,Ct=r.convert(M.type)),M.format===_i&&Tt===s.DEPTH_COMPONENT&&(Tt=s.DEPTH_STENCIL,M.type!==Nn&&(console.warn("THREE.WebGLRenderer: Use UnsignedInt248Type for DepthStencilFormat DepthTexture."),M.type=Nn,Ct=r.convert(M.type))),jt&&(Wt?e.texStorage2D(s.TEXTURE_2D,1,Tt,st.width,st.height):e.texImage2D(s.TEXTURE_2D,0,Tt,st.width,st.height,0,Ft,Ct,null));else if(M.isDataTexture)if(St.length>0&&Xt){Wt&&jt&&e.texStorage2D(s.TEXTURE_2D,Ot,Tt,St[0].width,St[0].height);for(let ut=0,I=St.length;ut<I;ut++)rt=St[ut],Wt?e.texSubImage2D(s.TEXTURE_2D,ut,0,0,rt.width,rt.height,Ft,Ct,rt.data):e.texImage2D(s.TEXTURE_2D,ut,Tt,rt.width,rt.height,0,Ft,Ct,rt.data);M.generateMipmaps=!1}else Wt?(jt&&e.texStorage2D(s.TEXTURE_2D,Ot,Tt,st.width,st.height),e.texSubImage2D(s.TEXTURE_2D,0,0,0,st.width,st.height,Ft,Ct,st.data)):e.texImage2D(s.TEXTURE_2D,0,Tt,st.width,st.height,0,Ft,Ct,st.data);else if(M.isCompressedTexture)if(M.isCompressedArrayTexture){Wt&&jt&&e.texStorage3D(s.TEXTURE_2D_ARRAY,Ot,Tt,St[0].width,St[0].height,st.depth);for(let ut=0,I=St.length;ut<I;ut++)rt=St[ut],M.format!==Ve?Ft!==null?Wt?e.compressedTexSubImage3D(s.TEXTURE_2D_ARRAY,ut,0,0,0,rt.width,rt.height,st.depth,Ft,rt.data,0,0):e.compressedTexImage3D(s.TEXTURE_2D_ARRAY,ut,Tt,rt.width,rt.height,st.depth,0,rt.data,0,0):console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()"):Wt?e.texSubImage3D(s.TEXTURE_2D_ARRAY,ut,0,0,0,rt.width,rt.height,st.depth,Ft,Ct,rt.data):e.texImage3D(s.TEXTURE_2D_ARRAY,ut,Tt,rt.width,rt.height,st.depth,0,Ft,Ct,rt.data)}else{Wt&&jt&&e.texStorage2D(s.TEXTURE_2D,Ot,Tt,St[0].width,St[0].height);for(let ut=0,I=St.length;ut<I;ut++)rt=St[ut],M.format!==Ve?Ft!==null?Wt?e.compressedTexSubImage2D(s.TEXTURE_2D,ut,0,0,rt.width,rt.height,Ft,rt.data):e.compressedTexImage2D(s.TEXTURE_2D,ut,Tt,rt.width,rt.height,0,rt.data):console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()"):Wt?e.texSubImage2D(s.TEXTURE_2D,ut,0,0,rt.width,rt.height,Ft,Ct,rt.data):e.texImage2D(s.TEXTURE_2D,ut,Tt,rt.width,rt.height,0,Ft,Ct,rt.data)}else if(M.isDataArrayTexture)Wt?(jt&&e.texStorage3D(s.TEXTURE_2D_ARRAY,Ot,Tt,st.width,st.height,st.depth),e.texSubImage3D(s.TEXTURE_2D_ARRAY,0,0,0,0,st.width,st.height,st.depth,Ft,Ct,st.data)):e.texImage3D(s.TEXTURE_2D_ARRAY,0,Tt,st.width,st.height,st.depth,0,Ft,Ct,st.data);else if(M.isData3DTexture)Wt?(jt&&e.texStorage3D(s.TEXTURE_3D,Ot,Tt,st.width,st.height,st.depth),e.texSubImage3D(s.TEXTURE_3D,0,0,0,0,st.width,st.height,st.depth,Ft,Ct,st.data)):e.texImage3D(s.TEXTURE_3D,0,Tt,st.width,st.height,st.depth,0,Ft,Ct,st.data);else if(M.isFramebufferTexture){if(jt)if(Wt)e.texStorage2D(s.TEXTURE_2D,Ot,Tt,st.width,st.height);else{let ut=st.width,I=st.height;for(let mt=0;mt<Ot;mt++)e.texImage2D(s.TEXTURE_2D,mt,Tt,ut,I,0,Ft,Ct,null),ut>>=1,I>>=1}}else if(St.length>0&&Xt){Wt&&jt&&e.texStorage2D(s.TEXTURE_2D,Ot,Tt,St[0].width,St[0].height);for(let ut=0,I=St.length;ut<I;ut++)rt=St[ut],Wt?e.texSubImage2D(s.TEXTURE_2D,ut,0,0,Ft,Ct,rt):e.texImage2D(s.TEXTURE_2D,ut,Tt,Ft,Ct,rt);M.generateMipmaps=!1}else Wt?(jt&&e.texStorage2D(s.TEXTURE_2D,Ot,Tt,st.width,st.height),e.texSubImage2D(s.TEXTURE_2D,0,0,0,Ft,Ct,st)):e.texImage2D(s.TEXTURE_2D,0,Tt,Ft,Ct,st);g(M,Xt)&&_(tt),_t.__version=Q.version,M.onUpdate&&M.onUpdate(M)}E.__version=M.version}function nt(E,M,O){if(M.image.length!==6)return;let tt=J(E,M),j=M.source;e.bindTexture(s.TEXTURE_CUBE_MAP,E.__webglTexture,s.TEXTURE0+O);let Q=n.get(j);if(j.version!==Q.__version||tt===!0){e.activeTexture(s.TEXTURE0+O);let _t=qt.getPrimaries(qt.workingColorSpace),ft=M.colorSpace===De?null:qt.getPrimaries(M.colorSpace),yt=M.colorSpace===De||_t===ft?s.NONE:s.BROWSER_DEFAULT_WEBGL;s.pixelStorei(s.UNPACK_FLIP_Y_WEBGL,M.flipY),s.pixelStorei(s.UNPACK_PREMULTIPLY_ALPHA_WEBGL,M.premultiplyAlpha),s.pixelStorei(s.UNPACK_ALIGNMENT,M.unpackAlignment),s.pixelStorei(s.UNPACK_COLORSPACE_CONVERSION_WEBGL,yt);let At=M.isCompressedTexture||M.image[0].isCompressedTexture,Ut=M.image[0]&&M.image[0].isDataTexture,st=[];for(let ut=0;ut<6;ut++)!At&&!Ut?st[ut]=x(M.image[ut],!1,!0,i.maxCubemapSize):st[ut]=Ut?M.image[ut].image:M.image[ut],st[ut]=Mt(M,st[ut]);let Xt=st[0],Ft=p(Xt)||a,Ct=r.convert(M.format,M.colorSpace),Tt=r.convert(M.type),rt=b(M.internalFormat,Ct,Tt,M.colorSpace),St=a&&M.isVideoTexture!==!0,Wt=Q.__version===void 0||tt===!0,jt=S(M,Xt,Ft);G(s.TEXTURE_CUBE_MAP,M,Ft);let Ot;if(At){St&&Wt&&e.texStorage2D(s.TEXTURE_CUBE_MAP,jt,rt,Xt.width,Xt.height);for(let ut=0;ut<6;ut++){Ot=st[ut].mipmaps;for(let I=0;I<Ot.length;I++){let mt=Ot[I];M.format!==Ve?Ct!==null?St?e.compressedTexSubImage2D(s.TEXTURE_CUBE_MAP_POSITIVE_X+ut,I,0,0,mt.width,mt.height,Ct,mt.data):e.compressedTexImage2D(s.TEXTURE_CUBE_MAP_POSITIVE_X+ut,I,rt,mt.width,mt.height,0,mt.data):console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .setTextureCube()"):St?e.texSubImage2D(s.TEXTURE_CUBE_MAP_POSITIVE_X+ut,I,0,0,mt.width,mt.height,Ct,Tt,mt.data):e.texImage2D(s.TEXTURE_CUBE_MAP_POSITIVE_X+ut,I,rt,mt.width,mt.height,0,Ct,Tt,mt.data)}}}else{Ot=M.mipmaps,St&&Wt&&(Ot.length>0&&jt++,e.texStorage2D(s.TEXTURE_CUBE_MAP,jt,rt,st[0].width,st[0].height));for(let ut=0;ut<6;ut++)if(Ut){St?e.texSubImage2D(s.TEXTURE_CUBE_MAP_POSITIVE_X+ut,0,0,0,st[ut].width,st[ut].height,Ct,Tt,st[ut].data):e.texImage2D(s.TEXTURE_CUBE_MAP_POSITIVE_X+ut,0,rt,st[ut].width,st[ut].height,0,Ct,Tt,st[ut].data);for(let I=0;I<Ot.length;I++){let gt=Ot[I].image[ut].image;St?e.texSubImage2D(s.TEXTURE_CUBE_MAP_POSITIVE_X+ut,I+1,0,0,gt.width,gt.height,Ct,Tt,gt.data):e.texImage2D(s.TEXTURE_CUBE_MAP_POSITIVE_X+ut,I+1,rt,gt.width,gt.height,0,Ct,Tt,gt.data)}}else{St?e.texSubImage2D(s.TEXTURE_CUBE_MAP_POSITIVE_X+ut,0,0,0,Ct,Tt,st[ut]):e.texImage2D(s.TEXTURE_CUBE_MAP_POSITIVE_X+ut,0,rt,Ct,Tt,st[ut]);for(let I=0;I<Ot.length;I++){let mt=Ot[I];St?e.texSubImage2D(s.TEXTURE_CUBE_MAP_POSITIVE_X+ut,I+1,0,0,Ct,Tt,mt.image[ut]):e.texImage2D(s.TEXTURE_CUBE_MAP_POSITIVE_X+ut,I+1,rt,Ct,Tt,mt.image[ut])}}}g(M,Ft)&&_(s.TEXTURE_CUBE_MAP),Q.__version=j.version,M.onUpdate&&M.onUpdate(M)}E.__version=M.version}function ht(E,M,O,tt,j,Q){let _t=r.convert(O.format,O.colorSpace),ft=r.convert(O.type),yt=b(O.internalFormat,_t,ft,O.colorSpace);if(!n.get(M).__hasExternalTextures){let Ut=Math.max(1,M.width>>Q),st=Math.max(1,M.height>>Q);j===s.TEXTURE_3D||j===s.TEXTURE_2D_ARRAY?e.texImage3D(j,Q,yt,Ut,st,M.depth,0,_t,ft,null):e.texImage2D(j,Q,yt,Ut,st,0,_t,ft,null)}e.bindFramebuffer(s.FRAMEBUFFER,E),it(M)?c.framebufferTexture2DMultisampleEXT(s.FRAMEBUFFER,tt,j,n.get(O).__webglTexture,0,at(M)):(j===s.TEXTURE_2D||j>=s.TEXTURE_CUBE_MAP_POSITIVE_X&&j<=s.TEXTURE_CUBE_MAP_NEGATIVE_Z)&&s.framebufferTexture2D(s.FRAMEBUFFER,tt,j,n.get(O).__webglTexture,Q),e.bindFramebuffer(s.FRAMEBUFFER,null)}function xt(E,M,O){if(s.bindRenderbuffer(s.RENDERBUFFER,E),M.depthBuffer&&!M.stencilBuffer){let tt=a===!0?s.DEPTH_COMPONENT24:s.DEPTH_COMPONENT16;if(O||it(M)){let j=M.depthTexture;j&&j.isDepthTexture&&(j.type===mn?tt=s.DEPTH_COMPONENT32F:j.type===pn&&(tt=s.DEPTH_COMPONENT24));let Q=at(M);it(M)?c.renderbufferStorageMultisampleEXT(s.RENDERBUFFER,Q,tt,M.width,M.height):s.renderbufferStorageMultisample(s.RENDERBUFFER,Q,tt,M.width,M.height)}else s.renderbufferStorage(s.RENDERBUFFER,tt,M.width,M.height);s.framebufferRenderbuffer(s.FRAMEBUFFER,s.DEPTH_ATTACHMENT,s.RENDERBUFFER,E)}else if(M.depthBuffer&&M.stencilBuffer){let tt=at(M);O&&it(M)===!1?s.renderbufferStorageMultisample(s.RENDERBUFFER,tt,s.DEPTH24_STENCIL8,M.width,M.height):it(M)?c.renderbufferStorageMultisampleEXT(s.RENDERBUFFER,tt,s.DEPTH24_STENCIL8,M.width,M.height):s.renderbufferStorage(s.RENDERBUFFER,s.DEPTH_STENCIL,M.width,M.height),s.framebufferRenderbuffer(s.FRAMEBUFFER,s.DEPTH_STENCIL_ATTACHMENT,s.RENDERBUFFER,E)}else{let tt=M.isWebGLMultipleRenderTargets===!0?M.texture:[M.texture];for(let j=0;j<tt.length;j++){let Q=tt[j],_t=r.convert(Q.format,Q.colorSpace),ft=r.convert(Q.type),yt=b(Q.internalFormat,_t,ft,Q.colorSpace),At=at(M);O&&it(M)===!1?s.renderbufferStorageMultisample(s.RENDERBUFFER,At,yt,M.width,M.height):it(M)?c.renderbufferStorageMultisampleEXT(s.RENDERBUFFER,At,yt,M.width,M.height):s.renderbufferStorage(s.RENDERBUFFER,yt,M.width,M.height)}}s.bindRenderbuffer(s.RENDERBUFFER,null)}function Y(E,M){if(M&&M.isWebGLCubeRenderTarget)throw new Error("Depth Texture with cube render targets is not supported");if(e.bindFramebuffer(s.FRAMEBUFFER,E),!(M.depthTexture&&M.depthTexture.isDepthTexture))throw new Error("renderTarget.depthTexture must be an instance of THREE.DepthTexture");(!n.get(M.depthTexture).__webglTexture||M.depthTexture.image.width!==M.width||M.depthTexture.image.height!==M.height)&&(M.depthTexture.image.width=M.width,M.depthTexture.image.height=M.height,M.depthTexture.needsUpdate=!0),H(M.depthTexture,0);let tt=n.get(M.depthTexture).__webglTexture,j=at(M);if(M.depthTexture.format===Fn)it(M)?c.framebufferTexture2DMultisampleEXT(s.FRAMEBUFFER,s.DEPTH_ATTACHMENT,s.TEXTURE_2D,tt,0,j):s.framebufferTexture2D(s.FRAMEBUFFER,s.DEPTH_ATTACHMENT,s.TEXTURE_2D,tt,0);else if(M.depthTexture.format===_i)it(M)?c.framebufferTexture2DMultisampleEXT(s.FRAMEBUFFER,s.DEPTH_STENCIL_ATTACHMENT,s.TEXTURE_2D,tt,0,j):s.framebufferTexture2D(s.FRAMEBUFFER,s.DEPTH_STENCIL_ATTACHMENT,s.TEXTURE_2D,tt,0);else throw new Error("Unknown depthTexture format")}function lt(E){let M=n.get(E),O=E.isWebGLCubeRenderTarget===!0;if(E.depthTexture&&!M.__autoAllocateDepthBuffer){if(O)throw new Error("target.depthTexture not supported in Cube render targets");Y(M.__webglFramebuffer,E)}else if(O){M.__webglDepthbuffer=[];for(let tt=0;tt<6;tt++)e.bindFramebuffer(s.FRAMEBUFFER,M.__webglFramebuffer[tt]),M.__webglDepthbuffer[tt]=s.createRenderbuffer(),xt(M.__webglDepthbuffer[tt],E,!1)}else e.bindFramebuffer(s.FRAMEBUFFER,M.__webglFramebuffer),M.__webglDepthbuffer=s.createRenderbuffer(),xt(M.__webglDepthbuffer,E,!1);e.bindFramebuffer(s.FRAMEBUFFER,null)}function pt(E,M,O){let tt=n.get(E);M!==void 0&&ht(tt.__webglFramebuffer,E,E.texture,s.COLOR_ATTACHMENT0,s.TEXTURE_2D,0),O!==void 0&&lt(E)}function U(E){let M=E.texture,O=n.get(E),tt=n.get(M);E.addEventListener("dispose",P),E.isWebGLMultipleRenderTargets!==!0&&(tt.__webglTexture===void 0&&(tt.__webglTexture=s.createTexture()),tt.__version=M.version,o.memory.textures++);let j=E.isWebGLCubeRenderTarget===!0,Q=E.isWebGLMultipleRenderTargets===!0,_t=p(E)||a;if(j){O.__webglFramebuffer=[];for(let ft=0;ft<6;ft++)if(a&&M.mipmaps&&M.mipmaps.length>0){O.__webglFramebuffer[ft]=[];for(let yt=0;yt<M.mipmaps.length;yt++)O.__webglFramebuffer[ft][yt]=s.createFramebuffer()}else O.__webglFramebuffer[ft]=s.createFramebuffer()}else{if(a&&M.mipmaps&&M.mipmaps.length>0){O.__webglFramebuffer=[];for(let ft=0;ft<M.mipmaps.length;ft++)O.__webglFramebuffer[ft]=s.createFramebuffer()}else O.__webglFramebuffer=s.createFramebuffer();if(Q)if(i.drawBuffers){let ft=E.texture;for(let yt=0,At=ft.length;yt<At;yt++){let Ut=n.get(ft[yt]);Ut.__webglTexture===void 0&&(Ut.__webglTexture=s.createTexture(),o.memory.textures++)}}else console.warn("THREE.WebGLRenderer: WebGLMultipleRenderTargets can only be used with WebGL2 or WEBGL_draw_buffers extension.");if(a&&E.samples>0&&it(E)===!1){let ft=Q?M:[M];O.__webglMultisampledFramebuffer=s.createFramebuffer(),O.__webglColorRenderbuffer=[],e.bindFramebuffer(s.FRAMEBUFFER,O.__webglMultisampledFramebuffer);for(let yt=0;yt<ft.length;yt++){let At=ft[yt];O.__webglColorRenderbuffer[yt]=s.createRenderbuffer(),s.bindRenderbuffer(s.RENDERBUFFER,O.__webglColorRenderbuffer[yt]);let Ut=r.convert(At.format,At.colorSpace),st=r.convert(At.type),Xt=b(At.internalFormat,Ut,st,At.colorSpace,E.isXRRenderTarget===!0),Ft=at(E);s.renderbufferStorageMultisample(s.RENDERBUFFER,Ft,Xt,E.width,E.height),s.framebufferRenderbuffer(s.FRAMEBUFFER,s.COLOR_ATTACHMENT0+yt,s.RENDERBUFFER,O.__webglColorRenderbuffer[yt])}s.bindRenderbuffer(s.RENDERBUFFER,null),E.depthBuffer&&(O.__webglDepthRenderbuffer=s.createRenderbuffer(),xt(O.__webglDepthRenderbuffer,E,!0)),e.bindFramebuffer(s.FRAMEBUFFER,null)}}if(j){e.bindTexture(s.TEXTURE_CUBE_MAP,tt.__webglTexture),G(s.TEXTURE_CUBE_MAP,M,_t);for(let ft=0;ft<6;ft++)if(a&&M.mipmaps&&M.mipmaps.length>0)for(let yt=0;yt<M.mipmaps.length;yt++)ht(O.__webglFramebuffer[ft][yt],E,M,s.COLOR_ATTACHMENT0,s.TEXTURE_CUBE_MAP_POSITIVE_X+ft,yt);else ht(O.__webglFramebuffer[ft],E,M,s.COLOR_ATTACHMENT0,s.TEXTURE_CUBE_MAP_POSITIVE_X+ft,0);g(M,_t)&&_(s.TEXTURE_CUBE_MAP),e.unbindTexture()}else if(Q){let ft=E.texture;for(let yt=0,At=ft.length;yt<At;yt++){let Ut=ft[yt],st=n.get(Ut);e.bindTexture(s.TEXTURE_2D,st.__webglTexture),G(s.TEXTURE_2D,Ut,_t),ht(O.__webglFramebuffer,E,Ut,s.COLOR_ATTACHMENT0+yt,s.TEXTURE_2D,0),g(Ut,_t)&&_(s.TEXTURE_2D)}e.unbindTexture()}else{let ft=s.TEXTURE_2D;if((E.isWebGL3DRenderTarget||E.isWebGLArrayRenderTarget)&&(a?ft=E.isWebGL3DRenderTarget?s.TEXTURE_3D:s.TEXTURE_2D_ARRAY:console.error("THREE.WebGLTextures: THREE.Data3DTexture and THREE.DataArrayTexture only supported with WebGL2.")),e.bindTexture(ft,tt.__webglTexture),G(ft,M,_t),a&&M.mipmaps&&M.mipmaps.length>0)for(let yt=0;yt<M.mipmaps.length;yt++)ht(O.__webglFramebuffer[yt],E,M,s.COLOR_ATTACHMENT0,ft,yt);else ht(O.__webglFramebuffer,E,M,s.COLOR_ATTACHMENT0,ft,0);g(M,_t)&&_(ft),e.unbindTexture()}E.depthBuffer&&lt(E)}function bt(E){let M=p(E)||a,O=E.isWebGLMultipleRenderTargets===!0?E.texture:[E.texture];for(let tt=0,j=O.length;tt<j;tt++){let Q=O[tt];if(g(Q,M)){let _t=E.isWebGLCubeRenderTarget?s.TEXTURE_CUBE_MAP:s.TEXTURE_2D,ft=n.get(Q).__webglTexture;e.bindTexture(_t,ft),_(_t),e.unbindTexture()}}}function et(E){if(a&&E.samples>0&&it(E)===!1){let M=E.isWebGLMultipleRenderTargets?E.texture:[E.texture],O=E.width,tt=E.height,j=s.COLOR_BUFFER_BIT,Q=[],_t=E.stencilBuffer?s.DEPTH_STENCIL_ATTACHMENT:s.DEPTH_ATTACHMENT,ft=n.get(E),yt=E.isWebGLMultipleRenderTargets===!0;if(yt)for(let At=0;At<M.length;At++)e.bindFramebuffer(s.FRAMEBUFFER,ft.__webglMultisampledFramebuffer),s.framebufferRenderbuffer(s.FRAMEBUFFER,s.COLOR_ATTACHMENT0+At,s.RENDERBUFFER,null),e.bindFramebuffer(s.FRAMEBUFFER,ft.__webglFramebuffer),s.framebufferTexture2D(s.DRAW_FRAMEBUFFER,s.COLOR_ATTACHMENT0+At,s.TEXTURE_2D,null,0);e.bindFramebuffer(s.READ_FRAMEBUFFER,ft.__webglMultisampledFramebuffer),e.bindFramebuffer(s.DRAW_FRAMEBUFFER,ft.__webglFramebuffer);for(let At=0;At<M.length;At++){Q.push(s.COLOR_ATTACHMENT0+At),E.depthBuffer&&Q.push(_t);let Ut=ft.__ignoreDepthValues!==void 0?ft.__ignoreDepthValues:!1;if(Ut===!1&&(E.depthBuffer&&(j|=s.DEPTH_BUFFER_BIT),E.stencilBuffer&&(j|=s.STENCIL_BUFFER_BIT)),yt&&s.framebufferRenderbuffer(s.READ_FRAMEBUFFER,s.COLOR_ATTACHMENT0,s.RENDERBUFFER,ft.__webglColorRenderbuffer[At]),Ut===!0&&(s.invalidateFramebuffer(s.READ_FRAMEBUFFER,[_t]),s.invalidateFramebuffer(s.DRAW_FRAMEBUFFER,[_t])),yt){let st=n.get(M[At]).__webglTexture;s.framebufferTexture2D(s.DRAW_FRAMEBUFFER,s.COLOR_ATTACHMENT0,s.TEXTURE_2D,st,0)}s.blitFramebuffer(0,0,O,tt,0,0,O,tt,j,s.NEAREST),l&&s.invalidateFramebuffer(s.READ_FRAMEBUFFER,Q)}if(e.bindFramebuffer(s.READ_FRAMEBUFFER,null),e.bindFramebuffer(s.DRAW_FRAMEBUFFER,null),yt)for(let At=0;At<M.length;At++){e.bindFramebuffer(s.FRAMEBUFFER,ft.__webglMultisampledFramebuffer),s.framebufferRenderbuffer(s.FRAMEBUFFER,s.COLOR_ATTACHMENT0+At,s.RENDERBUFFER,ft.__webglColorRenderbuffer[At]);let Ut=n.get(M[At]).__webglTexture;e.bindFramebuffer(s.FRAMEBUFFER,ft.__webglFramebuffer),s.framebufferTexture2D(s.DRAW_FRAMEBUFFER,s.COLOR_ATTACHMENT0+At,s.TEXTURE_2D,Ut,0)}e.bindFramebuffer(s.DRAW_FRAMEBUFFER,ft.__webglMultisampledFramebuffer)}}function at(E){return Math.min(i.maxSamples,E.samples)}function it(E){let M=n.get(E);return a&&E.samples>0&&t.has("WEBGL_multisampled_render_to_texture")===!0&&M.__useRenderToTexture!==!1}function wt(E){let M=o.render.frame;h.get(E)!==M&&(h.set(E,M),E.update())}function Mt(E,M){let O=E.colorSpace,tt=E.format,j=E.type;return E.isCompressedTexture===!0||E.isVideoTexture===!0||E.format===ro||O!==nn&&O!==De&&(qt.getTransfer(O)===Qt?a===!1?t.has("EXT_sRGB")===!0&&tt===Ve?(E.format=ro,E.minFilter=Ie,E.generateMipmaps=!1):M=Hs.sRGBToLinear(M):(tt!==Ve||j!==vn)&&console.warn("THREE.WebGLTextures: sRGB encoded textures have to use RGBAFormat and UnsignedByteType."):console.error("THREE.WebGLTextures: Unsupported texture color space:",O)),M}this.allocateTextureUnit=R,this.resetTextureUnits=W,this.setTexture2D=H,this.setTexture2DArray=k,this.setTexture3D=N,this.setTextureCube=V,this.rebindTextures=pt,this.setupRenderTarget=U,this.updateRenderTargetMipmap=bt,this.updateMultisampleRenderTarget=et,this.setupDepthRenderbuffer=lt,this.setupFrameBufferTexture=ht,this.useMultisampledRTT=it}function pm(s,t,e){let n=e.isWebGL2;function i(r,o=De){let a,c=qt.getTransfer(o);if(r===vn)return s.UNSIGNED_BYTE;if(r===kc)return s.UNSIGNED_SHORT_4_4_4_4;if(r===Vc)return s.UNSIGNED_SHORT_5_5_5_1;if(r===rh)return s.BYTE;if(r===oh)return s.SHORT;if(r===ko)return s.UNSIGNED_SHORT;if(r===zc)return s.INT;if(r===pn)return s.UNSIGNED_INT;if(r===mn)return s.FLOAT;if(r===Hi)return n?s.HALF_FLOAT:(a=t.get("OES_texture_half_float"),a!==null?a.HALF_FLOAT_OES:null);if(r===ah)return s.ALPHA;if(r===Ve)return s.RGBA;if(r===ch)return s.LUMINANCE;if(r===lh)return s.LUMINANCE_ALPHA;if(r===Fn)return s.DEPTH_COMPONENT;if(r===_i)return s.DEPTH_STENCIL;if(r===ro)return a=t.get("EXT_sRGB"),a!==null?a.SRGB_ALPHA_EXT:null;if(r===hh)return s.RED;if(r===Hc)return s.RED_INTEGER;if(r===uh)return s.RG;if(r===Gc)return s.RG_INTEGER;if(r===Wc)return s.RGBA_INTEGER;if(r===yr||r===Mr||r===br||r===Sr)if(c===Qt)if(a=t.get("WEBGL_compressed_texture_s3tc_srgb"),a!==null){if(r===yr)return a.COMPRESSED_SRGB_S3TC_DXT1_EXT;if(r===Mr)return a.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT;if(r===br)return a.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT;if(r===Sr)return a.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT}else return null;else if(a=t.get("WEBGL_compressed_texture_s3tc"),a!==null){if(r===yr)return a.COMPRESSED_RGB_S3TC_DXT1_EXT;if(r===Mr)return a.COMPRESSED_RGBA_S3TC_DXT1_EXT;if(r===br)return a.COMPRESSED_RGBA_S3TC_DXT3_EXT;if(r===Sr)return a.COMPRESSED_RGBA_S3TC_DXT5_EXT}else return null;if(r===ha||r===ua||r===da||r===fa)if(a=t.get("WEBGL_compressed_texture_pvrtc"),a!==null){if(r===ha)return a.COMPRESSED_RGB_PVRTC_4BPPV1_IMG;if(r===ua)return a.COMPRESSED_RGB_PVRTC_2BPPV1_IMG;if(r===da)return a.COMPRESSED_RGBA_PVRTC_4BPPV1_IMG;if(r===fa)return a.COMPRESSED_RGBA_PVRTC_2BPPV1_IMG}else return null;if(r===Xc)return a=t.get("WEBGL_compressed_texture_etc1"),a!==null?a.COMPRESSED_RGB_ETC1_WEBGL:null;if(r===pa||r===ma)if(a=t.get("WEBGL_compressed_texture_etc"),a!==null){if(r===pa)return c===Qt?a.COMPRESSED_SRGB8_ETC2:a.COMPRESSED_RGB8_ETC2;if(r===ma)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC:a.COMPRESSED_RGBA8_ETC2_EAC}else return null;if(r===ga||r===_a||r===va||r===xa||r===ya||r===Ma||r===ba||r===Sa||r===wa||r===Ea||r===Aa||r===Ta||r===Ca||r===Ra)if(a=t.get("WEBGL_compressed_texture_astc"),a!==null){if(r===ga)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR:a.COMPRESSED_RGBA_ASTC_4x4_KHR;if(r===_a)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_5x4_KHR:a.COMPRESSED_RGBA_ASTC_5x4_KHR;if(r===va)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_5x5_KHR:a.COMPRESSED_RGBA_ASTC_5x5_KHR;if(r===xa)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_6x5_KHR:a.COMPRESSED_RGBA_ASTC_6x5_KHR;if(r===ya)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_6x6_KHR:a.COMPRESSED_RGBA_ASTC_6x6_KHR;if(r===Ma)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_8x5_KHR:a.COMPRESSED_RGBA_ASTC_8x5_KHR;if(r===ba)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_8x6_KHR:a.COMPRESSED_RGBA_ASTC_8x6_KHR;if(r===Sa)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_8x8_KHR:a.COMPRESSED_RGBA_ASTC_8x8_KHR;if(r===wa)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_10x5_KHR:a.COMPRESSED_RGBA_ASTC_10x5_KHR;if(r===Ea)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_10x6_KHR:a.COMPRESSED_RGBA_ASTC_10x6_KHR;if(r===Aa)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_10x8_KHR:a.COMPRESSED_RGBA_ASTC_10x8_KHR;if(r===Ta)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_10x10_KHR:a.COMPRESSED_RGBA_ASTC_10x10_KHR;if(r===Ca)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_12x10_KHR:a.COMPRESSED_RGBA_ASTC_12x10_KHR;if(r===Ra)return c===Qt?a.COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR:a.COMPRESSED_RGBA_ASTC_12x12_KHR}else return null;if(r===wr||r===Pa||r===La)if(a=t.get("EXT_texture_compression_bptc"),a!==null){if(r===wr)return c===Qt?a.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT:a.COMPRESSED_RGBA_BPTC_UNORM_EXT;if(r===Pa)return a.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT;if(r===La)return a.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT}else return null;if(r===dh||r===Ia||r===Da||r===Ua)if(a=t.get("EXT_texture_compression_rgtc"),a!==null){if(r===wr)return a.COMPRESSED_RED_RGTC1_EXT;if(r===Ia)return a.COMPRESSED_SIGNED_RED_RGTC1_EXT;if(r===Da)return a.COMPRESSED_RED_GREEN_RGTC2_EXT;if(r===Ua)return a.COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT}else return null;return r===Nn?n?s.UNSIGNED_INT_24_8:(a=t.get("WEBGL_depth_texture"),a!==null?a.UNSIGNED_INT_24_8_WEBGL:null):s[r]!==void 0?s[r]:null}return{convert:i}}var bo=class extends Se{constructor(t=[]){super(),this.isArrayCamera=!0,this.cameras=t}},ui=class extends fe{constructor(){super(),this.isGroup=!0,this.type="Group"}},mm={type:"move"},ki=class{constructor(){this._targetRay=null,this._grip=null,this._hand=null}getHandSpace(){return this._hand===null&&(this._hand=new ui,this._hand.matrixAutoUpdate=!1,this._hand.visible=!1,this._hand.joints={},this._hand.inputState={pinching:!1}),this._hand}getTargetRaySpace(){return this._targetRay===null&&(this._targetRay=new ui,this._targetRay.matrixAutoUpdate=!1,this._targetRay.visible=!1,this._targetRay.hasLinearVelocity=!1,this._targetRay.linearVelocity=new L,this._targetRay.hasAngularVelocity=!1,this._targetRay.angularVelocity=new L),this._targetRay}getGripSpace(){return this._grip===null&&(this._grip=new ui,this._grip.matrixAutoUpdate=!1,this._grip.visible=!1,this._grip.hasLinearVelocity=!1,this._grip.linearVelocity=new L,this._grip.hasAngularVelocity=!1,this._grip.angularVelocity=new L),this._grip}dispatchEvent(t){return this._targetRay!==null&&this._targetRay.dispatchEvent(t),this._grip!==null&&this._grip.dispatchEvent(t),this._hand!==null&&this._hand.dispatchEvent(t),this}connect(t){if(t&&t.hand){let e=this._hand;if(e)for(let n of t.hand.values())this._getHandJoint(e,n)}return this.dispatchEvent({type:"connected",data:t}),this}disconnect(t){return this.dispatchEvent({type:"disconnected",data:t}),this._targetRay!==null&&(this._targetRay.visible=!1),this._grip!==null&&(this._grip.visible=!1),this._hand!==null&&(this._hand.visible=!1),this}update(t,e,n){let i=null,r=null,o=null,a=this._targetRay,c=this._grip,l=this._hand;if(t&&e.session.visibilityState!=="visible-blurred"){if(l&&t.hand){o=!0;for(let x of t.hand.values()){let p=e.getJointPose(x,n),f=this._getHandJoint(l,x);p!==null&&(f.matrix.fromArray(p.transform.matrix),f.matrix.decompose(f.position,f.rotation,f.scale),f.matrixWorldNeedsUpdate=!0,f.jointRadius=p.radius),f.visible=p!==null}let h=l.joints["index-finger-tip"],u=l.joints["thumb-tip"],d=h.position.distanceTo(u.position),m=.02,v=.005;l.inputState.pinching&&d>m+v?(l.inputState.pinching=!1,this.dispatchEvent({type:"pinchend",handedness:t.handedness,target:this})):!l.inputState.pinching&&d<=m-v&&(l.inputState.pinching=!0,this.dispatchEvent({type:"pinchstart",handedness:t.handedness,target:this}))}else c!==null&&t.gripSpace&&(r=e.getPose(t.gripSpace,n),r!==null&&(c.matrix.fromArray(r.transform.matrix),c.matrix.decompose(c.position,c.rotation,c.scale),c.matrixWorldNeedsUpdate=!0,r.linearVelocity?(c.hasLinearVelocity=!0,c.linearVelocity.copy(r.linearVelocity)):c.hasLinearVelocity=!1,r.angularVelocity?(c.hasAngularVelocity=!0,c.angularVelocity.copy(r.angularVelocity)):c.hasAngularVelocity=!1));a!==null&&(i=e.getPose(t.targetRaySpace,n),i===null&&r!==null&&(i=r),i!==null&&(a.matrix.fromArray(i.transform.matrix),a.matrix.decompose(a.position,a.rotation,a.scale),a.matrixWorldNeedsUpdate=!0,i.linearVelocity?(a.hasLinearVelocity=!0,a.linearVelocity.copy(i.linearVelocity)):a.hasLinearVelocity=!1,i.angularVelocity?(a.hasAngularVelocity=!0,a.angularVelocity.copy(i.angularVelocity)):a.hasAngularVelocity=!1,this.dispatchEvent(mm)))}return a!==null&&(a.visible=i!==null),c!==null&&(c.visible=r!==null),l!==null&&(l.visible=o!==null),this}_getHandJoint(t,e){if(t.joints[e.jointName]===void 0){let n=new ui;n.matrixAutoUpdate=!1,n.visible=!1,t.joints[e.jointName]=n,t.add(n)}return t.joints[e.jointName]}},So=class extends Mn{constructor(t,e){super();let n=this,i=null,r=1,o=null,a="local-floor",c=1,l=null,h=null,u=null,d=null,m=null,v=null,x=e.getContextAttributes(),p=null,f=null,g=[],_=[],b=new Lt,S=null,T=new Se;T.layers.enable(1),T.viewport=new de;let C=new Se;C.layers.enable(2),C.viewport=new de;let P=[T,C],y=new bo;y.layers.enable(1),y.layers.enable(2);let w=null,F=null;this.cameraAutoUpdate=!0,this.enabled=!1,this.isPresenting=!1,this.getController=function(G){let J=g[G];return J===void 0&&(J=new ki,g[G]=J),J.getTargetRaySpace()},this.getControllerGrip=function(G){let J=g[G];return J===void 0&&(J=new ki,g[G]=J),J.getGripSpace()},this.getHand=function(G){let J=g[G];return J===void 0&&(J=new ki,g[G]=J),J.getHandSpace()};function B(G){let J=_.indexOf(G.inputSource);if(J===-1)return;let ot=g[J];ot!==void 0&&(ot.update(G.inputSource,G.frame,l||o),ot.dispatchEvent({type:G.type,data:G.inputSource}))}function W(){i.removeEventListener("select",B),i.removeEventListener("selectstart",B),i.removeEventListener("selectend",B),i.removeEventListener("squeeze",B),i.removeEventListener("squeezestart",B),i.removeEventListener("squeezeend",B),i.removeEventListener("end",W),i.removeEventListener("inputsourceschange",R);for(let G=0;G<g.length;G++){let J=_[G];J!==null&&(_[G]=null,g[G].disconnect(J))}w=null,F=null,t.setRenderTarget(p),m=null,d=null,u=null,i=null,f=null,ct.stop(),n.isPresenting=!1,t.setPixelRatio(S),t.setSize(b.width,b.height,!1),n.dispatchEvent({type:"sessionend"})}this.setFramebufferScaleFactor=function(G){r=G,n.isPresenting===!0&&console.warn("THREE.WebXRManager: Cannot change framebuffer scale while presenting.")},this.setReferenceSpaceType=function(G){a=G,n.isPresenting===!0&&console.warn("THREE.WebXRManager: Cannot change reference space type while presenting.")},this.getReferenceSpace=function(){return l||o},this.setReferenceSpace=function(G){l=G},this.getBaseLayer=function(){return d!==null?d:m},this.getBinding=function(){return u},this.getFrame=function(){return v},this.getSession=function(){return i},this.setSession=async function(G){if(i=G,i!==null){if(p=t.getRenderTarget(),i.addEventListener("select",B),i.addEventListener("selectstart",B),i.addEventListener("selectend",B),i.addEventListener("squeeze",B),i.addEventListener("squeezestart",B),i.addEventListener("squeezeend",B),i.addEventListener("end",W),i.addEventListener("inputsourceschange",R),x.xrCompatible!==!0&&await e.makeXRCompatible(),S=t.getPixelRatio(),t.getSize(b),i.renderState.layers===void 0||t.capabilities.isWebGL2===!1){let J={antialias:i.renderState.layers===void 0?x.antialias:!0,alpha:!0,depth:x.depth,stencil:x.stencil,framebufferScaleFactor:r};m=new XRWebGLLayer(i,e,J),i.updateRenderState({baseLayer:m}),t.setPixelRatio(1),t.setSize(m.framebufferWidth,m.framebufferHeight,!1),f=new sn(m.framebufferWidth,m.framebufferHeight,{format:Ve,type:vn,colorSpace:t.outputColorSpace,stencilBuffer:x.stencil})}else{let J=null,ot=null,nt=null;x.depth&&(nt=x.stencil?e.DEPTH24_STENCIL8:e.DEPTH_COMPONENT24,J=x.stencil?_i:Fn,ot=x.stencil?Nn:pn);let ht={colorFormat:e.RGBA8,depthFormat:nt,scaleFactor:r};u=new XRWebGLBinding(i,e),d=u.createProjectionLayer(ht),i.updateRenderState({layers:[d]}),t.setPixelRatio(1),t.setSize(d.textureWidth,d.textureHeight,!1),f=new sn(d.textureWidth,d.textureHeight,{format:Ve,type:vn,depthTexture:new $s(d.textureWidth,d.textureHeight,ot,void 0,void 0,void 0,void 0,void 0,void 0,J),stencilBuffer:x.stencil,colorSpace:t.outputColorSpace,samples:x.antialias?4:0});let xt=t.properties.get(f);xt.__ignoreDepthValues=d.ignoreDepthValues}f.isXRRenderTarget=!0,this.setFoveation(c),l=null,o=await i.requestReferenceSpace(a),ct.setContext(i),ct.start(),n.isPresenting=!0,n.dispatchEvent({type:"sessionstart"})}},this.getEnvironmentBlendMode=function(){if(i!==null)return i.environmentBlendMode};function R(G){for(let J=0;J<G.removed.length;J++){let ot=G.removed[J],nt=_.indexOf(ot);nt>=0&&(_[nt]=null,g[nt].disconnect(ot))}for(let J=0;J<G.added.length;J++){let ot=G.added[J],nt=_.indexOf(ot);if(nt===-1){for(let xt=0;xt<g.length;xt++)if(xt>=_.length){_.push(ot),nt=xt;break}else if(_[xt]===null){_[xt]=ot,nt=xt;break}if(nt===-1)break}let ht=g[nt];ht&&ht.connect(ot)}}let D=new L,H=new L;function k(G,J,ot){D.setFromMatrixPosition(J.matrixWorld),H.setFromMatrixPosition(ot.matrixWorld);let nt=D.distanceTo(H),ht=J.projectionMatrix.elements,xt=ot.projectionMatrix.elements,Y=ht[14]/(ht[10]-1),lt=ht[14]/(ht[10]+1),pt=(ht[9]+1)/ht[5],U=(ht[9]-1)/ht[5],bt=(ht[8]-1)/ht[0],et=(xt[8]+1)/xt[0],at=Y*bt,it=Y*et,wt=nt/(-bt+et),Mt=wt*-bt;J.matrixWorld.decompose(G.position,G.quaternion,G.scale),G.translateX(Mt),G.translateZ(wt),G.matrixWorld.compose(G.position,G.quaternion,G.scale),G.matrixWorldInverse.copy(G.matrixWorld).invert();let E=Y+wt,M=lt+wt,O=at-Mt,tt=it+(nt-Mt),j=pt*lt/M*E,Q=U*lt/M*E;G.projectionMatrix.makePerspective(O,tt,j,Q,E,M),G.projectionMatrixInverse.copy(G.projectionMatrix).invert()}function N(G,J){J===null?G.matrixWorld.copy(G.matrix):G.matrixWorld.multiplyMatrices(J.matrixWorld,G.matrix),G.matrixWorldInverse.copy(G.matrixWorld).invert()}this.updateCamera=function(G){if(i===null)return;y.near=C.near=T.near=G.near,y.far=C.far=T.far=G.far,(w!==y.near||F!==y.far)&&(i.updateRenderState({depthNear:y.near,depthFar:y.far}),w=y.near,F=y.far);let J=G.parent,ot=y.cameras;N(y,J);for(let nt=0;nt<ot.length;nt++)N(ot[nt],J);ot.length===2?k(y,T,C):y.projectionMatrix.copy(T.projectionMatrix),V(G,y,J)};function V(G,J,ot){ot===null?G.matrix.copy(J.matrixWorld):(G.matrix.copy(ot.matrixWorld),G.matrix.invert(),G.matrix.multiply(J.matrixWorld)),G.matrix.decompose(G.position,G.quaternion,G.scale),G.updateMatrixWorld(!0),G.projectionMatrix.copy(J.projectionMatrix),G.projectionMatrixInverse.copy(J.projectionMatrixInverse),G.isPerspectiveCamera&&(G.fov=oo*2*Math.atan(1/G.projectionMatrix.elements[5]),G.zoom=1)}this.getCamera=function(){return y},this.getFoveation=function(){if(!(d===null&&m===null))return c},this.setFoveation=function(G){c=G,d!==null&&(d.fixedFoveation=G),m!==null&&m.fixedFoveation!==void 0&&(m.fixedFoveation=G)};let K=null;function $(G,J){if(h=J.getViewerPose(l||o),v=J,h!==null){let ot=h.views;m!==null&&(t.setRenderTargetFramebuffer(f,m.framebuffer),t.setRenderTarget(f));let nt=!1;ot.length!==y.cameras.length&&(y.cameras.length=0,nt=!0);for(let ht=0;ht<ot.length;ht++){let xt=ot[ht],Y=null;if(m!==null)Y=m.getViewport(xt);else{let pt=u.getViewSubImage(d,xt);Y=pt.viewport,ht===0&&(t.setRenderTargetTextures(f,pt.colorTexture,d.ignoreDepthValues?void 0:pt.depthStencilTexture),t.setRenderTarget(f))}let lt=P[ht];lt===void 0&&(lt=new Se,lt.layers.enable(ht),lt.viewport=new de,P[ht]=lt),lt.matrix.fromArray(xt.transform.matrix),lt.matrix.decompose(lt.position,lt.quaternion,lt.scale),lt.projectionMatrix.fromArray(xt.projectionMatrix),lt.projectionMatrixInverse.copy(lt.projectionMatrix).invert(),lt.viewport.set(Y.x,Y.y,Y.width,Y.height),ht===0&&(y.matrix.copy(lt.matrix),y.matrix.decompose(y.position,y.quaternion,y.scale)),nt===!0&&y.cameras.push(lt)}}for(let ot=0;ot<g.length;ot++){let nt=_[ot],ht=g[ot];nt!==null&&ht!==void 0&&ht.update(nt,J,l||o)}K&&K(G,J),J.detectedPlanes&&n.dispatchEvent({type:"planesdetected",data:J}),v=null}let ct=new $c;ct.setAnimationLoop($),this.setAnimationLoop=function(G){K=G},this.dispose=function(){}}};function gm(s,t){function e(p,f){p.matrixAutoUpdate===!0&&p.updateMatrix(),f.value.copy(p.matrix)}function n(p,f){f.color.getRGB(p.fogColor.value,Kc(s)),f.isFog?(p.fogNear.value=f.near,p.fogFar.value=f.far):f.isFogExp2&&(p.fogDensity.value=f.density)}function i(p,f,g,_,b){f.isMeshBasicMaterial||f.isMeshLambertMaterial?r(p,f):f.isMeshToonMaterial?(r(p,f),u(p,f)):f.isMeshPhongMaterial?(r(p,f),h(p,f)):f.isMeshStandardMaterial?(r(p,f),d(p,f),f.isMeshPhysicalMaterial&&m(p,f,b)):f.isMeshMatcapMaterial?(r(p,f),v(p,f)):f.isMeshDepthMaterial?r(p,f):f.isMeshDistanceMaterial?(r(p,f),x(p,f)):f.isMeshNormalMaterial?r(p,f):f.isLineBasicMaterial?(o(p,f),f.isLineDashedMaterial&&a(p,f)):f.isPointsMaterial?c(p,f,g,_):f.isSpriteMaterial?l(p,f):f.isShadowMaterial?(p.color.value.copy(f.color),p.opacity.value=f.opacity):f.isShaderMaterial&&(f.uniformsNeedUpdate=!1)}function r(p,f){p.opacity.value=f.opacity,f.color&&p.diffuse.value.copy(f.color),f.emissive&&p.emissive.value.copy(f.emissive).multiplyScalar(f.emissiveIntensity),f.map&&(p.map.value=f.map,e(f.map,p.mapTransform)),f.alphaMap&&(p.alphaMap.value=f.alphaMap,e(f.alphaMap,p.alphaMapTransform)),f.bumpMap&&(p.bumpMap.value=f.bumpMap,e(f.bumpMap,p.bumpMapTransform),p.bumpScale.value=f.bumpScale,f.side===Ee&&(p.bumpScale.value*=-1)),f.normalMap&&(p.normalMap.value=f.normalMap,e(f.normalMap,p.normalMapTransform),p.normalScale.value.copy(f.normalScale),f.side===Ee&&p.normalScale.value.negate()),f.displacementMap&&(p.displacementMap.value=f.displacementMap,e(f.displacementMap,p.displacementMapTransform),p.displacementScale.value=f.displacementScale,p.displacementBias.value=f.displacementBias),f.emissiveMap&&(p.emissiveMap.value=f.emissiveMap,e(f.emissiveMap,p.emissiveMapTransform)),f.specularMap&&(p.specularMap.value=f.specularMap,e(f.specularMap,p.specularMapTransform)),f.alphaTest>0&&(p.alphaTest.value=f.alphaTest);let g=t.get(f).envMap;if(g&&(p.envMap.value=g,p.flipEnvMap.value=g.isCubeTexture&&g.isRenderTargetTexture===!1?-1:1,p.reflectivity.value=f.reflectivity,p.ior.value=f.ior,p.refractionRatio.value=f.refractionRatio),f.lightMap){p.lightMap.value=f.lightMap;let _=s._useLegacyLights===!0?Math.PI:1;p.lightMapIntensity.value=f.lightMapIntensity*_,e(f.lightMap,p.lightMapTransform)}f.aoMap&&(p.aoMap.value=f.aoMap,p.aoMapIntensity.value=f.aoMapIntensity,e(f.aoMap,p.aoMapTransform))}function o(p,f){p.diffuse.value.copy(f.color),p.opacity.value=f.opacity,f.map&&(p.map.value=f.map,e(f.map,p.mapTransform))}function a(p,f){p.dashSize.value=f.dashSize,p.totalSize.value=f.dashSize+f.gapSize,p.scale.value=f.scale}function c(p,f,g,_){p.diffuse.value.copy(f.color),p.opacity.value=f.opacity,p.size.value=f.size*g,p.scale.value=_*.5,f.map&&(p.map.value=f.map,e(f.map,p.uvTransform)),f.alphaMap&&(p.alphaMap.value=f.alphaMap,e(f.alphaMap,p.alphaMapTransform)),f.alphaTest>0&&(p.alphaTest.value=f.alphaTest)}function l(p,f){p.diffuse.value.copy(f.color),p.opacity.value=f.opacity,p.rotation.value=f.rotation,f.map&&(p.map.value=f.map,e(f.map,p.mapTransform)),f.alphaMap&&(p.alphaMap.value=f.alphaMap,e(f.alphaMap,p.alphaMapTransform)),f.alphaTest>0&&(p.alphaTest.value=f.alphaTest)}function h(p,f){p.specular.value.copy(f.specular),p.shininess.value=Math.max(f.shininess,1e-4)}function u(p,f){f.gradientMap&&(p.gradientMap.value=f.gradientMap)}function d(p,f){p.metalness.value=f.metalness,f.metalnessMap&&(p.metalnessMap.value=f.metalnessMap,e(f.metalnessMap,p.metalnessMapTransform)),p.roughness.value=f.roughness,f.roughnessMap&&(p.roughnessMap.value=f.roughnessMap,e(f.roughnessMap,p.roughnessMapTransform)),t.get(f).envMap&&(p.envMapIntensity.value=f.envMapIntensity)}function m(p,f,g){p.ior.value=f.ior,f.sheen>0&&(p.sheenColor.value.copy(f.sheenColor).multiplyScalar(f.sheen),p.sheenRoughness.value=f.sheenRoughness,f.sheenColorMap&&(p.sheenColorMap.value=f.sheenColorMap,e(f.sheenColorMap,p.sheenColorMapTransform)),f.sheenRoughnessMap&&(p.sheenRoughnessMap.value=f.sheenRoughnessMap,e(f.sheenRoughnessMap,p.sheenRoughnessMapTransform))),f.clearcoat>0&&(p.clearcoat.value=f.clearcoat,p.clearcoatRoughness.value=f.clearcoatRoughness,f.clearcoatMap&&(p.clearcoatMap.value=f.clearcoatMap,e(f.clearcoatMap,p.clearcoatMapTransform)),f.clearcoatRoughnessMap&&(p.clearcoatRoughnessMap.value=f.clearcoatRoughnessMap,e(f.clearcoatRoughnessMap,p.clearcoatRoughnessMapTransform)),f.clearcoatNormalMap&&(p.clearcoatNormalMap.value=f.clearcoatNormalMap,e(f.clearcoatNormalMap,p.clearcoatNormalMapTransform),p.clearcoatNormalScale.value.copy(f.clearcoatNormalScale),f.side===Ee&&p.clearcoatNormalScale.value.negate())),f.iridescence>0&&(p.iridescence.value=f.iridescence,p.iridescenceIOR.value=f.iridescenceIOR,p.iridescenceThicknessMinimum.value=f.iridescenceThicknessRange[0],p.iridescenceThicknessMaximum.value=f.iridescenceThicknessRange[1],f.iridescenceMap&&(p.iridescenceMap.value=f.iridescenceMap,e(f.iridescenceMap,p.iridescenceMapTransform)),f.iridescenceThicknessMap&&(p.iridescenceThicknessMap.value=f.iridescenceThicknessMap,e(f.iridescenceThicknessMap,p.iridescenceThicknessMapTransform))),f.transmission>0&&(p.transmission.value=f.transmission,p.transmissionSamplerMap.value=g.texture,p.transmissionSamplerSize.value.set(g.width,g.height),f.transmissionMap&&(p.transmissionMap.value=f.transmissionMap,e(f.transmissionMap,p.transmissionMapTransform)),p.thickness.value=f.thickness,f.thicknessMap&&(p.thicknessMap.value=f.thicknessMap,e(f.thicknessMap,p.thicknessMapTransform)),p.attenuationDistance.value=f.attenuationDistance,p.attenuationColor.value.copy(f.attenuationColor)),f.anisotropy>0&&(p.anisotropyVector.value.set(f.anisotropy*Math.cos(f.anisotropyRotation),f.anisotropy*Math.sin(f.anisotropyRotation)),f.anisotropyMap&&(p.anisotropyMap.value=f.anisotropyMap,e(f.anisotropyMap,p.anisotropyMapTransform))),p.specularIntensity.value=f.specularIntensity,p.specularColor.value.copy(f.specularColor),f.specularColorMap&&(p.specularColorMap.value=f.specularColorMap,e(f.specularColorMap,p.specularColorMapTransform)),f.specularIntensityMap&&(p.specularIntensityMap.value=f.specularIntensityMap,e(f.specularIntensityMap,p.specularIntensityMapTransform))}function v(p,f){f.matcap&&(p.matcap.value=f.matcap)}function x(p,f){let g=t.get(f).light;p.referencePosition.value.setFromMatrixPosition(g.matrixWorld),p.nearDistance.value=g.shadow.camera.near,p.farDistance.value=g.shadow.camera.far}return{refreshFogUniforms:n,refreshMaterialUniforms:i}}function _m(s,t,e,n){let i={},r={},o=[],a=e.isWebGL2?s.getParameter(s.MAX_UNIFORM_BUFFER_BINDINGS):0;function c(g,_){let b=_.program;n.uniformBlockBinding(g,b)}function l(g,_){let b=i[g.id];b===void 0&&(v(g),b=h(g),i[g.id]=b,g.addEventListener("dispose",p));let S=_.program;n.updateUBOMapping(g,S);let T=t.render.frame;r[g.id]!==T&&(d(g),r[g.id]=T)}function h(g){let _=u();g.__bindingPointIndex=_;let b=s.createBuffer(),S=g.__size,T=g.usage;return s.bindBuffer(s.UNIFORM_BUFFER,b),s.bufferData(s.UNIFORM_BUFFER,S,T),s.bindBuffer(s.UNIFORM_BUFFER,null),s.bindBufferBase(s.UNIFORM_BUFFER,_,b),b}function u(){for(let g=0;g<a;g++)if(o.indexOf(g)===-1)return o.push(g),g;return console.error("THREE.WebGLRenderer: Maximum number of simultaneously usable uniforms groups reached."),0}function d(g){let _=i[g.id],b=g.uniforms,S=g.__cache;s.bindBuffer(s.UNIFORM_BUFFER,_);for(let T=0,C=b.length;T<C;T++){let P=Array.isArray(b[T])?b[T]:[b[T]];for(let y=0,w=P.length;y<w;y++){let F=P[y];if(m(F,T,y,S)===!0){let B=F.__offset,W=Array.isArray(F.value)?F.value:[F.value],R=0;for(let D=0;D<W.length;D++){let H=W[D],k=x(H);typeof H=="number"||typeof H=="boolean"?(F.__data[0]=H,s.bufferSubData(s.UNIFORM_BUFFER,B+R,F.__data)):H.isMatrix3?(F.__data[0]=H.elements[0],F.__data[1]=H.elements[1],F.__data[2]=H.elements[2],F.__data[3]=0,F.__data[4]=H.elements[3],F.__data[5]=H.elements[4],F.__data[6]=H.elements[5],F.__data[7]=0,F.__data[8]=H.elements[6],F.__data[9]=H.elements[7],F.__data[10]=H.elements[8],F.__data[11]=0):(H.toArray(F.__data,R),R+=k.storage/Float32Array.BYTES_PER_ELEMENT)}s.bufferSubData(s.UNIFORM_BUFFER,B,F.__data)}}}s.bindBuffer(s.UNIFORM_BUFFER,null)}function m(g,_,b,S){let T=g.value,C=_+"_"+b;if(S[C]===void 0)return typeof T=="number"||typeof T=="boolean"?S[C]=T:S[C]=T.clone(),!0;{let P=S[C];if(typeof T=="number"||typeof T=="boolean"){if(P!==T)return S[C]=T,!0}else if(P.equals(T)===!1)return P.copy(T),!0}return!1}function v(g){let _=g.uniforms,b=0,S=16;for(let C=0,P=_.length;C<P;C++){let y=Array.isArray(_[C])?_[C]:[_[C]];for(let w=0,F=y.length;w<F;w++){let B=y[w],W=Array.isArray(B.value)?B.value:[B.value];for(let R=0,D=W.length;R<D;R++){let H=W[R],k=x(H),N=b%S;N!==0&&S-N<k.boundary&&(b+=S-N),B.__data=new Float32Array(k.storage/Float32Array.BYTES_PER_ELEMENT),B.__offset=b,b+=k.storage}}}let T=b%S;return T>0&&(b+=S-T),g.__size=b,g.__cache={},this}function x(g){let _={boundary:0,storage:0};return typeof g=="number"||typeof g=="boolean"?(_.boundary=4,_.storage=4):g.isVector2?(_.boundary=8,_.storage=8):g.isVector3||g.isColor?(_.boundary=16,_.storage=12):g.isVector4?(_.boundary=16,_.storage=16):g.isMatrix3?(_.boundary=48,_.storage=48):g.isMatrix4?(_.boundary=64,_.storage=64):g.isTexture?console.warn("THREE.WebGLRenderer: Texture samplers can not be part of an uniforms group."):console.warn("THREE.WebGLRenderer: Unsupported uniform value type.",g),_}function p(g){let _=g.target;_.removeEventListener("dispose",p);let b=o.indexOf(_.__bindingPointIndex);o.splice(b,1),s.deleteBuffer(i[_.id]),delete i[_.id],delete r[_.id]}function f(){for(let g in i)s.deleteBuffer(i[g]);o=[],i={},r={}}return{bind:c,update:l,dispose:f}}var Xi=class{constructor(t={}){let{canvas:e=Eh(),context:n=null,depth:i=!0,stencil:r=!0,alpha:o=!1,antialias:a=!1,premultipliedAlpha:c=!0,preserveDrawingBuffer:l=!1,powerPreference:h="default",failIfMajorPerformanceCaveat:u=!1}=t;this.isWebGLRenderer=!0;let d;n!==null?d=n.getContextAttributes().alpha:d=o;let m=new Uint32Array(4),v=new Int32Array(4),x=null,p=null,f=[],g=[];this.domElement=e,this.debug={checkShaderErrors:!0,onShaderError:null},this.autoClear=!0,this.autoClearColor=!0,this.autoClearDepth=!0,this.autoClearStencil=!0,this.sortObjects=!0,this.clippingPlanes=[],this.localClippingEnabled=!1,this._outputColorSpace=oe,this._useLegacyLights=!1,this.toneMapping=_n,this.toneMappingExposure=1;let _=this,b=!1,S=0,T=0,C=null,P=-1,y=null,w=new de,F=new de,B=null,W=new zt(0),R=0,D=e.width,H=e.height,k=1,N=null,V=null,K=new de(0,0,D,H),$=new de(0,0,D,H),ct=!1,G=new Mi,J=!1,ot=!1,nt=null,ht=new Zt,xt=new Lt,Y=new L,lt={background:null,fog:null,environment:null,overrideMaterial:null,isScene:!0};function pt(){return C===null?k:1}let U=n;function bt(A,z){for(let q=0;q<A.length;q++){let Z=A[q],X=e.getContext(Z,z);if(X!==null)return X}return null}try{let A={alpha:!0,depth:i,stencil:r,antialias:a,premultipliedAlpha:c,preserveDrawingBuffer:l,powerPreference:h,failIfMajorPerformanceCaveat:u};if("setAttribute"in e&&e.setAttribute("data-engine","three.js r160"),e.addEventListener("webglcontextlost",ut,!1),e.addEventListener("webglcontextrestored",I,!1),e.addEventListener("webglcontextcreationerror",mt,!1),U===null){let z=["webgl2","webgl","experimental-webgl"];if(_.isWebGL1Renderer===!0&&z.shift(),U=bt(z,A),U===null)throw bt(z)?new Error("Error creating WebGL context with your selected attributes."):new Error("Error creating WebGL context.")}typeof WebGLRenderingContext<"u"&&U instanceof WebGLRenderingContext&&console.warn("THREE.WebGLRenderer: WebGL 1 support was deprecated in r153 and will be removed in r163."),U.getShaderPrecisionFormat===void 0&&(U.getShaderPrecisionFormat=function(){return{rangeMin:1,rangeMax:1,precision:1}})}catch(A){throw console.error("THREE.WebGLRenderer: "+A.message),A}let et,at,it,wt,Mt,E,M,O,tt,j,Q,_t,ft,yt,At,Ut,st,Xt,Ft,Ct,Tt,rt,St,Wt;function jt(){et=new Ff(U),at=new Pf(U,et,t),et.init(at),rt=new pm(U,et,at),it=new dm(U,et,at),wt=new zf(U),Mt=new tm,E=new fm(U,et,it,Mt,at,rt,wt),M=new If(_),O=new Nf(_),tt=new qh(U,at),St=new Cf(U,et,tt,at),j=new Of(U,tt,wt,St),Q=new Gf(U,j,tt,wt),Ft=new Hf(U,at,E),Ut=new Lf(Mt),_t=new Qp(_,M,O,et,at,St,Ut),ft=new gm(_,Mt),yt=new nm,At=new cm(et,at),Xt=new Tf(_,M,O,it,Q,d,c),st=new um(_,Q,at),Wt=new _m(U,wt,at,it),Ct=new Rf(U,et,wt,at),Tt=new Bf(U,et,wt,at),wt.programs=_t.programs,_.capabilities=at,_.extensions=et,_.properties=Mt,_.renderLists=yt,_.shadowMap=st,_.state=it,_.info=wt}jt();let Ot=new So(_,U);this.xr=Ot,this.getContext=function(){return U},this.getContextAttributes=function(){return U.getContextAttributes()},this.forceContextLoss=function(){let A=et.get("WEBGL_lose_context");A&&A.loseContext()},this.forceContextRestore=function(){let A=et.get("WEBGL_lose_context");A&&A.restoreContext()},this.getPixelRatio=function(){return k},this.setPixelRatio=function(A){A!==void 0&&(k=A,this.setSize(D,H,!1))},this.getSize=function(A){return A.set(D,H)},this.setSize=function(A,z,q=!0){if(Ot.isPresenting){console.warn("THREE.WebGLRenderer: Can't change size while VR device is presenting.");return}D=A,H=z,e.width=Math.floor(A*k),e.height=Math.floor(z*k),q===!0&&(e.style.width=A+"px",e.style.height=z+"px"),this.setViewport(0,0,A,z)},this.getDrawingBufferSize=function(A){return A.set(D*k,H*k).floor()},this.setDrawingBufferSize=function(A,z,q){D=A,H=z,k=q,e.width=Math.floor(A*q),e.height=Math.floor(z*q),this.setViewport(0,0,A,z)},this.getCurrentViewport=function(A){return A.copy(w)},this.getViewport=function(A){return A.copy(K)},this.setViewport=function(A,z,q,Z){A.isVector4?K.set(A.x,A.y,A.z,A.w):K.set(A,z,q,Z),it.viewport(w.copy(K).multiplyScalar(k).floor())},this.getScissor=function(A){return A.copy($)},this.setScissor=function(A,z,q,Z){A.isVector4?$.set(A.x,A.y,A.z,A.w):$.set(A,z,q,Z),it.scissor(F.copy($).multiplyScalar(k).floor())},this.getScissorTest=function(){return ct},this.setScissorTest=function(A){it.setScissorTest(ct=A)},this.setOpaqueSort=function(A){N=A},this.setTransparentSort=function(A){V=A},this.getClearColor=function(A){return A.copy(Xt.getClearColor())},this.setClearColor=function(){Xt.setClearColor.apply(Xt,arguments)},this.getClearAlpha=function(){return Xt.getClearAlpha()},this.setClearAlpha=function(){Xt.setClearAlpha.apply(Xt,arguments)},this.clear=function(A=!0,z=!0,q=!0){let Z=0;if(A){let X=!1;if(C!==null){let vt=C.texture.format;X=vt===Wc||vt===Gc||vt===Hc}if(X){let vt=C.texture.type,Et=vt===vn||vt===pn||vt===ko||vt===Nn||vt===kc||vt===Vc,Pt=Xt.getClearColor(),Dt=Xt.getClearAlpha(),Vt=Pt.r,Nt=Pt.g,Bt=Pt.b;Et?(m[0]=Vt,m[1]=Nt,m[2]=Bt,m[3]=Dt,U.clearBufferuiv(U.COLOR,0,m)):(v[0]=Vt,v[1]=Nt,v[2]=Bt,v[3]=Dt,U.clearBufferiv(U.COLOR,0,v))}else Z|=U.COLOR_BUFFER_BIT}z&&(Z|=U.DEPTH_BUFFER_BIT),q&&(Z|=U.STENCIL_BUFFER_BIT,this.state.buffers.stencil.setMask(4294967295)),U.clear(Z)},this.clearColor=function(){this.clear(!0,!1,!1)},this.clearDepth=function(){this.clear(!1,!0,!1)},this.clearStencil=function(){this.clear(!1,!1,!0)},this.dispose=function(){e.removeEventListener("webglcontextlost",ut,!1),e.removeEventListener("webglcontextrestored",I,!1),e.removeEventListener("webglcontextcreationerror",mt,!1),yt.dispose(),At.dispose(),Mt.dispose(),M.dispose(),O.dispose(),Q.dispose(),St.dispose(),Wt.dispose(),_t.dispose(),Ot.dispose(),Ot.removeEventListener("sessionstart",ve),Ot.removeEventListener("sessionend",$t),nt&&(nt.dispose(),nt=null),xe.stop()};function ut(A){A.preventDefault(),console.log("THREE.WebGLRenderer: Context Lost."),b=!0}function I(){console.log("THREE.WebGLRenderer: Context Restored."),b=!1;let A=wt.autoReset,z=st.enabled,q=st.autoUpdate,Z=st.needsUpdate,X=st.type;jt(),wt.autoReset=A,st.enabled=z,st.autoUpdate=q,st.needsUpdate=Z,st.type=X}function mt(A){console.error("THREE.WebGLRenderer: A WebGL context could not be created. Reason: ",A.statusMessage)}function gt(A){let z=A.target;z.removeEventListener("dispose",gt),It(z)}function It(A){Rt(A),Mt.remove(A)}function Rt(A){let z=Mt.get(A).programs;z!==void 0&&(z.forEach(function(q){_t.releaseProgram(q)}),A.isShaderMaterial&&_t.releaseShaderCache(A))}this.renderBufferDirect=function(A,z,q,Z,X,vt){z===null&&(z=lt);let Et=X.isMesh&&X.matrixWorld.determinant()<0,Pt=xl(A,z,q,Z,X);it.setMaterial(Z,Et);let Dt=q.index,Vt=1;if(Z.wireframe===!0){if(Dt=j.getWireframeAttribute(q),Dt===void 0)return;Vt=2}let Nt=q.drawRange,Bt=q.attributes.position,se=Nt.start*Vt,Te=(Nt.start+Nt.count)*Vt;vt!==null&&(se=Math.max(se,vt.start*Vt),Te=Math.min(Te,(vt.start+vt.count)*Vt)),Dt!==null?(se=Math.max(se,0),Te=Math.min(Te,Dt.count)):Bt!=null&&(se=Math.max(se,0),Te=Math.min(Te,Bt.count));let he=Te-se;if(he<0||he===1/0)return;St.setup(X,Z,Pt,q,Dt);let Xe,ne=Ct;if(Dt!==null&&(Xe=tt.get(Dt),ne=Tt,ne.setIndex(Xe)),X.isMesh)Z.wireframe===!0?(it.setLineWidth(Z.wireframeLinewidth*pt()),ne.setMode(U.LINES)):ne.setMode(U.TRIANGLES);else if(X.isLine){let Ht=Z.linewidth;Ht===void 0&&(Ht=1),it.setLineWidth(Ht*pt()),X.isLineSegments?ne.setMode(U.LINES):X.isLineLoop?ne.setMode(U.LINE_LOOP):ne.setMode(U.LINE_STRIP)}else X.isPoints?ne.setMode(U.POINTS):X.isSprite&&ne.setMode(U.TRIANGLES);if(X.isBatchedMesh)ne.renderMultiDraw(X._multiDrawStarts,X._multiDrawCounts,X._multiDrawCount);else if(X.isInstancedMesh)ne.renderInstances(se,he,X.count);else if(q.isInstancedBufferGeometry){let Ht=q._maxInstanceCount!==void 0?q._maxInstanceCount:1/0,mr=Math.min(q.instanceCount,Ht);ne.renderInstances(se,he,mr)}else ne.render(se,he)};function Jt(A,z,q){A.transparent===!0&&A.side===Qe&&A.forceSinglePass===!1?(A.side=Ee,A.needsUpdate=!0,is(A,z,q),A.side=yn,A.needsUpdate=!0,is(A,z,q),A.side=Qe):is(A,z,q)}this.compile=function(A,z,q=null){q===null&&(q=A),p=At.get(q),p.init(),g.push(p),q.traverseVisible(function(X){X.isLight&&X.layers.test(z.layers)&&(p.pushLight(X),X.castShadow&&p.pushShadow(X))}),A!==q&&A.traverseVisible(function(X){X.isLight&&X.layers.test(z.layers)&&(p.pushLight(X),X.castShadow&&p.pushShadow(X))}),p.setupLights(_._useLegacyLights);let Z=new Set;return A.traverse(function(X){let vt=X.material;if(vt)if(Array.isArray(vt))for(let Et=0;Et<vt.length;Et++){let Pt=vt[Et];Jt(Pt,q,X),Z.add(Pt)}else Jt(vt,q,X),Z.add(vt)}),g.pop(),p=null,Z},this.compileAsync=function(A,z,q=null){let Z=this.compile(A,z,q);return new Promise(X=>{function vt(){if(Z.forEach(function(Et){Mt.get(Et).currentProgram.isReady()&&Z.delete(Et)}),Z.size===0){X(A);return}setTimeout(vt,10)}et.get("KHR_parallel_shader_compile")!==null?vt():setTimeout(vt,10)})};let Kt=null;function le(A){Kt&&Kt(A)}function ve(){xe.stop()}function $t(){xe.start()}let xe=new $c;xe.setAnimationLoop(le),typeof self<"u"&&xe.setContext(self),this.setAnimationLoop=function(A){Kt=A,Ot.setAnimationLoop(A),A===null?xe.stop():xe.start()},Ot.addEventListener("sessionstart",ve),Ot.addEventListener("sessionend",$t),this.render=function(A,z){if(z!==void 0&&z.isCamera!==!0){console.error("THREE.WebGLRenderer.render: camera is not an instance of THREE.Camera.");return}if(b===!0)return;A.matrixWorldAutoUpdate===!0&&A.updateMatrixWorld(),z.parent===null&&z.matrixWorldAutoUpdate===!0&&z.updateMatrixWorld(),Ot.enabled===!0&&Ot.isPresenting===!0&&(Ot.cameraAutoUpdate===!0&&Ot.updateCamera(z),z=Ot.getCamera()),A.isScene===!0&&A.onBeforeRender(_,A,z,C),p=At.get(A,g.length),p.init(),g.push(p),ht.multiplyMatrices(z.projectionMatrix,z.matrixWorldInverse),G.setFromProjectionMatrix(ht),ot=this.localClippingEnabled,J=Ut.init(this.clippingPlanes,ot),x=yt.get(A,f.length),x.init(),f.push(x),Ge(A,z,0,_.sortObjects),x.finish(),_.sortObjects===!0&&x.sort(N,V),this.info.render.frame++,J===!0&&Ut.beginShadows();let q=p.state.shadowsArray;if(st.render(q,A,z),J===!0&&Ut.endShadows(),this.info.autoReset===!0&&this.info.reset(),Xt.render(x,A),p.setupLights(_._useLegacyLights),z.isArrayCamera){let Z=z.cameras;for(let X=0,vt=Z.length;X<vt;X++){let Et=Z[X];$o(x,A,Et,Et.viewport)}}else $o(x,A,z);C!==null&&(E.updateMultisampleRenderTarget(C),E.updateRenderTargetMipmap(C)),A.isScene===!0&&A.onAfterRender(_,A,z),St.resetDefaultState(),P=-1,y=null,g.pop(),g.length>0?p=g[g.length-1]:p=null,f.pop(),f.length>0?x=f[f.length-1]:x=null};function Ge(A,z,q,Z){if(A.visible===!1)return;if(A.layers.test(z.layers)){if(A.isGroup)q=A.renderOrder;else if(A.isLOD)A.autoUpdate===!0&&A.update(z);else if(A.isLight)p.pushLight(A),A.castShadow&&p.pushShadow(A);else if(A.isSprite){if(!A.frustumCulled||G.intersectsSprite(A)){Z&&Y.setFromMatrixPosition(A.matrixWorld).applyMatrix4(ht);let Et=Q.update(A),Pt=A.material;Pt.visible&&x.push(A,Et,Pt,q,Y.z,null)}}else if((A.isMesh||A.isLine||A.isPoints)&&(!A.frustumCulled||G.intersectsObject(A))){let Et=Q.update(A),Pt=A.material;if(Z&&(A.boundingSphere!==void 0?(A.boundingSphere===null&&A.computeBoundingSphere(),Y.copy(A.boundingSphere.center)):(Et.boundingSphere===null&&Et.computeBoundingSphere(),Y.copy(Et.boundingSphere.center)),Y.applyMatrix4(A.matrixWorld).applyMatrix4(ht)),Array.isArray(Pt)){let Dt=Et.groups;for(let Vt=0,Nt=Dt.length;Vt<Nt;Vt++){let Bt=Dt[Vt],se=Pt[Bt.materialIndex];se&&se.visible&&x.push(A,Et,se,q,Y.z,Bt)}}else Pt.visible&&x.push(A,Et,Pt,q,Y.z,null)}}let vt=A.children;for(let Et=0,Pt=vt.length;Et<Pt;Et++)Ge(vt[Et],z,q,Z)}function $o(A,z,q,Z){let X=A.opaque,vt=A.transmissive,Et=A.transparent;p.setupLightsView(q),J===!0&&Ut.setGlobalState(_.clippingPlanes,q),vt.length>0&&vl(X,vt,z,q),Z&&it.viewport(w.copy(Z)),X.length>0&&ns(X,z,q),vt.length>0&&ns(vt,z,q),Et.length>0&&ns(Et,z,q),it.buffers.depth.setTest(!0),it.buffers.depth.setMask(!0),it.buffers.color.setMask(!0),it.setPolygonOffset(!1)}function vl(A,z,q,Z){if((q.isScene===!0?q.overrideMaterial:null)!==null)return;let vt=at.isWebGL2;nt===null&&(nt=new sn(1,1,{generateMipmaps:!0,type:et.has("EXT_color_buffer_half_float")?Hi:vn,minFilter:Vi,samples:vt?4:0})),_.getDrawingBufferSize(xt),vt?nt.setSize(xt.x,xt.y):nt.setSize(ao(xt.x),ao(xt.y));let Et=_.getRenderTarget();_.setRenderTarget(nt),_.getClearColor(W),R=_.getClearAlpha(),R<1&&_.setClearColor(16777215,.5),_.clear();let Pt=_.toneMapping;_.toneMapping=_n,ns(A,q,Z),E.updateMultisampleRenderTarget(nt),E.updateRenderTargetMipmap(nt);let Dt=!1;for(let Vt=0,Nt=z.length;Vt<Nt;Vt++){let Bt=z[Vt],se=Bt.object,Te=Bt.geometry,he=Bt.material,Xe=Bt.group;if(he.side===Qe&&se.layers.test(Z.layers)){let ne=he.side;he.side=Ee,he.needsUpdate=!0,jo(se,q,Z,Te,he,Xe),he.side=ne,he.needsUpdate=!0,Dt=!0}}Dt===!0&&(E.updateMultisampleRenderTarget(nt),E.updateRenderTargetMipmap(nt)),_.setRenderTarget(Et),_.setClearColor(W,R),_.toneMapping=Pt}function ns(A,z,q){let Z=z.isScene===!0?z.overrideMaterial:null;for(let X=0,vt=A.length;X<vt;X++){let Et=A[X],Pt=Et.object,Dt=Et.geometry,Vt=Z===null?Et.material:Z,Nt=Et.group;Pt.layers.test(q.layers)&&jo(Pt,z,q,Dt,Vt,Nt)}}function jo(A,z,q,Z,X,vt){A.onBeforeRender(_,z,q,Z,X,vt),A.modelViewMatrix.multiplyMatrices(q.matrixWorldInverse,A.matrixWorld),A.normalMatrix.getNormalMatrix(A.modelViewMatrix),X.onBeforeRender(_,z,q,Z,A,vt),X.transparent===!0&&X.side===Qe&&X.forceSinglePass===!1?(X.side=Ee,X.needsUpdate=!0,_.renderBufferDirect(q,z,Z,X,A,vt),X.side=yn,X.needsUpdate=!0,_.renderBufferDirect(q,z,Z,X,A,vt),X.side=Qe):_.renderBufferDirect(q,z,Z,X,A,vt),A.onAfterRender(_,z,q,Z,X,vt)}function is(A,z,q){z.isScene!==!0&&(z=lt);let Z=Mt.get(A),X=p.state.lights,vt=p.state.shadowsArray,Et=X.state.version,Pt=_t.getParameters(A,X.state,vt,z,q),Dt=_t.getProgramCacheKey(Pt),Vt=Z.programs;Z.environment=A.isMeshStandardMaterial?z.environment:null,Z.fog=z.fog,Z.envMap=(A.isMeshStandardMaterial?O:M).get(A.envMap||Z.environment),Vt===void 0&&(A.addEventListener("dispose",gt),Vt=new Map,Z.programs=Vt);let Nt=Vt.get(Dt);if(Nt!==void 0){if(Z.currentProgram===Nt&&Z.lightsStateVersion===Et)return ta(A,Pt),Nt}else Pt.uniforms=_t.getUniforms(A),A.onBuild(q,Pt,_),A.onBeforeCompile(Pt,_),Nt=_t.acquireProgram(Pt,Dt),Vt.set(Dt,Nt),Z.uniforms=Pt.uniforms;let Bt=Z.uniforms;return(!A.isShaderMaterial&&!A.isRawShaderMaterial||A.clipping===!0)&&(Bt.clippingPlanes=Ut.uniform),ta(A,Pt),Z.needsLights=Ml(A),Z.lightsStateVersion=Et,Z.needsLights&&(Bt.ambientLightColor.value=X.state.ambient,Bt.lightProbe.value=X.state.probe,Bt.directionalLights.value=X.state.directional,Bt.directionalLightShadows.value=X.state.directionalShadow,Bt.spotLights.value=X.state.spot,Bt.spotLightShadows.value=X.state.spotShadow,Bt.rectAreaLights.value=X.state.rectArea,Bt.ltc_1.value=X.state.rectAreaLTC1,Bt.ltc_2.value=X.state.rectAreaLTC2,Bt.pointLights.value=X.state.point,Bt.pointLightShadows.value=X.state.pointShadow,Bt.hemisphereLights.value=X.state.hemi,Bt.directionalShadowMap.value=X.state.directionalShadowMap,Bt.directionalShadowMatrix.value=X.state.directionalShadowMatrix,Bt.spotShadowMap.value=X.state.spotShadowMap,Bt.spotLightMatrix.value=X.state.spotLightMatrix,Bt.spotLightMap.value=X.state.spotLightMap,Bt.pointShadowMap.value=X.state.pointShadowMap,Bt.pointShadowMatrix.value=X.state.pointShadowMatrix),Z.currentProgram=Nt,Z.uniformsList=null,Nt}function Qo(A){if(A.uniformsList===null){let z=A.currentProgram.getUniforms();A.uniformsList=pi.seqWithValue(z.seq,A.uniforms)}return A.uniformsList}function ta(A,z){let q=Mt.get(A);q.outputColorSpace=z.outputColorSpace,q.batching=z.batching,q.instancing=z.instancing,q.instancingColor=z.instancingColor,q.skinning=z.skinning,q.morphTargets=z.morphTargets,q.morphNormals=z.morphNormals,q.morphColors=z.morphColors,q.morphTargetsCount=z.morphTargetsCount,q.numClippingPlanes=z.numClippingPlanes,q.numIntersection=z.numClipIntersection,q.vertexAlphas=z.vertexAlphas,q.vertexTangents=z.vertexTangents,q.toneMapping=z.toneMapping}function xl(A,z,q,Z,X){z.isScene!==!0&&(z=lt),E.resetTextureUnits();let vt=z.fog,Et=Z.isMeshStandardMaterial?z.environment:null,Pt=C===null?_.outputColorSpace:C.isXRRenderTarget===!0?C.texture.colorSpace:nn,Dt=(Z.isMeshStandardMaterial?O:M).get(Z.envMap||Et),Vt=Z.vertexColors===!0&&!!q.attributes.color&&q.attributes.color.itemSize===4,Nt=!!q.attributes.tangent&&(!!Z.normalMap||Z.anisotropy>0),Bt=!!q.morphAttributes.position,se=!!q.morphAttributes.normal,Te=!!q.morphAttributes.color,he=_n;Z.toneMapped&&(C===null||C.isXRRenderTarget===!0)&&(he=_.toneMapping);let Xe=q.morphAttributes.position||q.morphAttributes.normal||q.morphAttributes.color,ne=Xe!==void 0?Xe.length:0,Ht=Mt.get(Z),mr=p.state.lights;if(J===!0&&(ot===!0||A!==y)){let Pe=A===y&&Z.id===P;Ut.setState(Z,A,Pe)}let ie=!1;Z.version===Ht.__version?(Ht.needsLights&&Ht.lightsStateVersion!==mr.state.version||Ht.outputColorSpace!==Pt||X.isBatchedMesh&&Ht.batching===!1||!X.isBatchedMesh&&Ht.batching===!0||X.isInstancedMesh&&Ht.instancing===!1||!X.isInstancedMesh&&Ht.instancing===!0||X.isSkinnedMesh&&Ht.skinning===!1||!X.isSkinnedMesh&&Ht.skinning===!0||X.isInstancedMesh&&Ht.instancingColor===!0&&X.instanceColor===null||X.isInstancedMesh&&Ht.instancingColor===!1&&X.instanceColor!==null||Ht.envMap!==Dt||Z.fog===!0&&Ht.fog!==vt||Ht.numClippingPlanes!==void 0&&(Ht.numClippingPlanes!==Ut.numPlanes||Ht.numIntersection!==Ut.numIntersection)||Ht.vertexAlphas!==Vt||Ht.vertexTangents!==Nt||Ht.morphTargets!==Bt||Ht.morphNormals!==se||Ht.morphColors!==Te||Ht.toneMapping!==he||at.isWebGL2===!0&&Ht.morphTargetsCount!==ne)&&(ie=!0):(ie=!0,Ht.__version=Z.version);let En=Ht.currentProgram;ie===!0&&(En=is(Z,z,X));let ea=!1,Ri=!1,gr=!1,me=En.getUniforms(),An=Ht.uniforms;if(it.useProgram(En.program)&&(ea=!0,Ri=!0,gr=!0),Z.id!==P&&(P=Z.id,Ri=!0),ea||y!==A){me.setValue(U,"projectionMatrix",A.projectionMatrix),me.setValue(U,"viewMatrix",A.matrixWorldInverse);let Pe=me.map.cameraPosition;Pe!==void 0&&Pe.setValue(U,Y.setFromMatrixPosition(A.matrixWorld)),at.logarithmicDepthBuffer&&me.setValue(U,"logDepthBufFC",2/(Math.log(A.far+1)/Math.LN2)),(Z.isMeshPhongMaterial||Z.isMeshToonMaterial||Z.isMeshLambertMaterial||Z.isMeshBasicMaterial||Z.isMeshStandardMaterial||Z.isShaderMaterial)&&me.setValue(U,"isOrthographic",A.isOrthographicCamera===!0),y!==A&&(y=A,Ri=!0,gr=!0)}if(X.isSkinnedMesh){me.setOptional(U,X,"bindMatrix"),me.setOptional(U,X,"bindMatrixInverse");let Pe=X.skeleton;Pe&&(at.floatVertexTextures?(Pe.boneTexture===null&&Pe.computeBoneTexture(),me.setValue(U,"boneTexture",Pe.boneTexture,E)):console.warn("THREE.WebGLRenderer: SkinnedMesh can only be used with WebGL 2. With WebGL 1 OES_texture_float and vertex textures support is required."))}X.isBatchedMesh&&(me.setOptional(U,X,"batchingTexture"),me.setValue(U,"batchingTexture",X._matricesTexture,E));let _r=q.morphAttributes;if((_r.position!==void 0||_r.normal!==void 0||_r.color!==void 0&&at.isWebGL2===!0)&&Ft.update(X,q,En),(Ri||Ht.receiveShadow!==X.receiveShadow)&&(Ht.receiveShadow=X.receiveShadow,me.setValue(U,"receiveShadow",X.receiveShadow)),Z.isMeshGouraudMaterial&&Z.envMap!==null&&(An.envMap.value=Dt,An.flipEnvMap.value=Dt.isCubeTexture&&Dt.isRenderTargetTexture===!1?-1:1),Ri&&(me.setValue(U,"toneMappingExposure",_.toneMappingExposure),Ht.needsLights&&yl(An,gr),vt&&Z.fog===!0&&ft.refreshFogUniforms(An,vt),ft.refreshMaterialUniforms(An,Z,k,H,nt),pi.upload(U,Qo(Ht),An,E)),Z.isShaderMaterial&&Z.uniformsNeedUpdate===!0&&(pi.upload(U,Qo(Ht),An,E),Z.uniformsNeedUpdate=!1),Z.isSpriteMaterial&&me.setValue(U,"center",X.center),me.setValue(U,"modelViewMatrix",X.modelViewMatrix),me.setValue(U,"normalMatrix",X.normalMatrix),me.setValue(U,"modelMatrix",X.matrixWorld),Z.isShaderMaterial||Z.isRawShaderMaterial){let Pe=Z.uniformsGroups;for(let vr=0,bl=Pe.length;vr<bl;vr++)if(at.isWebGL2){let na=Pe[vr];Wt.update(na,En),Wt.bind(na,En)}else console.warn("THREE.WebGLRenderer: Uniform Buffer Objects can only be used with WebGL 2.")}return En}function yl(A,z){A.ambientLightColor.needsUpdate=z,A.lightProbe.needsUpdate=z,A.directionalLights.needsUpdate=z,A.directionalLightShadows.needsUpdate=z,A.pointLights.needsUpdate=z,A.pointLightShadows.needsUpdate=z,A.spotLights.needsUpdate=z,A.spotLightShadows.needsUpdate=z,A.rectAreaLights.needsUpdate=z,A.hemisphereLights.needsUpdate=z}function Ml(A){return A.isMeshLambertMaterial||A.isMeshToonMaterial||A.isMeshPhongMaterial||A.isMeshStandardMaterial||A.isShadowMaterial||A.isShaderMaterial&&A.lights===!0}this.getActiveCubeFace=function(){return S},this.getActiveMipmapLevel=function(){return T},this.getRenderTarget=function(){return C},this.setRenderTargetTextures=function(A,z,q){Mt.get(A.texture).__webglTexture=z,Mt.get(A.depthTexture).__webglTexture=q;let Z=Mt.get(A);Z.__hasExternalTextures=!0,Z.__hasExternalTextures&&(Z.__autoAllocateDepthBuffer=q===void 0,Z.__autoAllocateDepthBuffer||et.has("WEBGL_multisampled_render_to_texture")===!0&&(console.warn("THREE.WebGLRenderer: Render-to-texture extension was disabled because an external texture was provided"),Z.__useRenderToTexture=!1))},this.setRenderTargetFramebuffer=function(A,z){let q=Mt.get(A);q.__webglFramebuffer=z,q.__useDefaultFramebuffer=z===void 0},this.setRenderTarget=function(A,z=0,q=0){C=A,S=z,T=q;let Z=!0,X=null,vt=!1,Et=!1;if(A){let Dt=Mt.get(A);Dt.__useDefaultFramebuffer!==void 0?(it.bindFramebuffer(U.FRAMEBUFFER,null),Z=!1):Dt.__webglFramebuffer===void 0?E.setupRenderTarget(A):Dt.__hasExternalTextures&&E.rebindTextures(A,Mt.get(A.texture).__webglTexture,Mt.get(A.depthTexture).__webglTexture);let Vt=A.texture;(Vt.isData3DTexture||Vt.isDataArrayTexture||Vt.isCompressedArrayTexture)&&(Et=!0);let Nt=Mt.get(A).__webglFramebuffer;A.isWebGLCubeRenderTarget?(Array.isArray(Nt[z])?X=Nt[z][q]:X=Nt[z],vt=!0):at.isWebGL2&&A.samples>0&&E.useMultisampledRTT(A)===!1?X=Mt.get(A).__webglMultisampledFramebuffer:Array.isArray(Nt)?X=Nt[q]:X=Nt,w.copy(A.viewport),F.copy(A.scissor),B=A.scissorTest}else w.copy(K).multiplyScalar(k).floor(),F.copy($).multiplyScalar(k).floor(),B=ct;if(it.bindFramebuffer(U.FRAMEBUFFER,X)&&at.drawBuffers&&Z&&it.drawBuffers(A,X),it.viewport(w),it.scissor(F),it.setScissorTest(B),vt){let Dt=Mt.get(A.texture);U.framebufferTexture2D(U.FRAMEBUFFER,U.COLOR_ATTACHMENT0,U.TEXTURE_CUBE_MAP_POSITIVE_X+z,Dt.__webglTexture,q)}else if(Et){let Dt=Mt.get(A.texture),Vt=z||0;U.framebufferTextureLayer(U.FRAMEBUFFER,U.COLOR_ATTACHMENT0,Dt.__webglTexture,q||0,Vt)}P=-1},this.readRenderTargetPixels=function(A,z,q,Z,X,vt,Et){if(!(A&&A.isWebGLRenderTarget)){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not THREE.WebGLRenderTarget.");return}let Pt=Mt.get(A).__webglFramebuffer;if(A.isWebGLCubeRenderTarget&&Et!==void 0&&(Pt=Pt[Et]),Pt){it.bindFramebuffer(U.FRAMEBUFFER,Pt);try{let Dt=A.texture,Vt=Dt.format,Nt=Dt.type;if(Vt!==Ve&&rt.convert(Vt)!==U.getParameter(U.IMPLEMENTATION_COLOR_READ_FORMAT)){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not in RGBA or implementation defined format.");return}let Bt=Nt===Hi&&(et.has("EXT_color_buffer_half_float")||at.isWebGL2&&et.has("EXT_color_buffer_float"));if(Nt!==vn&&rt.convert(Nt)!==U.getParameter(U.IMPLEMENTATION_COLOR_READ_TYPE)&&!(Nt===mn&&(at.isWebGL2||et.has("OES_texture_float")||et.has("WEBGL_color_buffer_float")))&&!Bt){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not in UnsignedByteType or implementation defined type.");return}z>=0&&z<=A.width-Z&&q>=0&&q<=A.height-X&&U.readPixels(z,q,Z,X,rt.convert(Vt),rt.convert(Nt),vt)}finally{let Dt=C!==null?Mt.get(C).__webglFramebuffer:null;it.bindFramebuffer(U.FRAMEBUFFER,Dt)}}},this.copyFramebufferToTexture=function(A,z,q=0){let Z=Math.pow(2,-q),X=Math.floor(z.image.width*Z),vt=Math.floor(z.image.height*Z);E.setTexture2D(z,0),U.copyTexSubImage2D(U.TEXTURE_2D,q,0,0,A.x,A.y,X,vt),it.unbindTexture()},this.copyTextureToTexture=function(A,z,q,Z=0){let X=z.image.width,vt=z.image.height,Et=rt.convert(q.format),Pt=rt.convert(q.type);E.setTexture2D(q,0),U.pixelStorei(U.UNPACK_FLIP_Y_WEBGL,q.flipY),U.pixelStorei(U.UNPACK_PREMULTIPLY_ALPHA_WEBGL,q.premultiplyAlpha),U.pixelStorei(U.UNPACK_ALIGNMENT,q.unpackAlignment),z.isDataTexture?U.texSubImage2D(U.TEXTURE_2D,Z,A.x,A.y,X,vt,Et,Pt,z.image.data):z.isCompressedTexture?U.compressedTexSubImage2D(U.TEXTURE_2D,Z,A.x,A.y,z.mipmaps[0].width,z.mipmaps[0].height,Et,z.mipmaps[0].data):U.texSubImage2D(U.TEXTURE_2D,Z,A.x,A.y,Et,Pt,z.image),Z===0&&q.generateMipmaps&&U.generateMipmap(U.TEXTURE_2D),it.unbindTexture()},this.copyTextureToTexture3D=function(A,z,q,Z,X=0){if(_.isWebGL1Renderer){console.warn("THREE.WebGLRenderer.copyTextureToTexture3D: can only be used with WebGL2.");return}let vt=A.max.x-A.min.x+1,Et=A.max.y-A.min.y+1,Pt=A.max.z-A.min.z+1,Dt=rt.convert(Z.format),Vt=rt.convert(Z.type),Nt;if(Z.isData3DTexture)E.setTexture3D(Z,0),Nt=U.TEXTURE_3D;else if(Z.isDataArrayTexture||Z.isCompressedArrayTexture)E.setTexture2DArray(Z,0),Nt=U.TEXTURE_2D_ARRAY;else{console.warn("THREE.WebGLRenderer.copyTextureToTexture3D: only supports THREE.DataTexture3D and THREE.DataTexture2DArray.");return}U.pixelStorei(U.UNPACK_FLIP_Y_WEBGL,Z.flipY),U.pixelStorei(U.UNPACK_PREMULTIPLY_ALPHA_WEBGL,Z.premultiplyAlpha),U.pixelStorei(U.UNPACK_ALIGNMENT,Z.unpackAlignment);let Bt=U.getParameter(U.UNPACK_ROW_LENGTH),se=U.getParameter(U.UNPACK_IMAGE_HEIGHT),Te=U.getParameter(U.UNPACK_SKIP_PIXELS),he=U.getParameter(U.UNPACK_SKIP_ROWS),Xe=U.getParameter(U.UNPACK_SKIP_IMAGES),ne=q.isCompressedTexture?q.mipmaps[X]:q.image;U.pixelStorei(U.UNPACK_ROW_LENGTH,ne.width),U.pixelStorei(U.UNPACK_IMAGE_HEIGHT,ne.height),U.pixelStorei(U.UNPACK_SKIP_PIXELS,A.min.x),U.pixelStorei(U.UNPACK_SKIP_ROWS,A.min.y),U.pixelStorei(U.UNPACK_SKIP_IMAGES,A.min.z),q.isDataTexture||q.isData3DTexture?U.texSubImage3D(Nt,X,z.x,z.y,z.z,vt,Et,Pt,Dt,Vt,ne.data):q.isCompressedArrayTexture?(console.warn("THREE.WebGLRenderer.copyTextureToTexture3D: untested support for compressed srcTexture."),U.compressedTexSubImage3D(Nt,X,z.x,z.y,z.z,vt,Et,Pt,Dt,ne.data)):U.texSubImage3D(Nt,X,z.x,z.y,z.z,vt,Et,Pt,Dt,Vt,ne),U.pixelStorei(U.UNPACK_ROW_LENGTH,Bt),U.pixelStorei(U.UNPACK_IMAGE_HEIGHT,se),U.pixelStorei(U.UNPACK_SKIP_PIXELS,Te),U.pixelStorei(U.UNPACK_SKIP_ROWS,he),U.pixelStorei(U.UNPACK_SKIP_IMAGES,Xe),X===0&&Z.generateMipmaps&&U.generateMipmap(Nt),it.unbindTexture()},this.initTexture=function(A){A.isCubeTexture?E.setTextureCube(A,0):A.isData3DTexture?E.setTexture3D(A,0):A.isDataArrayTexture||A.isCompressedArrayTexture?E.setTexture2DArray(A,0):E.setTexture2D(A,0),it.unbindTexture()},this.resetState=function(){S=0,T=0,C=null,it.reset(),St.reset()},typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}get coordinateSystem(){return en}get outputColorSpace(){return this._outputColorSpace}set outputColorSpace(t){this._outputColorSpace=t;let e=this.getContext();e.drawingBufferColorSpace=t===Vo?"display-p3":"srgb",e.unpackColorSpace=qt.workingColorSpace===ir?"display-p3":"srgb"}get outputEncoding(){return console.warn("THREE.WebGLRenderer: Property .outputEncoding has been removed. Use .outputColorSpace instead."),this.outputColorSpace===oe?On:qc}set outputEncoding(t){console.warn("THREE.WebGLRenderer: Property .outputEncoding has been removed. Use .outputColorSpace instead."),this.outputColorSpace=t===On?oe:nn}get useLegacyLights(){return console.warn("THREE.WebGLRenderer: The property .useLegacyLights has been deprecated. Migrate your lighting according to the following guide: https://discourse.threejs.org/t/updates-to-lighting-in-three-js-r155/53733."),this._useLegacyLights}set useLegacyLights(t){console.warn("THREE.WebGLRenderer: The property .useLegacyLights has been deprecated. Migrate your lighting according to the following guide: https://discourse.threejs.org/t/updates-to-lighting-in-three-js-r155/53733."),this._useLegacyLights=t}},wo=class extends Xi{};wo.prototype.isWebGL1Renderer=!0;var qi=class s{constructor(t,e=1,n=1e3){this.isFog=!0,this.name="",this.color=new zt(t),this.near=e,this.far=n}clone(){return new s(this.color,this.near,this.far)}toJSON(){return{type:"Fog",name:this.name,color:this.color.getHex(),near:this.near,far:this.far}}},bi=class extends fe{constructor(){super(),this.isScene=!0,this.type="Scene",this.background=null,this.environment=null,this.fog=null,this.backgroundBlurriness=0,this.backgroundIntensity=1,this.overrideMaterial=null,typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}copy(t,e){return super.copy(t,e),t.background!==null&&(this.background=t.background.clone()),t.environment!==null&&(this.environment=t.environment.clone()),t.fog!==null&&(this.fog=t.fog.clone()),this.backgroundBlurriness=t.backgroundBlurriness,this.backgroundIntensity=t.backgroundIntensity,t.overrideMaterial!==null&&(this.overrideMaterial=t.overrideMaterial.clone()),this.matrixAutoUpdate=t.matrixAutoUpdate,this}toJSON(t){let e=super.toJSON(t);return this.fog!==null&&(e.object.fog=this.fog.toJSON()),this.backgroundBlurriness>0&&(e.object.backgroundBlurriness=this.backgroundBlurriness),this.backgroundIntensity!==1&&(e.object.backgroundIntensity=this.backgroundIntensity),e}},Eo=class{constructor(t,e){this.isInterleavedBuffer=!0,this.array=t,this.stride=e,this.count=t!==void 0?t.length/e:0,this.usage=so,this._updateRange={offset:0,count:-1},this.updateRanges=[],this.version=0,this.uuid=xn()}onUploadCallback(){}set needsUpdate(t){t===!0&&this.version++}get updateRange(){return console.warn("THREE.InterleavedBuffer: updateRange() is deprecated and will be removed in r169. Use addUpdateRange() instead."),this._updateRange}setUsage(t){return this.usage=t,this}addUpdateRange(t,e){this.updateRanges.push({start:t,count:e})}clearUpdateRanges(){this.updateRanges.length=0}copy(t){return this.array=new t.array.constructor(t.array),this.count=t.count,this.stride=t.stride,this.usage=t.usage,this}copyAt(t,e,n){t*=this.stride,n*=e.stride;for(let i=0,r=this.stride;i<r;i++)this.array[t+i]=e.array[n+i];return this}set(t,e=0){return this.array.set(t,e),this}clone(t){t.arrayBuffers===void 0&&(t.arrayBuffers={}),this.array.buffer._uuid===void 0&&(this.array.buffer._uuid=xn()),t.arrayBuffers[this.array.buffer._uuid]===void 0&&(t.arrayBuffers[this.array.buffer._uuid]=this.array.slice(0).buffer);let e=new this.array.constructor(t.arrayBuffers[this.array.buffer._uuid]),n=new this.constructor(e,this.stride);return n.setUsage(this.usage),n}onUpload(t){return this.onUploadCallback=t,this}toJSON(t){return t.arrayBuffers===void 0&&(t.arrayBuffers={}),this.array.buffer._uuid===void 0&&(this.array.buffer._uuid=xn()),t.arrayBuffers[this.array.buffer._uuid]===void 0&&(t.arrayBuffers[this.array.buffer._uuid]=Array.from(new Uint32Array(this.array.buffer))),{uuid:this.uuid,buffer:this.array.buffer._uuid,type:this.array.constructor.name,stride:this.stride}}},ye=new L,js=class s{constructor(t,e,n,i=!1){this.isInterleavedBufferAttribute=!0,this.name="",this.data=t,this.itemSize=e,this.offset=n,this.normalized=i}get count(){return this.data.count}get array(){return this.data.array}set needsUpdate(t){this.data.needsUpdate=t}applyMatrix4(t){for(let e=0,n=this.data.count;e<n;e++)ye.fromBufferAttribute(this,e),ye.applyMatrix4(t),this.setXYZ(e,ye.x,ye.y,ye.z);return this}applyNormalMatrix(t){for(let e=0,n=this.count;e<n;e++)ye.fromBufferAttribute(this,e),ye.applyNormalMatrix(t),this.setXYZ(e,ye.x,ye.y,ye.z);return this}transformDirection(t){for(let e=0,n=this.count;e<n;e++)ye.fromBufferAttribute(this,e),ye.transformDirection(t),this.setXYZ(e,ye.x,ye.y,ye.z);return this}setX(t,e){return this.normalized&&(e=Yt(e,this.array)),this.data.array[t*this.data.stride+this.offset]=e,this}setY(t,e){return this.normalized&&(e=Yt(e,this.array)),this.data.array[t*this.data.stride+this.offset+1]=e,this}setZ(t,e){return this.normalized&&(e=Yt(e,this.array)),this.data.array[t*this.data.stride+this.offset+2]=e,this}setW(t,e){return this.normalized&&(e=Yt(e,this.array)),this.data.array[t*this.data.stride+this.offset+3]=e,this}getX(t){let e=this.data.array[t*this.data.stride+this.offset];return this.normalized&&(e=tn(e,this.array)),e}getY(t){let e=this.data.array[t*this.data.stride+this.offset+1];return this.normalized&&(e=tn(e,this.array)),e}getZ(t){let e=this.data.array[t*this.data.stride+this.offset+2];return this.normalized&&(e=tn(e,this.array)),e}getW(t){let e=this.data.array[t*this.data.stride+this.offset+3];return this.normalized&&(e=tn(e,this.array)),e}setXY(t,e,n){return t=t*this.data.stride+this.offset,this.normalized&&(e=Yt(e,this.array),n=Yt(n,this.array)),this.data.array[t+0]=e,this.data.array[t+1]=n,this}setXYZ(t,e,n,i){return t=t*this.data.stride+this.offset,this.normalized&&(e=Yt(e,this.array),n=Yt(n,this.array),i=Yt(i,this.array)),this.data.array[t+0]=e,this.data.array[t+1]=n,this.data.array[t+2]=i,this}setXYZW(t,e,n,i,r){return t=t*this.data.stride+this.offset,this.normalized&&(e=Yt(e,this.array),n=Yt(n,this.array),i=Yt(i,this.array),r=Yt(r,this.array)),this.data.array[t+0]=e,this.data.array[t+1]=n,this.data.array[t+2]=i,this.data.array[t+3]=r,this}clone(t){if(t===void 0){console.log("THREE.InterleavedBufferAttribute.clone(): Cloning an interleaved buffer attribute will de-interleave buffer data.");let e=[];for(let n=0;n<this.count;n++){let i=n*this.data.stride+this.offset;for(let r=0;r<this.itemSize;r++)e.push(this.data.array[i+r])}return new ee(new this.array.constructor(e),this.itemSize,this.normalized)}else return t.interleavedBuffers===void 0&&(t.interleavedBuffers={}),t.interleavedBuffers[this.data.uuid]===void 0&&(t.interleavedBuffers[this.data.uuid]=this.data.clone(t)),new s(t.interleavedBuffers[this.data.uuid],this.itemSize,this.offset,this.normalized)}toJSON(t){if(t===void 0){console.log("THREE.InterleavedBufferAttribute.toJSON(): Serializing an interleaved buffer attribute will de-interleave buffer data.");let e=[];for(let n=0;n<this.count;n++){let i=n*this.data.stride+this.offset;for(let r=0;r<this.itemSize;r++)e.push(this.data.array[i+r])}return{itemSize:this.itemSize,type:this.array.constructor.name,array:e,normalized:this.normalized}}else return t.interleavedBuffers===void 0&&(t.interleavedBuffers={}),t.interleavedBuffers[this.data.uuid]===void 0&&(t.interleavedBuffers[this.data.uuid]=this.data.toJSON(t)),{isInterleavedBufferAttribute:!0,itemSize:this.itemSize,data:this.data.uuid,offset:this.offset,normalized:this.normalized}}},Si=class extends an{constructor(t){super(),this.isSpriteMaterial=!0,this.type="SpriteMaterial",this.color=new zt(16777215),this.map=null,this.alphaMap=null,this.rotation=0,this.sizeAttenuation=!0,this.transparent=!0,this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.map=t.map,this.alphaMap=t.alphaMap,this.rotation=t.rotation,this.sizeAttenuation=t.sizeAttenuation,this.fog=t.fog,this}},si,Ui=new L,ri=new L,oi=new L,ai=new Lt,Ni=new Lt,il=new Zt,As=new L,Fi=new L,Ts=new L,wc=new Lt,Kr=new Lt,Ec=new Lt,Yi=class extends fe{constructor(t=new Si){if(super(),this.isSprite=!0,this.type="Sprite",si===void 0){si=new pe;let e=new Float32Array([-.5,-.5,0,0,0,.5,-.5,0,1,0,.5,.5,0,1,1,-.5,.5,0,0,1]),n=new Eo(e,5);si.setIndex([0,1,2,0,2,3]),si.setAttribute("position",new js(n,3,0,!1)),si.setAttribute("uv",new js(n,2,3,!1))}this.geometry=si,this.material=t,this.center=new Lt(.5,.5)}raycast(t,e){t.camera===null&&console.error('THREE.Sprite: "Raycaster.camera" needs to be set in order to raycast against sprites.'),ri.setFromMatrixScale(this.matrixWorld),il.copy(t.camera.matrixWorld),this.modelViewMatrix.multiplyMatrices(t.camera.matrixWorldInverse,this.matrixWorld),oi.setFromMatrixPosition(this.modelViewMatrix),t.camera.isPerspectiveCamera&&this.material.sizeAttenuation===!1&&ri.multiplyScalar(-oi.z);let n=this.material.rotation,i,r;n!==0&&(r=Math.cos(n),i=Math.sin(n));let o=this.center;Cs(As.set(-.5,-.5,0),oi,o,ri,i,r),Cs(Fi.set(.5,-.5,0),oi,o,ri,i,r),Cs(Ts.set(.5,.5,0),oi,o,ri,i,r),wc.set(0,0),Kr.set(1,0),Ec.set(1,1);let a=t.ray.intersectTriangle(As,Fi,Ts,!1,Ui);if(a===null&&(Cs(Fi.set(-.5,.5,0),oi,o,ri,i,r),Kr.set(0,1),a=t.ray.intersectTriangle(As,Ts,Fi,!1,Ui),a===null))return;let c=t.ray.origin.distanceTo(Ui);c<t.near||c>t.far||e.push({distance:c,point:Ui.clone(),uv:Un.getInterpolation(Ui,As,Fi,Ts,wc,Kr,Ec,new Lt),face:null,object:this})}copy(t,e){return super.copy(t,e),t.center!==void 0&&this.center.copy(t.center),this.material=t.material,this}};function Cs(s,t,e,n,i,r){ai.subVectors(s,e).addScalar(.5).multiply(n),i!==void 0?(Ni.x=r*ai.x-i*ai.y,Ni.y=i*ai.x+r*ai.y):Ni.copy(ai),s.copy(t),s.x+=Ni.x,s.y+=Ni.y,s.applyMatrix4(il)}var wi=class extends ee{constructor(t,e,n,i=1){super(t,e,n),this.isInstancedBufferAttribute=!0,this.meshPerAttribute=i}copy(t){return super.copy(t),this.meshPerAttribute=t.meshPerAttribute,this}toJSON(){let t=super.toJSON();return t.meshPerAttribute=this.meshPerAttribute,t.isInstancedBufferAttribute=!0,t}},ci=new Zt,Ac=new Zt,Rs=[],Tc=new rn,vm=new Zt,Oi=new Ue,Bi=new on,Qs=class extends Ue{constructor(t,e,n){super(t,e),this.isInstancedMesh=!0,this.instanceMatrix=new wi(new Float32Array(n*16),16),this.instanceColor=null,this.count=n,this.boundingBox=null,this.boundingSphere=null;for(let i=0;i<n;i++)this.setMatrixAt(i,vm)}computeBoundingBox(){let t=this.geometry,e=this.count;this.boundingBox===null&&(this.boundingBox=new rn),t.boundingBox===null&&t.computeBoundingBox(),this.boundingBox.makeEmpty();for(let n=0;n<e;n++)this.getMatrixAt(n,ci),Tc.copy(t.boundingBox).applyMatrix4(ci),this.boundingBox.union(Tc)}computeBoundingSphere(){let t=this.geometry,e=this.count;this.boundingSphere===null&&(this.boundingSphere=new on),t.boundingSphere===null&&t.computeBoundingSphere(),this.boundingSphere.makeEmpty();for(let n=0;n<e;n++)this.getMatrixAt(n,ci),Bi.copy(t.boundingSphere).applyMatrix4(ci),this.boundingSphere.union(Bi)}copy(t,e){return super.copy(t,e),this.instanceMatrix.copy(t.instanceMatrix),t.instanceColor!==null&&(this.instanceColor=t.instanceColor.clone()),this.count=t.count,t.boundingBox!==null&&(this.boundingBox=t.boundingBox.clone()),t.boundingSphere!==null&&(this.boundingSphere=t.boundingSphere.clone()),this}getColorAt(t,e){e.fromArray(this.instanceColor.array,t*3)}getMatrixAt(t,e){e.fromArray(this.instanceMatrix.array,t*16)}raycast(t,e){let n=this.matrixWorld,i=this.count;if(Oi.geometry=this.geometry,Oi.material=this.material,Oi.material!==void 0&&(this.boundingSphere===null&&this.computeBoundingSphere(),Bi.copy(this.boundingSphere),Bi.applyMatrix4(n),t.ray.intersectsSphere(Bi)!==!1))for(let r=0;r<i;r++){this.getMatrixAt(r,ci),Ac.multiplyMatrices(n,ci),Oi.matrixWorld=Ac,Oi.raycast(t,Rs);for(let o=0,a=Rs.length;o<a;o++){let c=Rs[o];c.instanceId=r,c.object=this,e.push(c)}Rs.length=0}}setColorAt(t,e){this.instanceColor===null&&(this.instanceColor=new wi(new Float32Array(this.instanceMatrix.count*3),3)),e.toArray(this.instanceColor.array,t*3)}setMatrixAt(t,e){e.toArray(this.instanceMatrix.array,t*16)}updateMorphTargets(){}dispose(){this.dispatchEvent({type:"dispose"})}};var Zi=class extends an{constructor(t){super(),this.isLineBasicMaterial=!0,this.type="LineBasicMaterial",this.color=new zt(16777215),this.map=null,this.linewidth=1,this.linecap="round",this.linejoin="round",this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.map=t.map,this.linewidth=t.linewidth,this.linecap=t.linecap,this.linejoin=t.linejoin,this.fog=t.fog,this}},Cc=new L,Rc=new L,Pc=new Zt,$r=new vi,Ps=new on,Ao=class extends fe{constructor(t=new pe,e=new Zi){super(),this.isLine=!0,this.type="Line",this.geometry=t,this.material=e,this.updateMorphTargets()}copy(t,e){return super.copy(t,e),this.material=Array.isArray(t.material)?t.material.slice():t.material,this.geometry=t.geometry,this}computeLineDistances(){let t=this.geometry;if(t.index===null){let e=t.attributes.position,n=[0];for(let i=1,r=e.count;i<r;i++)Cc.fromBufferAttribute(e,i-1),Rc.fromBufferAttribute(e,i),n[i]=n[i-1],n[i]+=Cc.distanceTo(Rc);t.setAttribute("lineDistance",new Ae(n,1))}else console.warn("THREE.Line.computeLineDistances(): Computation only possible with non-indexed BufferGeometry.");return this}raycast(t,e){let n=this.geometry,i=this.matrixWorld,r=t.params.Line.threshold,o=n.drawRange;if(n.boundingSphere===null&&n.computeBoundingSphere(),Ps.copy(n.boundingSphere),Ps.applyMatrix4(i),Ps.radius+=r,t.ray.intersectsSphere(Ps)===!1)return;Pc.copy(i).invert(),$r.copy(t.ray).applyMatrix4(Pc);let a=r/((this.scale.x+this.scale.y+this.scale.z)/3),c=a*a,l=new L,h=new L,u=new L,d=new L,m=this.isLineSegments?2:1,v=n.index,p=n.attributes.position;if(v!==null){let f=Math.max(0,o.start),g=Math.min(v.count,o.start+o.count);for(let _=f,b=g-1;_<b;_+=m){let S=v.getX(_),T=v.getX(_+1);if(l.fromBufferAttribute(p,S),h.fromBufferAttribute(p,T),$r.distanceSqToSegment(l,h,d,u)>c)continue;d.applyMatrix4(this.matrixWorld);let P=t.ray.origin.distanceTo(d);P<t.near||P>t.far||e.push({distance:P,point:u.clone().applyMatrix4(this.matrixWorld),index:_,face:null,faceIndex:null,object:this})}}else{let f=Math.max(0,o.start),g=Math.min(p.count,o.start+o.count);for(let _=f,b=g-1;_<b;_+=m){if(l.fromBufferAttribute(p,_),h.fromBufferAttribute(p,_+1),$r.distanceSqToSegment(l,h,d,u)>c)continue;d.applyMatrix4(this.matrixWorld);let T=t.ray.origin.distanceTo(d);T<t.near||T>t.far||e.push({distance:T,point:u.clone().applyMatrix4(this.matrixWorld),index:_,face:null,faceIndex:null,object:this})}}}updateMorphTargets(){let e=this.geometry.morphAttributes,n=Object.keys(e);if(n.length>0){let i=e[n[0]];if(i!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let r=0,o=i.length;r<o;r++){let a=i[r].name||String(r);this.morphTargetInfluences.push(0),this.morphTargetDictionary[a]=r}}}}},Lc=new L,Ic=new L,Ei=class extends Ao{constructor(t,e){super(t,e),this.isLineSegments=!0,this.type="LineSegments"}computeLineDistances(){let t=this.geometry;if(t.index===null){let e=t.attributes.position,n=[];for(let i=0,r=e.count;i<r;i+=2)Lc.fromBufferAttribute(e,i),Ic.fromBufferAttribute(e,i+1),n[i]=i===0?0:n[i-1],n[i+1]=n[i]+Lc.distanceTo(Ic);t.setAttribute("lineDistance",new Ae(n,1))}else console.warn("THREE.LineSegments.computeLineDistances(): Computation only possible with non-indexed BufferGeometry.");return this}};var Ji=class extends an{constructor(t){super(),this.isPointsMaterial=!0,this.type="PointsMaterial",this.color=new zt(16777215),this.map=null,this.alphaMap=null,this.size=1,this.sizeAttenuation=!0,this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.map=t.map,this.alphaMap=t.alphaMap,this.size=t.size,this.sizeAttenuation=t.sizeAttenuation,this.fog=t.fog,this}},Dc=new Zt,To=new vi,Ls=new on,Is=new L,tr=class extends fe{constructor(t=new pe,e=new Ji){super(),this.isPoints=!0,this.type="Points",this.geometry=t,this.material=e,this.updateMorphTargets()}copy(t,e){return super.copy(t,e),this.material=Array.isArray(t.material)?t.material.slice():t.material,this.geometry=t.geometry,this}raycast(t,e){let n=this.geometry,i=this.matrixWorld,r=t.params.Points.threshold,o=n.drawRange;if(n.boundingSphere===null&&n.computeBoundingSphere(),Ls.copy(n.boundingSphere),Ls.applyMatrix4(i),Ls.radius+=r,t.ray.intersectsSphere(Ls)===!1)return;Dc.copy(i).invert(),To.copy(t.ray).applyMatrix4(Dc);let a=r/((this.scale.x+this.scale.y+this.scale.z)/3),c=a*a,l=n.index,u=n.attributes.position;if(l!==null){let d=Math.max(0,o.start),m=Math.min(l.count,o.start+o.count);for(let v=d,x=m;v<x;v++){let p=l.getX(v);Is.fromBufferAttribute(u,p),Uc(Is,p,c,i,t,e,this)}}else{let d=Math.max(0,o.start),m=Math.min(u.count,o.start+o.count);for(let v=d,x=m;v<x;v++)Is.fromBufferAttribute(u,v),Uc(Is,v,c,i,t,e,this)}}updateMorphTargets(){let e=this.geometry.morphAttributes,n=Object.keys(e);if(n.length>0){let i=e[n[0]];if(i!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let r=0,o=i.length;r<o;r++){let a=i[r].name||String(r);this.morphTargetInfluences.push(0),this.morphTargetDictionary[a]=r}}}}};function Uc(s,t,e,n,i,r,o){let a=To.distanceSqToPoint(s);if(a<e){let c=new L;To.closestPointToPoint(s,c),c.applyMatrix4(n);let l=i.ray.origin.distanceTo(c);if(l<i.near||l>i.far)return;r.push({distance:l,distanceToRay:Math.sqrt(a),point:c,index:t,face:null,object:o})}}var Ki=class extends Ne{constructor(t,e,n,i,r,o,a,c,l){super(t,e,n,i,r,o,a,c,l),this.isCanvasTexture=!0,this.needsUpdate=!0}};var Co=class s extends pe{constructor(t=[],e=[],n=1,i=0){super(),this.type="PolyhedronGeometry",this.parameters={vertices:t,indices:e,radius:n,detail:i};let r=[],o=[];a(i),l(n),h(),this.setAttribute("position",new Ae(r,3)),this.setAttribute("normal",new Ae(r.slice(),3)),this.setAttribute("uv",new Ae(o,2)),i===0?this.computeVertexNormals():this.normalizeNormals();function a(g){let _=new L,b=new L,S=new L;for(let T=0;T<e.length;T+=3)m(e[T+0],_),m(e[T+1],b),m(e[T+2],S),c(_,b,S,g)}function c(g,_,b,S){let T=S+1,C=[];for(let P=0;P<=T;P++){C[P]=[];let y=g.clone().lerp(b,P/T),w=_.clone().lerp(b,P/T),F=T-P;for(let B=0;B<=F;B++)B===0&&P===T?C[P][B]=y:C[P][B]=y.clone().lerp(w,B/F)}for(let P=0;P<T;P++)for(let y=0;y<2*(T-P)-1;y++){let w=Math.floor(y/2);y%2===0?(d(C[P][w+1]),d(C[P+1][w]),d(C[P][w])):(d(C[P][w+1]),d(C[P+1][w+1]),d(C[P+1][w]))}}function l(g){let _=new L;for(let b=0;b<r.length;b+=3)_.x=r[b+0],_.y=r[b+1],_.z=r[b+2],_.normalize().multiplyScalar(g),r[b+0]=_.x,r[b+1]=_.y,r[b+2]=_.z}function h(){let g=new L;for(let _=0;_<r.length;_+=3){g.x=r[_+0],g.y=r[_+1],g.z=r[_+2];let b=p(g)/2/Math.PI+.5,S=f(g)/Math.PI+.5;o.push(b,1-S)}v(),u()}function u(){for(let g=0;g<o.length;g+=6){let _=o[g+0],b=o[g+2],S=o[g+4],T=Math.max(_,b,S),C=Math.min(_,b,S);T>.9&&C<.1&&(_<.2&&(o[g+0]+=1),b<.2&&(o[g+2]+=1),S<.2&&(o[g+4]+=1))}}function d(g){r.push(g.x,g.y,g.z)}function m(g,_){let b=g*3;_.x=t[b+0],_.y=t[b+1],_.z=t[b+2]}function v(){let g=new L,_=new L,b=new L,S=new L,T=new Lt,C=new Lt,P=new Lt;for(let y=0,w=0;y<r.length;y+=9,w+=6){g.set(r[y+0],r[y+1],r[y+2]),_.set(r[y+3],r[y+4],r[y+5]),b.set(r[y+6],r[y+7],r[y+8]),T.set(o[w+0],o[w+1]),C.set(o[w+2],o[w+3]),P.set(o[w+4],o[w+5]),S.copy(g).add(_).add(b).divideScalar(3);let F=p(S);x(T,w+0,g,F),x(C,w+2,_,F),x(P,w+4,b,F)}}function x(g,_,b,S){S<0&&g.x===1&&(o[_]=g.x-1),b.x===0&&b.z===0&&(o[_]=S/2/Math.PI+.5)}function p(g){return Math.atan2(g.z,-g.x)}function f(g){return Math.atan2(-g.y,Math.sqrt(g.x*g.x+g.z*g.z))}}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new s(t.vertices,t.indices,t.radius,t.details)}};var $i=class s extends Co{constructor(t=1,e=0){let n=(1+Math.sqrt(5))/2,i=[-1,n,0,1,n,0,-1,-n,0,1,-n,0,0,-1,n,0,1,n,0,-1,-n,0,1,-n,n,0,-1,n,0,1,-n,0,-1,-n,0,1],r=[0,11,5,0,5,1,0,1,7,0,7,10,0,10,11,1,5,9,5,11,4,11,10,2,10,7,6,7,1,8,3,9,4,3,4,2,3,2,6,3,6,8,3,8,9,4,9,5,2,4,11,6,2,10,8,6,7,9,8,1];super(i,r,t,e),this.type="IcosahedronGeometry",this.parameters={radius:t,detail:e}}static fromJSON(t){return new s(t.radius,t.detail)}};function Ds(s,t,e){return!s||!e&&s.constructor===t?s:typeof t.BYTES_PER_ELEMENT=="number"?new t(s):Array.prototype.slice.call(s)}function xm(s){return ArrayBuffer.isView(s)&&!(s instanceof DataView)}var Ai=class{constructor(t,e,n,i){this.parameterPositions=t,this._cachedIndex=0,this.resultBuffer=i!==void 0?i:new e.constructor(n),this.sampleValues=e,this.valueSize=n,this.settings=null,this.DefaultSettings_={}}evaluate(t){let e=this.parameterPositions,n=this._cachedIndex,i=e[n],r=e[n-1];n:{t:{let o;e:{i:if(!(t<i)){for(let a=n+2;;){if(i===void 0){if(t<r)break i;return n=e.length,this._cachedIndex=n,this.copySampleValue_(n-1)}if(n===a)break;if(r=i,i=e[++n],t<i)break t}o=e.length;break e}if(!(t>=r)){let a=e[1];t<a&&(n=2,r=a);for(let c=n-2;;){if(r===void 0)return this._cachedIndex=0,this.copySampleValue_(0);if(n===c)break;if(i=r,r=e[--n-1],t>=r)break t}o=n,n=0;break e}break n}for(;n<o;){let a=n+o>>>1;t<e[a]?o=a:n=a+1}if(i=e[n],r=e[n-1],r===void 0)return this._cachedIndex=0,this.copySampleValue_(0);if(i===void 0)return n=e.length,this._cachedIndex=n,this.copySampleValue_(n-1)}this._cachedIndex=n,this.intervalChanged_(n,r,i)}return this.interpolate_(n,r,t,i)}getSettings_(){return this.settings||this.DefaultSettings_}copySampleValue_(t){let e=this.resultBuffer,n=this.sampleValues,i=this.valueSize,r=t*i;for(let o=0;o!==i;++o)e[o]=n[r+o];return e}interpolate_(){throw new Error("call to abstract method")}intervalChanged_(){}},Ro=class extends Ai{constructor(t,e,n,i){super(t,e,n,i),this._weightPrev=-0,this._offsetPrev=-0,this._weightNext=-0,this._offsetNext=-0,this.DefaultSettings_={endingStart:Na,endingEnd:Na}}intervalChanged_(t,e,n){let i=this.parameterPositions,r=t-2,o=t+1,a=i[r],c=i[o];if(a===void 0)switch(this.getSettings_().endingStart){case Fa:r=t,a=2*e-n;break;case Oa:r=i.length-2,a=e+i[r]-i[r+1];break;default:r=t,a=n}if(c===void 0)switch(this.getSettings_().endingEnd){case Fa:o=t,c=2*n-e;break;case Oa:o=1,c=n+i[1]-i[0];break;default:o=t-1,c=e}let l=(n-e)*.5,h=this.valueSize;this._weightPrev=l/(e-a),this._weightNext=l/(c-n),this._offsetPrev=r*h,this._offsetNext=o*h}interpolate_(t,e,n,i){let r=this.resultBuffer,o=this.sampleValues,a=this.valueSize,c=t*a,l=c-a,h=this._offsetPrev,u=this._offsetNext,d=this._weightPrev,m=this._weightNext,v=(n-e)/(i-e),x=v*v,p=x*v,f=-d*p+2*d*x-d*v,g=(1+d)*p+(-1.5-2*d)*x+(-.5+d)*v+1,_=(-1-m)*p+(1.5+m)*x+.5*v,b=m*p-m*x;for(let S=0;S!==a;++S)r[S]=f*o[h+S]+g*o[l+S]+_*o[c+S]+b*o[u+S];return r}},Po=class extends Ai{constructor(t,e,n,i){super(t,e,n,i)}interpolate_(t,e,n,i){let r=this.resultBuffer,o=this.sampleValues,a=this.valueSize,c=t*a,l=c-a,h=(n-e)/(i-e),u=1-h;for(let d=0;d!==a;++d)r[d]=o[l+d]*u+o[c+d]*h;return r}},Lo=class extends Ai{constructor(t,e,n,i){super(t,e,n,i)}interpolate_(t){return this.copySampleValue_(t-1)}},He=class{constructor(t,e,n,i){if(t===void 0)throw new Error("THREE.KeyframeTrack: track name is undefined");if(e===void 0||e.length===0)throw new Error("THREE.KeyframeTrack: no keyframes in track named "+t);this.name=t,this.times=Ds(e,this.TimeBufferType),this.values=Ds(n,this.ValueBufferType),this.setInterpolation(i||this.DefaultInterpolation)}static toJSON(t){let e=t.constructor,n;if(e.toJSON!==this.toJSON)n=e.toJSON(t);else{n={name:t.name,times:Ds(t.times,Array),values:Ds(t.values,Array)};let i=t.getInterpolation();i!==t.DefaultInterpolation&&(n.interpolation=i)}return n.type=t.ValueTypeName,n}InterpolantFactoryMethodDiscrete(t){return new Lo(this.times,this.values,this.getValueSize(),t)}InterpolantFactoryMethodLinear(t){return new Po(this.times,this.values,this.getValueSize(),t)}InterpolantFactoryMethodSmooth(t){return new Ro(this.times,this.values,this.getValueSize(),t)}setInterpolation(t){let e;switch(t){case Ns:e=this.InterpolantFactoryMethodDiscrete;break;case Fs:e=this.InterpolantFactoryMethodLinear;break;case Er:e=this.InterpolantFactoryMethodSmooth;break}if(e===void 0){let n="unsupported interpolation for "+this.ValueTypeName+" keyframe track named "+this.name;if(this.createInterpolant===void 0)if(t!==this.DefaultInterpolation)this.setInterpolation(this.DefaultInterpolation);else throw new Error(n);return console.warn("THREE.KeyframeTrack:",n),this}return this.createInterpolant=e,this}getInterpolation(){switch(this.createInterpolant){case this.InterpolantFactoryMethodDiscrete:return Ns;case this.InterpolantFactoryMethodLinear:return Fs;case this.InterpolantFactoryMethodSmooth:return Er}}getValueSize(){return this.values.length/this.times.length}shift(t){if(t!==0){let e=this.times;for(let n=0,i=e.length;n!==i;++n)e[n]+=t}return this}scale(t){if(t!==1){let e=this.times;for(let n=0,i=e.length;n!==i;++n)e[n]*=t}return this}trim(t,e){let n=this.times,i=n.length,r=0,o=i-1;for(;r!==i&&n[r]<t;)++r;for(;o!==-1&&n[o]>e;)--o;if(++o,r!==0||o!==i){r>=o&&(o=Math.max(o,1),r=o-1);let a=this.getValueSize();this.times=n.slice(r,o),this.values=this.values.slice(r*a,o*a)}return this}validate(){let t=!0,e=this.getValueSize();e-Math.floor(e)!==0&&(console.error("THREE.KeyframeTrack: Invalid value size in track.",this),t=!1);let n=this.times,i=this.values,r=n.length;r===0&&(console.error("THREE.KeyframeTrack: Track is empty.",this),t=!1);let o=null;for(let a=0;a!==r;a++){let c=n[a];if(typeof c=="number"&&isNaN(c)){console.error("THREE.KeyframeTrack: Time is not a valid number.",this,a,c),t=!1;break}if(o!==null&&o>c){console.error("THREE.KeyframeTrack: Out of order keys.",this,a,c,o),t=!1;break}o=c}if(i!==void 0&&xm(i))for(let a=0,c=i.length;a!==c;++a){let l=i[a];if(isNaN(l)){console.error("THREE.KeyframeTrack: Value is not a valid number.",this,a,l),t=!1;break}}return t}optimize(){let t=this.times.slice(),e=this.values.slice(),n=this.getValueSize(),i=this.getInterpolation()===Er,r=t.length-1,o=1;for(let a=1;a<r;++a){let c=!1,l=t[a],h=t[a+1];if(l!==h&&(a!==1||l!==t[0]))if(i)c=!0;else{let u=a*n,d=u-n,m=u+n;for(let v=0;v!==n;++v){let x=e[u+v];if(x!==e[d+v]||x!==e[m+v]){c=!0;break}}}if(c){if(a!==o){t[o]=t[a];let u=a*n,d=o*n;for(let m=0;m!==n;++m)e[d+m]=e[u+m]}++o}}if(r>0){t[o]=t[r];for(let a=r*n,c=o*n,l=0;l!==n;++l)e[c+l]=e[a+l];++o}return o!==t.length?(this.times=t.slice(0,o),this.values=e.slice(0,o*n)):(this.times=t,this.values=e),this}clone(){let t=this.times.slice(),e=this.values.slice(),n=this.constructor,i=new n(this.name,t,e);return i.createInterpolant=this.createInterpolant,i}};He.prototype.TimeBufferType=Float32Array;He.prototype.ValueBufferType=Float32Array;He.prototype.DefaultInterpolation=Fs;var kn=class extends He{};kn.prototype.ValueTypeName="bool";kn.prototype.ValueBufferType=Array;kn.prototype.DefaultInterpolation=Ns;kn.prototype.InterpolantFactoryMethodLinear=void 0;kn.prototype.InterpolantFactoryMethodSmooth=void 0;var Io=class extends He{};Io.prototype.ValueTypeName="color";var Do=class extends He{};Do.prototype.ValueTypeName="number";var Uo=class extends Ai{constructor(t,e,n,i){super(t,e,n,i)}interpolate_(t,e,n,i){let r=this.resultBuffer,o=this.sampleValues,a=this.valueSize,c=(n-e)/(i-e),l=t*a;for(let h=l+a;l!==h;l+=4)bn.slerpFlat(r,0,o,l-a,o,l,c);return r}},ji=class extends He{InterpolantFactoryMethodLinear(t){return new Uo(this.times,this.values,this.getValueSize(),t)}};ji.prototype.ValueTypeName="quaternion";ji.prototype.DefaultInterpolation=Fs;ji.prototype.InterpolantFactoryMethodSmooth=void 0;var Vn=class extends He{};Vn.prototype.ValueTypeName="string";Vn.prototype.ValueBufferType=Array;Vn.prototype.DefaultInterpolation=Ns;Vn.prototype.InterpolantFactoryMethodLinear=void 0;Vn.prototype.InterpolantFactoryMethodSmooth=void 0;var No=class extends He{};No.prototype.ValueTypeName="vector";var Fo=class{constructor(t,e,n){let i=this,r=!1,o=0,a=0,c,l=[];this.onStart=void 0,this.onLoad=t,this.onProgress=e,this.onError=n,this.itemStart=function(h){a++,r===!1&&i.onStart!==void 0&&i.onStart(h,o,a),r=!0},this.itemEnd=function(h){o++,i.onProgress!==void 0&&i.onProgress(h,o,a),o===a&&(r=!1,i.onLoad!==void 0&&i.onLoad())},this.itemError=function(h){i.onError!==void 0&&i.onError(h)},this.resolveURL=function(h){return c?c(h):h},this.setURLModifier=function(h){return c=h,this},this.addHandler=function(h,u){return l.push(h,u),this},this.removeHandler=function(h){let u=l.indexOf(h);return u!==-1&&l.splice(u,2),this},this.getHandler=function(h){for(let u=0,d=l.length;u<d;u+=2){let m=l[u],v=l[u+1];if(m.global&&(m.lastIndex=0),m.test(h))return v}return null}}},ym=new Fo,Oo=class{constructor(t){this.manager=t!==void 0?t:ym,this.crossOrigin="anonymous",this.withCredentials=!1,this.path="",this.resourcePath="",this.requestHeader={}}load(){}loadAsync(t,e){let n=this;return new Promise(function(i,r){n.load(t,i,e,r)})}parse(){}setCrossOrigin(t){return this.crossOrigin=t,this}setWithCredentials(t){return this.withCredentials=t,this}setPath(t){return this.path=t,this}setResourcePath(t){return this.resourcePath=t,this}setRequestHeader(t){return this.requestHeader=t,this}};Oo.DEFAULT_MATERIAL_NAME="__DEFAULT";var Wo="\\[\\]\\.:\\/",Mm=new RegExp("["+Wo+"]","g"),Xo="[^"+Wo+"]",bm="[^"+Wo.replace("\\.","")+"]",Sm=/((?:WC+[\/:])*)/.source.replace("WC",Xo),wm=/(WCOD+)?/.source.replace("WCOD",bm),Em=/(?:\.(WC+)(?:\[(.+)\])?)?/.source.replace("WC",Xo),Am=/\.(WC+)(?:\[(.+)\])?/.source.replace("WC",Xo),Tm=new RegExp("^"+Sm+wm+Em+Am+"$"),Cm=["material","materials","bones","map"],Bo=class{constructor(t,e,n){let i=n||te.parseTrackName(e);this._targetGroup=t,this._bindings=t.subscribe_(e,i)}getValue(t,e){this.bind();let n=this._targetGroup.nCachedObjects_,i=this._bindings[n];i!==void 0&&i.getValue(t,e)}setValue(t,e){let n=this._bindings;for(let i=this._targetGroup.nCachedObjects_,r=n.length;i!==r;++i)n[i].setValue(t,e)}bind(){let t=this._bindings;for(let e=this._targetGroup.nCachedObjects_,n=t.length;e!==n;++e)t[e].bind()}unbind(){let t=this._bindings;for(let e=this._targetGroup.nCachedObjects_,n=t.length;e!==n;++e)t[e].unbind()}},te=class s{constructor(t,e,n){this.path=e,this.parsedPath=n||s.parseTrackName(e),this.node=s.findNode(t,this.parsedPath.nodeName),this.rootNode=t,this.getValue=this._getValue_unbound,this.setValue=this._setValue_unbound}static create(t,e,n){return t&&t.isAnimationObjectGroup?new s.Composite(t,e,n):new s(t,e,n)}static sanitizeNodeName(t){return t.replace(/\s/g,"_").replace(Mm,"")}static parseTrackName(t){let e=Tm.exec(t);if(e===null)throw new Error("PropertyBinding: Cannot parse trackName: "+t);let n={nodeName:e[2],objectName:e[3],objectIndex:e[4],propertyName:e[5],propertyIndex:e[6]},i=n.nodeName&&n.nodeName.lastIndexOf(".");if(i!==void 0&&i!==-1){let r=n.nodeName.substring(i+1);Cm.indexOf(r)!==-1&&(n.nodeName=n.nodeName.substring(0,i),n.objectName=r)}if(n.propertyName===null||n.propertyName.length===0)throw new Error("PropertyBinding: can not parse propertyName from trackName: "+t);return n}static findNode(t,e){if(e===void 0||e===""||e==="."||e===-1||e===t.name||e===t.uuid)return t;if(t.skeleton){let n=t.skeleton.getBoneByName(e);if(n!==void 0)return n}if(t.children){let n=function(r){for(let o=0;o<r.length;o++){let a=r[o];if(a.name===e||a.uuid===e)return a;let c=n(a.children);if(c)return c}return null},i=n(t.children);if(i)return i}return null}_getValue_unavailable(){}_setValue_unavailable(){}_getValue_direct(t,e){t[e]=this.targetObject[this.propertyName]}_getValue_array(t,e){let n=this.resolvedProperty;for(let i=0,r=n.length;i!==r;++i)t[e++]=n[i]}_getValue_arrayElement(t,e){t[e]=this.resolvedProperty[this.propertyIndex]}_getValue_toArray(t,e){this.resolvedProperty.toArray(t,e)}_setValue_direct(t,e){this.targetObject[this.propertyName]=t[e]}_setValue_direct_setNeedsUpdate(t,e){this.targetObject[this.propertyName]=t[e],this.targetObject.needsUpdate=!0}_setValue_direct_setMatrixWorldNeedsUpdate(t,e){this.targetObject[this.propertyName]=t[e],this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_array(t,e){let n=this.resolvedProperty;for(let i=0,r=n.length;i!==r;++i)n[i]=t[e++]}_setValue_array_setNeedsUpdate(t,e){let n=this.resolvedProperty;for(let i=0,r=n.length;i!==r;++i)n[i]=t[e++];this.targetObject.needsUpdate=!0}_setValue_array_setMatrixWorldNeedsUpdate(t,e){let n=this.resolvedProperty;for(let i=0,r=n.length;i!==r;++i)n[i]=t[e++];this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_arrayElement(t,e){this.resolvedProperty[this.propertyIndex]=t[e]}_setValue_arrayElement_setNeedsUpdate(t,e){this.resolvedProperty[this.propertyIndex]=t[e],this.targetObject.needsUpdate=!0}_setValue_arrayElement_setMatrixWorldNeedsUpdate(t,e){this.resolvedProperty[this.propertyIndex]=t[e],this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_fromArray(t,e){this.resolvedProperty.fromArray(t,e)}_setValue_fromArray_setNeedsUpdate(t,e){this.resolvedProperty.fromArray(t,e),this.targetObject.needsUpdate=!0}_setValue_fromArray_setMatrixWorldNeedsUpdate(t,e){this.resolvedProperty.fromArray(t,e),this.targetObject.matrixWorldNeedsUpdate=!0}_getValue_unbound(t,e){this.bind(),this.getValue(t,e)}_setValue_unbound(t,e){this.bind(),this.setValue(t,e)}bind(){let t=this.node,e=this.parsedPath,n=e.objectName,i=e.propertyName,r=e.propertyIndex;if(t||(t=s.findNode(this.rootNode,e.nodeName),this.node=t),this.getValue=this._getValue_unavailable,this.setValue=this._setValue_unavailable,!t){console.warn("THREE.PropertyBinding: No target node found for track: "+this.path+".");return}if(n){let l=e.objectIndex;switch(n){case"materials":if(!t.material){console.error("THREE.PropertyBinding: Can not bind to material as node does not have a material.",this);return}if(!t.material.materials){console.error("THREE.PropertyBinding: Can not bind to material.materials as node.material does not have a materials array.",this);return}t=t.material.materials;break;case"bones":if(!t.skeleton){console.error("THREE.PropertyBinding: Can not bind to bones as node does not have a skeleton.",this);return}t=t.skeleton.bones;for(let h=0;h<t.length;h++)if(t[h].name===l){l=h;break}break;case"map":if("map"in t){t=t.map;break}if(!t.material){console.error("THREE.PropertyBinding: Can not bind to material as node does not have a material.",this);return}if(!t.material.map){console.error("THREE.PropertyBinding: Can not bind to material.map as node.material does not have a map.",this);return}t=t.material.map;break;default:if(t[n]===void 0){console.error("THREE.PropertyBinding: Can not bind to objectName of node undefined.",this);return}t=t[n]}if(l!==void 0){if(t[l]===void 0){console.error("THREE.PropertyBinding: Trying to bind to objectIndex of objectName, but is undefined.",this,t);return}t=t[l]}}let o=t[i];if(o===void 0){let l=e.nodeName;console.error("THREE.PropertyBinding: Trying to update property for track: "+l+"."+i+" but it wasn't found.",t);return}let a=this.Versioning.None;this.targetObject=t,t.needsUpdate!==void 0?a=this.Versioning.NeedsUpdate:t.matrixWorldNeedsUpdate!==void 0&&(a=this.Versioning.MatrixWorldNeedsUpdate);let c=this.BindingType.Direct;if(r!==void 0){if(i==="morphTargetInfluences"){if(!t.geometry){console.error("THREE.PropertyBinding: Can not bind to morphTargetInfluences because node does not have a geometry.",this);return}if(!t.geometry.morphAttributes){console.error("THREE.PropertyBinding: Can not bind to morphTargetInfluences because node does not have a geometry.morphAttributes.",this);return}t.morphTargetDictionary[r]!==void 0&&(r=t.morphTargetDictionary[r])}c=this.BindingType.ArrayElement,this.resolvedProperty=o,this.propertyIndex=r}else o.fromArray!==void 0&&o.toArray!==void 0?(c=this.BindingType.HasFromToArray,this.resolvedProperty=o):Array.isArray(o)?(c=this.BindingType.EntireArray,this.resolvedProperty=o):this.propertyName=i;this.getValue=this.GetterByBindingType[c],this.setValue=this.SetterByBindingTypeAndVersioning[c][a]}unbind(){this.node=null,this.getValue=this._getValue_unbound,this.setValue=this._setValue_unbound}};te.Composite=Bo;te.prototype.BindingType={Direct:0,EntireArray:1,ArrayElement:2,HasFromToArray:3};te.prototype.Versioning={None:0,NeedsUpdate:1,MatrixWorldNeedsUpdate:2};te.prototype.GetterByBindingType=[te.prototype._getValue_direct,te.prototype._getValue_array,te.prototype._getValue_arrayElement,te.prototype._getValue_toArray];te.prototype.SetterByBindingTypeAndVersioning=[[te.prototype._setValue_direct,te.prototype._setValue_direct_setNeedsUpdate,te.prototype._setValue_direct_setMatrixWorldNeedsUpdate],[te.prototype._setValue_array,te.prototype._setValue_array_setNeedsUpdate,te.prototype._setValue_array_setMatrixWorldNeedsUpdate],[te.prototype._setValue_arrayElement,te.prototype._setValue_arrayElement_setNeedsUpdate,te.prototype._setValue_arrayElement_setMatrixWorldNeedsUpdate],[te.prototype._setValue_fromArray,te.prototype._setValue_fromArray_setNeedsUpdate,te.prototype._setValue_fromArray_setMatrixWorldNeedsUpdate]];var dg=new Float32Array(1);var er=class{constructor(t,e,n=0,i=1/0){this.ray=new vi(t,e),this.near=n,this.far=i,this.camera=null,this.layers=new Gi,this.params={Mesh:{},Line:{threshold:1},LOD:{},Points:{threshold:1},Sprite:{}}}set(t,e){this.ray.set(t,e)}setFromCamera(t,e){e.isPerspectiveCamera?(this.ray.origin.setFromMatrixPosition(e.matrixWorld),this.ray.direction.set(t.x,t.y,.5).unproject(e).sub(this.ray.origin).normalize(),this.camera=e):e.isOrthographicCamera?(this.ray.origin.set(t.x,t.y,(e.near+e.far)/(e.near-e.far)).unproject(e),this.ray.direction.set(0,0,-1).transformDirection(e.matrixWorld),this.camera=e):console.error("THREE.Raycaster: Unsupported camera type: "+e.type)}intersectObject(t,e=!0,n=[]){return zo(t,this,n,e),n.sort(Nc),n}intersectObjects(t,e=!0,n=[]){for(let i=0,r=t.length;i<r;i++)zo(t[i],this,n,e);return n.sort(Nc),n}};function Nc(s,t){return s.distance-t.distance}function zo(s,t,e,n){if(s.layers.test(t.layers)&&s.raycast(t,e),n===!0){let i=s.children;for(let r=0,o=i.length;r<o;r++)zo(i[r],t,e,!0)}}typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("register",{detail:{revision:"160"}}));typeof window<"u"&&(window.__THREE__?console.warn("WARNING: Multiple instances of Three.js being imported."):window.__THREE__="160");var sl=461586,rl=461586,Rm=.08,Pm=Math.PI-.08,ol=.5;function Lm(s,t,e){let n=new L().subVectors(t,s);if(n.lengthSq()<1e-12){e.x=0,e.y=0,e.z=0,e.w=1;return}n.normalize();let i=Math.abs(n.y)>.9999?new L(1,0,0):new L(0,1,0),r=new L().crossVectors(i,n).normalize(),o=new L().crossVectors(n,r).normalize(),a=r.x,c=o.x,l=-n.x,h=r.y,u=o.y,d=-n.y,m=r.z,v=o.z,x=-n.z,p=a+u+x;if(p>0){let g=.5/Math.sqrt(p+1);e.w=.25/g,e.x=(v-d)*g,e.y=(l-m)*g,e.z=(h-c)*g}else if(a>u&&a>x){let g=2*Math.sqrt(1+a-u-x);e.w=(v-d)/g,e.x=.25*g,e.y=(c+h)/g,e.z=(l+m)/g}else if(u>x){let g=2*Math.sqrt(1+u-a-x);e.w=(l-m)/g,e.x=(c+h)/g,e.y=.25*g,e.z=(d+v)/g}else{let g=2*Math.sqrt(1+x-a-u);e.w=(h-c)/g,e.x=(l+m)/g,e.y=(d+v)/g,e.z=.25*g}let f=Math.hypot(e.x,e.y,e.z,e.w)||1;e.x/=f,e.y/=f,e.z/=f,e.w/=f}function Im(s,t,e,n){let i=s.x*t.x+s.y*t.y+s.z*t.z+s.w*t.w,r=t.x,o=t.y,a=t.z,c=t.w;if(i<0&&(i=-i,r=-r,o=-o,a=-a,c=-c),i>.9995){n.x=s.x+(r-s.x)*e,n.y=s.y+(o-s.y)*e,n.z=s.z+(a-s.z)*e,n.w=s.w+(c-s.w)*e;let m=Math.hypot(n.x,n.y,n.z,n.w)||1;n.x/=m,n.y/=m,n.z/=m,n.w/=m;return}let l=Math.acos(Math.min(1,Math.max(-1,i))),h=Math.sin(l),u=Math.sin((1-e)*l)/h,d=Math.sin(e*l)/h;n.x=s.x*u+r*d,n.y=s.y*u+o*d,n.z=s.z*u+a*d,n.w=s.w*u+c*d}function Dm(s){return 1-Math.pow(1-s,3)}var rr=class{constructor(t){this.azimuth=Math.PI*.25;this.polar=Math.PI*.36;this.distance=800;this.target=new L(0,0,0);this.targetAzimuth=Math.PI*.25;this.targetPolar=Math.PI*.36;this.targetDistance=800;this.targetPoint=new L(0,0,0);this.projection="perspective";this.orthoZoom=1;this.flight={active:!1,startedAt:0,duration:520,fromTarget:new L,toTarget:new L,fromDistance:800,toDistance:800,fromQuat:{x:0,y:0,z:0,w:1},toQuat:{x:0,y:0,z:0,w:1}};this.tmpDir=new L;this.tmpQuat={x:0,y:0,z:0,w:1};this.raycaster=new er;this.canvas=t,this.renderer=new Xi({canvas:t,antialias:!0,alpha:!1,powerPreference:"high-performance"}),this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2)),this.renderer.setClearColor(sl,1),this.renderer.outputColorSpace="srgb",this.scene=new bi,this.scene.background=new zt(sl),this.scene.fog=new qi(rl,2500,12e3),this.perspective=new Se(52,1,.5,4e4),this.orthographic=new zn(-1,1,1,-1,-2e4,4e4),this.camera=this.perspective,this.resize()}get projectionMode(){return this.projection}setProjection(t){this.projection!==t&&(this.projection=t,this.camera=t==="perspective"?this.perspective:this.orthographic,this.scene.fog=t==="perspective"?new qi(rl,2500,12e3):null,this.resize(),this.applyCamera())}resize(){let t=Math.max(1,this.canvas.clientWidth||window.innerWidth),e=Math.max(1,this.canvas.clientHeight||window.innerHeight);this.renderer.setSize(t,e,!1);let n=t/e;this.perspective.aspect=n,this.perspective.updateProjectionMatrix();let i=e*.5/this.orthoZoom;this.orthographic.left=-i*n,this.orthographic.right=i*n,this.orthographic.top=i,this.orthographic.bottom=-i,this.orthographic.updateProjectionMatrix()}get pixelsPerWorldUnit(){if(this.projection==="perspective"){let t=Math.max(1,this.canvas.clientHeight),e=this.perspective.fov*Math.PI/180;return t/(2*Math.tan(e/2)*Math.max(.001,this.distance))}return this.canvas.clientHeight/Math.max(.001,this.orthographic.top-this.orthographic.bottom)}orbit(t,e){let n=2*Math.PI/Math.max(240,this.canvas.clientHeight);this.targetAzimuth-=t*n*1.6,this.targetPolar=Math.min(Pm,Math.max(Rm,this.targetPolar-e*n)),this.flight.active=!1}zoom(t){let e=Math.exp(t*.0012);this.projection==="perspective"?this.targetDistance=Math.min(3e4,Math.max(ol,this.targetDistance*e)):(this.orthoZoom=Math.min(400,Math.max(.002,this.orthoZoom/e)),this.resize(),this.applyCamera()),this.flight.active=!1}pan(t,e){let n=this.projection==="perspective"?2*Math.tan(this.perspective.fov*Math.PI/360)*this.distance/Math.max(1,this.canvas.clientHeight):(this.orthographic.top-this.orthographic.bottom)/Math.max(1,this.canvas.clientHeight),i=new L().setFromMatrixColumn(this.camera.matrix,0),r=new L().setFromMatrixColumn(this.camera.matrix,1);this.targetPoint.addScaledVector(i,-t*n).addScaledVector(r,e*n),this.flight.active=!1}setPose(t,e,n,i){this.targetPoint.copy(t),this.target.copy(t),n!==void 0&&(this.azimuth=n,this.targetAzimuth=n),i!==void 0&&(this.polar=i,this.targetPolar=i),this.distance=e,this.targetDistance=e,this.flight.active=!1,this.applyCamera()}fitOrtho(t){let e=Math.max(1,this.canvas.clientHeight||window.innerHeight);this.orthoZoom=e*.5/Math.max(.001,t),this.resize(),this.applyCamera()}reset(t){this.flight.active=!1,this.targetPoint.set(0,0,0),this.targetAzimuth=Math.PI*.25,this.targetPolar=Math.PI*.36,this.targetDistance=t,this.orthoZoom=1,this.resize()}get focusPoint(){return this.targetPoint.clone()}get currentDistance(){return this.distance}flyTo(t,e,n,i=520){this.flight.fromTarget.copy(this.targetPoint),this.flight.toTarget.copy(t),this.flight.fromDistance=this.projection==="perspective"?this.distance:this.orthographic.top-this.orthographic.bottom,this.flight.toDistance=e,Lm(this.currentPosition(),this.targetPoint,this.flight.fromQuat),this.flight.toQuat.x=n.x,this.flight.toQuat.y=n.y,this.flight.toQuat.z=n.z,this.flight.toQuat.w=n.w,this.flight.startedAt=performance.now(),this.flight.duration=Math.max(1,i),this.flight.active=!0}currentPosition(){let t=new L;return this.camera.getWorldPosition(t),t}update(t){if(this.flight.active){let e=(t-this.flight.startedAt)/this.flight.duration,n=Dm(Math.min(1,Math.max(0,e)));if(this.targetPoint.lerpVectors(this.flight.fromTarget,this.flight.toTarget,n),Im(this.flight.fromQuat,this.flight.toQuat,n,this.tmpQuat),this.camera.quaternion.set(this.tmpQuat.x,this.tmpQuat.y,this.tmpQuat.z,this.tmpQuat.w),this.projection==="perspective")this.distance=this.flight.fromDistance+(this.flight.toDistance-this.flight.fromDistance)*n,this.camera.position.copy(this.targetPoint).addScaledVector(this.tmpDir.set(0,0,1).applyQuaternion(this.camera.quaternion),this.distance),this.targetDistance=this.distance;else{let i=this.flight.fromDistance+(this.flight.toDistance-this.flight.fromDistance)*n;this.orthoZoom=this.canvas.clientHeight*.5/Math.max(.001,i),this.resize(),this.camera.position.copy(this.targetPoint).addScaledVector(this.tmpDir.set(0,0,1).applyQuaternion(this.camera.quaternion),4e3)}this.camera.updateMatrixWorld(),e>=1&&(this.flight.active=!1);return}if(this.projection==="perspective"){let e=1-Math.exp(-.125);this.azimuth+=(this.targetAzimuth-this.azimuth)*e,this.polar+=(this.targetPolar-this.polar)*e,this.distance+=(this.targetDistance-this.distance)*e,this.target.lerp(this.targetPoint,e),this.applyCamera()}else{let e=1-Math.exp(-.125);this.azimuth+=(this.targetAzimuth-this.azimuth)*e,this.polar+=(this.targetPolar-this.polar)*e,this.target.lerp(this.targetPoint,e),this.applyCamera()}}applyCamera(){let t=Math.sin(this.polar),e=new L(t*Math.sin(this.azimuth),Math.cos(this.polar),t*Math.cos(this.azimuth));this.projection==="perspective"?(this.camera.position.copy(this.target).addScaledVector(e,this.distance),this.camera.lookAt(this.target),this.camera.updateMatrixWorld()):(this.camera.position.copy(this.target).addScaledVector(e,8e3),this.camera.lookAt(this.target),this.camera.updateMatrixWorld())}toNdc(t,e,n=new Lt){let i=this.canvas.getBoundingClientRect();return n.x=(t-i.left)/Math.max(1,i.width)*2-1,n.y=-((e-i.top)/Math.max(1,i.height))*2+1,n}makeRaycaster(t,e){return this.raycaster.setFromCamera(this.toNdc(t,e),this.camera),this.raycaster}project(t,e=new Lt){let n=t.clone().project(this.camera),i=this.canvas.getBoundingClientRect();return e.x=(n.x*.5+.5)*i.width,e.y=(-n.y*.5+.5)*i.height,e}frameRadius(t,e=1.35){if(this.projection==="perspective"){let c=this.perspective.fov*Math.PI/180;return Math.max(ol,t*e/Math.tan(c/2))}let n=Math.max(1,this.canvas.clientHeight||window.innerHeight),i=Math.max(1,this.canvas.clientWidth||window.innerWidth),r=i/n,o=t*e,a=o*r;return Math.max(o,a/r)}render(){this.renderer.render(this.scene,this.camera)}dispose(){this.renderer.dispose()}};var al={fact:"#4aa3df",knowledge:"#3ecf8e",decision:"#b07cf0",preference:"#f0b24a",procedure:"#35c9c1",experience:"#f07c7c",task:"#8aa0b8",turn:"#6b7c93",tool:"#7fb4d8",artifact:"#c9a227",concept:"#6dd3ff",entity:"#6dd3ff",person:"#e08ac0",project:"#63b3ed",term:"#7ee0c8",memory:"#4aa3df",evidence:"#ffd166",source:"#9aa7b8",document:"#b8a2d8",scope:"#e6c86e",day:"#7aa2c8",chunk:"#a58fc9",default:"#8fa3bd"};function Sn(s){return al[s]??al.default}function wn(s){let t=Math.max(0,s.degree),e=Math.max(0,Math.min(1,s.importance));return 2.2+Math.min(9,Math.log1p(t)*2.6)+e*3.4}function ul(s){return Math.max(.2,s/370)}var cl=[[1,0],[1,-1],[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1]],qo=class s{constructor(){this.cell=32;this.map=new Map}clear(){this.map.clear()}static key(t,e){return(t+512)*4096+(e+512)}bucket(t,e){let n=s.key(t,e),i=this.map.get(n);if(i)return i;let r=[];return this.map.set(n,r),r}hits(t,e,n,i){let r=Math.floor(t/this.cell),o=Math.floor((t+n)/this.cell),a=Math.floor(e/this.cell),c=Math.floor((e+i)/this.cell);for(let l=a;l<=c;l++)for(let h=r;h<=o;h++){let u=this.map.get(s.key(h,l));if(u){for(let d=0;d<u.length;d+=4)if(t<u[d]+u[d+2]&&u[d]<t+n&&e<u[d+1]+u[d+3]&&u[d+1]<e+i)return!0}}return!1}add(t,e,n,i){let r=Math.floor(t/this.cell),o=Math.floor((t+n)/this.cell),a=Math.floor(e/this.cell),c=Math.floor((e+i)/this.cell);for(let l=a;l<=c;l++)for(let h=r;h<=o;h++)this.bucket(h,l).push(t,e,n,i)}},or=class{constructor(t={}){this.group=new fe;this.overlayScene=new bi;this.overlayCamera=new zn(0,1,0,1,-10,10);this.spritePool=[];this.textureCache=new Map;this.grid=new qo;this.labelCursor=0;this.labelsShown=0;this.rankOf=new Map;this.forcedSet=new Set;this.dummy=new fe;this.scratchColor=new zt;this.baseColors=new Float32Array(0);this.nodeCount=0;this.unit=1;this.graph=null;this.highlightLevel=new Uint8Array(0);this.selected=-1;this.labelStats={};this.evictCounter=0;this.maxLabels=Math.max(8,t.maxLabels??120),this.churn=Math.min(1,Math.max(.05,t.labelChurn??.2)),this.iGeometryHi=new $i(1,1),this.iGeometryLo=new $i(1,0);let e=new xi({toneMapped:!1});this.material=e,this.mesh=ll(this.iGeometryHi,e,1),this.haloTexture=Um(128,"rgba(200,245,255,0.95)","rgba(80,190,255,0)"),this.halo=new Yi(new Si({map:this.haloTexture,blending:Bn,depthWrite:!1,depthTest:!0,transparent:!0,toneMapped:!1})),this.halo.visible=!1,this.halo.renderOrder=5,this.group.add(this.mesh),this.group.add(this.halo),this.overlayCamera.position.set(0,0,5),this.overlayCamera.updateMatrixWorld()}get labelCount(){return this.labelsShown}get count(){return this.nodeCount}setLabelBudget(t){this.maxLabels=Math.max(8,Math.floor(t))}setLod(t){let e=t==="high"?this.iGeometryHi:this.iGeometryLo;this.mesh.geometry!==e&&(this.mesh.geometry=e)}setWorldUnit(t){this.unit=Math.max(.5,t)}get worldUnit(){return this.unit}ensureCapacity(t){let e=this.mesh.instanceMatrix.count;if(e>=t&&e>1){this.mesh.count=t;return}let n=this.mesh.geometry;this.group.remove(this.mesh),this.mesh.dispose(),this.mesh=ll(n,this.material,Math.max(t,1)),this.group.add(this.mesh)}build(t,e){this.graph=t,this.nodeCount=t.nodes.length,this.ensureCapacity(this.nodeCount),this.mesh.count=this.nodeCount;let n=this.mesh.instanceColor??new wi(new Float32Array(Math.max(1,this.nodeCount)*3),3);for(let i=0;i<this.nodeCount;i++)this.scratchColor.set(Sn(t.nodes[i].kind)),n.setXYZ(i,this.scratchColor.r,this.scratchColor.g,this.scratchColor.b);n.setUsage(Ho),n.needsUpdate=!0,this.mesh.instanceColor=n,this.material.needsUpdate=!0,this.highlightLevel=new Uint8Array(this.nodeCount),this.selected=-1,this.halo.visible=!1,this.invalidateLabels(),this.writeMatrices(e,null)}writeMatrices(t,e){let n=this.graph;if(!n)return;let i=this.dummy;i.updateMatrix();for(let r=0;r<this.nodeCount;r++){let o=wn(n.nodes[r])*this.unit,a=e?o*e[r]:o;i.position.set(t[r*3],t[r*3+1],t[r*3+2]),i.scale.setScalar(a),i.rotation.set(0,0,0),i.updateMatrix(),this.mesh.setMatrixAt(r,i.matrix)}this.mesh.instanceMatrix.needsUpdate=!0,this.mesh.computeBoundingSphere()}setHighlight(t,e){let n=this.graph;if(!n)return;let i=this.mesh.instanceColor;if(i){for(let r=0;r<this.highlightLevel.length;r++)this.highlightLevel[r]&&(this.scratchColor.set(Sn(n.nodes[r].kind)),i.setXYZ(r,this.scratchColor.r,this.scratchColor.g,this.scratchColor.b),this.highlightLevel[r]=0);if(t>=0&&t<this.nodeCount){let r=new zt("#ffffff");for(let o of e)o<0||o>=this.nodeCount||(this.scratchColor.set(Sn(n.nodes[o].kind)).lerp(r,.28),i.setXYZ(o,this.scratchColor.r,this.scratchColor.g,this.scratchColor.b),this.highlightLevel[o]=1);this.scratchColor.set(Sn(n.nodes[t].kind)).lerp(r,.5),i.setXYZ(t,this.scratchColor.r,this.scratchColor.g,this.scratchColor.b),this.highlightLevel[t]=2,this.selected=t}else this.selected=-1;i.needsUpdate=!0}}updateHalo(t,e){let n=this.graph;if(!n||this.selected<0||this.selected*3+2>=e.length){this.halo.visible=!1;return}let i=this.selected,r=wn(n.nodes[i])*this.unit*1.4,o=1+Math.sin(t*.0035)*.07;this.halo.visible=!0,this.halo.position.set(e[i*3],e[i*3+1],e[i*3+2]),this.halo.scale.setScalar(r*2.6*o)}invalidateLabels(){this.grid.clear();for(let t of this.spritePool)t.sprite.visible=!1,t.index=-1;this.labelCursor=0,this.labelsShown=0}textureFor(t,e){let n=(e?"E|":"N|")+t,i=this.textureCache.get(n);if(i)return i;if(this.textureCache.size>this.maxLabels*4){let x=Array.from(this.textureCache.keys()).slice(0,this.maxLabels*2);for(let p of x)this.textureCache.get(p)?.dispose(),this.textureCache.delete(p)}let r=Math.min(2,window.devicePixelRatio||1),o=15*r,a="600 "+o+'px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',c=t.length>24?t.slice(0,23)+"\u2026":t,l=document.createElement("canvas"),h=l.getContext("2d"),u=32;h&&(h.font=a,u=Math.ceil(h.measureText(c).width));let d=Math.ceil(o*.55);l.width=Math.max(8,u+d*2),l.height=Math.ceil(o*1.9);let m=l.getContext("2d");if(m){m.font=a,m.textBaseline="middle",m.textAlign="left";let x=l.height*.34;m.fillStyle=e?"rgba(12, 26, 40, 0.92)":"rgba(6, 11, 18, 0.74)",hl(m,1,1,l.width-2,l.height-2,x),m.fill(),m.strokeStyle=e?"rgba(130, 220, 255, 0.75)":"rgba(110, 170, 210, 0.28)",m.lineWidth=Math.max(1,r),hl(m,1,1,l.width-2,l.height-2,x),m.stroke(),m.fillStyle=e?"#f2fbff":"#cfe4f5",m.fillText(c,d,l.height/2+1)}let v=new Ki(l);return v.colorSpace=oe,v.needsUpdate=!0,this.textureCache.set(n,v),v}acquireSlot(){for(let i of this.spritePool)if(i.index<0)return i;if(this.spritePool.length>=this.maxLabels)return null;let t=new Si({transparent:!0,depthTest:!1,depthWrite:!1,toneMapped:!1}),e=new Yi(t);e.renderOrder=10,e.visible=!1,this.overlayScene.add(e);let n={sprite:e,material:t,index:-1,offX:0,offY:0,w:0,h:0,rect:{x:0,y:0,w:0,h:0}};return this.spritePool.push(n),n}updateLabels(t,e,n,i,r){let o=this.graph;if(!o){this.labelsShown=0;return}let a=this.nodeCount,c=new L,l=new Lt,h=Math.min(2,window.devicePixelRatio||1),u=[];for(let b=0;b<a;b++)c.set(i[b*3],i[b*3+1],i[b*3+2]),t.containsPoint(c)&&u.push(b);u.sort((b,S)=>n[S]-n[b]);let d=Math.min(this.maxLabels,u.length),m=new Set;for(let b=0;b<d;b++)m.add(u[b]);this.evictCounter=0;for(let b of this.spritePool){if(b.index<0)continue;if(!m.has(b.index)){b.sprite.visible=!1,b.index=-1,this.evictCounter++;continue}let S=e(b.index,l).x,T=l.y;b.rect.x=S+b.offX-b.w/2,b.rect.y=T+b.offY-b.h/2,b.sprite.position.set(S+b.offX,r.height-(T+b.offY),0)}if(!d){this.labelsShown=0;return}let v=Math.max(1,Math.round(d*this.churn));this.labelCursor=(this.labelCursor+v)%d;let x=this.labelCursor,p=Math.min(d,x+v),f=new Set;for(let b=0;b<d;b++)(b<2||b>=x&&b<p)&&f.add(u[b]);for(let b of this.spritePool)b.index>=0&&f.has(b.index)&&(b.sprite.visible=!1,b.index=-1);this.grid.clear();for(let b of this.spritePool)b.sprite.visible&&this.grid.add(b.rect.x,b.rect.y,b.rect.w,b.rect.h);let g=0;for(let b=0;b<d;b++){let S=u[b];if(!f.has(S))continue;if(g>v+2)break;g++;let T=o.nodes[S],C=e(S,l);if(C.x<-400||C.y<-120||C.x>r.width+400||C.y>r.height+120)continue;let P=this.acquireSlot();if(!P)break;let y=this.textureFor(T.label,b<2),w=y.image,F=w.width/h,B=w.height/h,W=!1,R=0,D=0;for(let[H,k]of cl){let N=C.x+H*(F*.5+14),V=C.y+k*(B*.62+12),K=N-F/2,$=V-B/2;if(!(K<2||$<2||K+F>r.width-2||$+B>r.height-2)&&!this.grid.hits(K,$,F,B)){this.grid.add(K,$,F,B),R=N-C.x,D=V-C.y,P.rect.x=K,P.rect.y=$,P.rect.w=F,P.rect.h=B,P.sprite.position.set(N,r.height-V,0),W=!0;break}}W&&(P.index=S,P.offX=R,P.offY=D,P.w=F,P.h=B,P.sprite.visible=!0,P.material.map=y,P.material.needsUpdate=!0,P.sprite.scale.set(F,B,1))}for(let b=0;b<d;b++){let S=u[b];if(this.spritePool.some(D=>D.index===S))continue;let C=e(S,l);if(C.x<-400||C.y<-120||C.x>r.width+400||C.y>r.height+120)continue;let P=this.acquireSlot();if(!P)break;let y=o.nodes[S],w=this.textureFor(y.label,b<2),F=w.image,B=F.width/h,W=F.height/h,R=!1;for(let[D,H]of cl){let k=C.x+D*(B*.5+14),N=C.y+H*(W*.62+12),V=k-B/2,K=N-W/2;if(!(V<2||K<2||V+B>r.width-2||K+W>r.height-2)&&!this.grid.hits(V,K,B,W)){this.grid.add(V,K,B,W),P.index=S,P.offX=k-C.x,P.offY=N-C.y,P.w=B,P.h=W,P.rect.x=V,P.rect.y=K,P.rect.w=B,P.rect.h=W,P.sprite.visible=!0,P.material.map=w,P.material.needsUpdate=!0,P.sprite.position.set(k,r.height-N,0),P.sprite.scale.set(B,W,1),R=!0;break}}if(!R){P.index=-1,P.sprite.visible=!1;continue}}let _=0;for(let b of this.spritePool)b.sprite.visible&&_++;this.labelsShown=_,this.labelStats={candidates:u.length,limit:d,pool:this.spritePool.length,shown:_,evicted:this.evictCounter,viewport:Math.round(r.width)+"x"+Math.round(r.height)}}resizeOverlay(t,e){this.overlayCamera.left=0,this.overlayCamera.right=Math.max(1,t),this.overlayCamera.top=Math.max(1,e),this.overlayCamera.bottom=0,this.overlayCamera.updateProjectionMatrix(),this.overlayCamera.updateMatrixWorld(!0)}dispose(){this.mesh.dispose(),this.material.dispose(),this.iGeometryHi.dispose(),this.iGeometryLo.dispose();for(let t of this.textureCache.values())t.dispose();this.textureCache.clear(),this.haloTexture.dispose(),this.halo.material.dispose()}get currentGraph(){return this.graph}get nodeTotal(){return this.nodeCount}get matrixDummy(){return this.dummy.matrix}};function ll(s,t,e){let n=new Qs(s,t,Math.max(1,e));return n.frustumCulled=!1,n.instanceMatrix.setUsage(Ho),n.count=e,n}function hl(s,t,e,n,i,r){let o=Math.min(r,n/2,i/2);s.beginPath(),s.moveTo(t+o,e),s.lineTo(t+n-o,e),s.quadraticCurveTo(t+n,e,t+n,e+o),s.lineTo(t+n,e+i-o),s.quadraticCurveTo(t+n,e+i,t+n-o,e+i),s.lineTo(t+o,e+i),s.quadraticCurveTo(t,e+i,t,e+i-o),s.lineTo(t,e+o),s.quadraticCurveTo(t,e,t+o,e),s.closePath()}function Um(s,t,e){let n=document.createElement("canvas");n.width=s,n.height=s;let i=n.getContext("2d");if(i){let o=i.createRadialGradient(s/2,s/2,s*.15,s/2,s/2,s/2);o.addColorStop(0,t),o.addColorStop(.55,"rgba(120,210,255,0.28)"),o.addColorStop(1,e),i.fillStyle=o,i.fillRect(0,0,s,s)}let r=new Ki(n);return r.colorSpace=oe,r}var Ci=8,Nm=.22,dl={semantic:"#3f8fb8",hypernym:"#3ecf8e",hyponym:"#2fb37b",part_of:"#57a8d0",instance_of:"#6f8fd0",causes:"#e0803f",contradicts:"#e05252",supports:"#43b581",supersedes:"#b07cf0",derived_from:"#8a7fd0",mentions:"#5b7f9c",temporal_next:"#4aa3df",alias:"#8899aa",prerequisite:"#d0a03f",evidence_for:"#ffd166",contains:"#8a9bb0",in_scope:"#c9b46a",evidence:"#ffd166",document:"#b8a2d8",chunk:"#a58fc9",default:"#557a94"};function Fm(s){return dl[s]??dl.default}var Om=["attribute vec3 positionA;","attribute vec3 positionB;","attribute float aT;","attribute float aEdgeWeight;","attribute vec3 aColor;","uniform float uBow;","varying float vAlpha;","varying vec3 vColor;","void main() {","  vec3 a = positionA;","  vec3 b = positionB;","  vec3 axisVec = b - a;","  float len = length(axisVec);","  vec3 axis = len > 1e-4 ? axisVec / len : vec3(0.0, 1.0, 0.0);","  vec3 mid = (a + b) * 0.5;","  vec3 view = cameraPosition - mid;","  float dist = length(view);","  vec3 viewDir = dist > 1e-4 ? view / dist : vec3(0.0, 0.0, 1.0);","  float facing = abs(dot(axis, viewDir));","  vec3 side = cross(axis, viewDir);","  float sideLen = length(side);","  side = sideLen > 1e-4 ? side / sideLen : vec3(1.0, 0.0, 0.0);","  vec3 control = mid + side * (uBow * len * facing * facing);","  float t = aT;","  float it = 1.0 - t;","  vec3 p = it * it * a + 2.0 * it * t * control + t * t * b;","  vColor = aColor;","  float wAlpha = 0.18 + 0.62 * clamp(aEdgeWeight, 0.0, 1.0);","  float fog = 1.0 - smoothstep(4000.0, 26000.0, dist);","  vAlpha = wAlpha * fog;","  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);","}"].join(`
`),Bm=["varying float vAlpha;","varying vec3 vColor;","uniform float uOpacity;","void main() {","  gl_FragColor = vec4(vColor, vAlpha * uOpacity);","}"].join(`
`),ar=class{constructor(){this.group=new Ei(new pe,new Fe);this.capacity=0;this.edgeCount=0;this.graph=null;this.highlightLines=null;this.material=new Fe({vertexShader:Om,fragmentShader:Bm,uniforms:{uBow:{value:Nm},uOpacity:{value:1}},transparent:!0,depthWrite:!1,blending:Bn}),this.group=new Ei(new pe,this.material),this.group.frustumCulled=!1,this.group.renderOrder=1}get segments(){return this.edgeCount}get vertices(){return this.edgeCount*Ci*2}setOpacity(t){this.material.uniforms.uOpacity.value=Math.max(0,Math.min(1,t))}setBow(t){this.material.uniforms.uBow.value=t}build(t,e,n){this.graph=t;let i=[];for(let r of t.edges){let o=n.get(r.src),a=n.get(r.dst);o===void 0||a===void 0||o===a||i.push(o,a)}this.edgeCount=i.length/2,this.capacity=Math.max(this.edgeCount,1),this.allocate(),this.updateEndpoints(e,i),this.graph}updateEndpoints(t,e){let n=this.group.geometry,i=n.getAttribute("positionA"),r=n.getAttribute("positionB");if(!this.graph)return;let a=i.array,c=r.array,l=Ci*2,h=0;if(e.length)for(let u=0;u<this.edgeCount;u++){let d=e[u*2],m=e[u*2+1],v=t[d*3],x=t[d*3+1],p=t[d*3+2],f=t[m*3],g=t[m*3+1],_=t[m*3+2];for(let b=0;b<l;b++)a[h*3]=v,a[h*3+1]=x,a[h*3+2]=p,c[h*3]=f,c[h*3+1]=g,c[h*3+2]=_,h++}i.needsUpdate=!0,r.needsUpdate=!0,n.computeBoundingSphere()}allocate(){let t=this.group.geometry,e=this.edgeCount*Ci*2,n=new Float32Array(e*3),i=new Float32Array(e*3),r=new Float32Array(e),o=new Float32Array(e),a=new Float32Array(e*3),c=new Float32Array(e*3),l=new Map,h=0;for(let u of this.graph?.edges??[]){let d=l.get(u.rel);d||(d=new zt(Fm(u.rel)),l.set(u.rel,d));for(let m=0;m<Ci;m++)for(let v=0;v<2;v++)r[h]=(m+v)/Ci,o[h]=u.weight,a[h*3]=d.r,a[h*3+1]=d.g,a[h*3+2]=d.b,h++}t.setAttribute("position",new ee(c,3)),t.setAttribute("positionA",new ee(n,3)),t.setAttribute("positionB",new ee(i,3)),t.setAttribute("aT",new ee(r,1)),t.setAttribute("aEdgeWeight",new ee(o,1)),t.setAttribute("aColor",new ee(a,3)),t.setDrawRange(0,e)}highlightPath(t,e){if(this.clearHighlight(),t.length<2)return;let n=(t.length-1)*2,i=new Float32Array(n*3);for(let o=0;o<t.length-1;o++){let a=t[o],c=t[o+1];i[o*6]=e[a*3],i[o*6+1]=e[a*3+1],i[o*6+2]=e[a*3+2],i[o*6+3]=e[c*3],i[o*6+4]=e[c*3+1],i[o*6+5]=e[c*3+2]}let r=new pe;r.setAttribute("position",new ee(i,3)),this.highlightLines=new Ei(r,new Zi({color:9433343,transparent:!0,opacity:.95,depthWrite:!1,blending:Bn})),this.highlightLines.frustumCulled=!1,this.highlightLines.renderOrder=3,this.group.add(this.highlightLines)}clearHighlight(){this.highlightLines&&(this.group.remove(this.highlightLines),this.highlightLines.geometry.dispose(),this.highlightLines.material.dispose(),this.highlightLines=null)}setNeighborEmphasis(t,e,n){let i=this.graph;if(!i)return;let o=this.group.geometry.getAttribute("aEdgeWeight"),a=o.array,c=new Set(e),l=Ci*2,h=0;for(let u of i.edges){let d=n.get(u.src),m=n.get(u.dst),x=t>=0&&(d===t||m===t||d!==void 0&&c.has(d)&&m!==void 0&&c.has(m))?Math.min(1,u.weight*1.35+.4):u.weight*.55;for(let p=0;p<l;p++)a[h++]=x}o.needsUpdate=!0}dispose(){this.clearHighlight(),this.group.geometry.dispose(),this.material.dispose()}};var zm=1.15,km=1.4,Vm=520;function Hm(s,t){let e=new L().subVectors(t,s);if(e.lengthSq()<1e-12)return{x:0,y:0,z:0,w:1};e.normalize();let n=Math.abs(e.y)>.9999?new L(1,0,0):new L(0,1,0),i=new L().crossVectors(n,e).normalize(),r=new L().crossVectors(e,i).normalize(),o=i.x,a=r.x,c=-e.x,l=i.y,h=r.y,u=-e.y,d=i.z,m=r.z,v=-e.z,x=o+h+v,p={x:0,y:0,z:0,w:1};if(x>0){let g=.5/Math.sqrt(x+1);p.w=.25/g,p.x=(m-u)*g,p.y=(c-d)*g,p.z=(l-a)*g}else if(o>h&&o>v){let g=2*Math.sqrt(1+o-h-v);p.w=(m-u)/g,p.x=.25*g,p.y=(a+l)/g,p.z=(c+d)/g}else if(h>v){let g=2*Math.sqrt(1+h-o-v);p.w=(c-d)/g,p.x=(a+l)/g,p.y=.25*g,p.z=(u+m)/g}else{let g=2*Math.sqrt(1+v-o-h);p.w=(l-a)/g,p.x=(c+d)/g,p.y=(u+m)/g,p.z=.25*g}let f=Math.hypot(p.x,p.y,p.z,p.w)||1;return p.x/=f,p.y/=f,p.z/=f,p.w/=f,p}var cr=class{constructor(t){this.selected=-1;this.neighbors=[];this.hops=1;this.pathFrom=-1;this.pathTo=-1;this.pathHops=1;this.pathMode=!1;this.pushAmount=new Float32Array(0);this.scaleAmount=new Float32Array(0);this.tmp=new L;this.tmp2=new L;this.ndc=new Lt;this.disposed=!1;this.dragMode="none";this.lastX=0;this.lastY=0;this.downX=0;this.downY=0;this.pointerId=-1;this.eventCounts={down:0,up:0,move:0,wheel:0,pickHit:0,pickMiss:0};this.lastPick={px:0,py:0,best:-1,bestDist:0,bestTol:0,considered:0};this.onPointerDown=t=>{this.eventCounts.down++;let e=this.host.scene.canvas;try{e.setPointerCapture(t.pointerId)}catch{}this.pointerId=t.pointerId,this.lastX=this.downX=t.clientX,this.lastY=this.downY=t.clientY,this.dragMode=t.button===2||t.button===1?"pan":"orbit"};this.onPointerMove=t=>{if(this.eventCounts.move++,this.dragMode==="none"||t.pointerId!==this.pointerId)return;let e=t.clientX-this.lastX,n=t.clientY-this.lastY;this.lastX=t.clientX,this.lastY=t.clientY,this.dragMode==="orbit"?this.host.scene.orbit(e,n):this.host.scene.pan(e,n)};this.onPointerUp=t=>{this.eventCounts.up++;let e=this.host.scene.canvas;try{e.releasePointerCapture(t.pointerId)}catch{}let n=Math.hypot(t.clientX-this.downX,t.clientY-this.downY);if(this.dragMode="none",this.pointerId=-1,n>5)return;let i=this.pick(t.clientX,t.clientY);if(i<0){this.eventCounts.pickMiss++,this.select(-1);return}if(this.eventCounts.pickHit++,this.pathMode){this.handlePathPick(i);return}this.select(i,t.shiftKey?2:1)};this.onWheel=t=>{t.preventDefault(),this.host.scene.zoom(t.deltaY)};this.onDoubleClick=t=>{let e=this.pick(t.clientX,t.clientY);e>=0?this.select(e,this.hops,!0):this.host.onStatus("\u8FD9\u91CC\u6CA1\u6709\u8282\u70B9")};this.onContextMenu=t=>{t.preventDefault()};this.onKeyDown=t=>{let e=t.target;if(e&&(e.tagName==="INPUT"||e.tagName==="TEXTAREA"||e.isContentEditable)){t.key==="Escape"&&e?.blur();return}if(t.key===" ")t.preventDefault(),this.resetView();else if(t.key==="Escape"){if(this.pathMode){this.setPathMode(!1);return}this.select(-1)}};this.host=t,this.bind()}get selection(){return this.selected}get selectedNeighbors(){return this.neighbors}get isPathMode(){return this.pathMode}resetSelection(){this.selected=-1,this.neighbors=[],this.pathFrom=-1,this.pathTo=-1;let t=this.host.state()?.graph.nodes.length??0;this.pushAmount=new Float32Array(t),this.scaleAmount=new Float32Array(t),this.host.edges.clearHighlight()}pick(t,e){let n=this.host.state();if(!n)return-1;let i=this.host.scene.camera,r=this.host.scene.canvas.getBoundingClientRect(),o=t-r.left,a=e-r.top,c=-1,l=1/0;this.lastPick.bestDist=-1,this.lastPick.bestTol=0;let h=this.tmp;for(let u=0;u<n.graph.nodes.length;u++){h.set(n.renderPositions[u*3],n.renderPositions[u*3+1],n.renderPositions[u*3+2]);let d=h.clone().project(i);if(d.z>1)continue;let m=(d.x*.5+.5)*r.width,v=(-d.y*.5+.5)*r.height,x=m-o,p=v-a,f=x*x+p*p,g=wn(n.graph.nodes[u])*this.host.nodes.worldUnit*(this.scaleAmount[u]||1),_=this.host.scene.pixelsPerWorldUnit,b=Math.max(10,g*_);if(f>b*b){(f<this.lastPick.bestDist||this.lastPick.best<0)&&(this.lastPick.bestDist=Math.sqrt(f),this.lastPick.bestTol=b);continue}let S=f;S<l&&(l=S,c=u)}return this.lastPick.px=o,this.lastPick.py=a,this.lastPick.best=c,this.lastPick.considered=n.graph.nodes.length,c}select(t,e=this.hops,n=!0){let i=this.host.state();if(!i)return;if(t===this.selected&&e===this.hops){n&&this.focusOn(t);return}if(this.hops=e,this.selected=t,t<0){this.neighbors=[],this.host.nodes.setHighlight(-1,[]),this.host.edges.setNeighborEmphasis(-1,[],i.index),this.host.onSelect(-1,e);return}let r=new Set([t]),o=[t],a=[];for(let c=0;c<e;c++){let l=[];for(let h of o)for(let u of i.neighbors[h]??[])r.has(u)||(r.add(u),a.push(u),l.push(u));o=l}this.neighbors=a,this.host.nodes.setHighlight(t,a),this.host.edges.setNeighborEmphasis(t,a,i.index),this.host.onSelect(t,e),n&&this.focusOn(t)}focusOn(t){let e=this.host.state();if(!e||t<0)return;let n=this.host.scene,i=e.graph.nodes[t],r=new L(e.renderPositions[t*3],e.renderPositions[t*3+1],e.renderPositions[t*3+2]),o=this.host.nodes.worldUnit,a=new L().copy(r),c=wn(i)*o*2.2,l=new Set([t,...this.neighbors]);for(let x of l){let f=this.tmp2.set(e.renderPositions[x*3],e.renderPositions[x*3+1],e.renderPositions[x*3+2]).distanceTo(r);f>c&&(c=f)}if(this.neighbors.length){let x=this.farthestNeighbor(e,t);if(x>=0){let p=new L(e.renderPositions[x*3],e.renderPositions[x*3+1],e.renderPositions[x*3+2]);a.lerpVectors(r,p,.35)}}c=Math.max(c*1.15,c+wn(i)*o*2);let h=this.host.projection(),u;if(h==="perspective"){let x=n.perspective.fov*Math.PI/180,p=Math.max(.2,n.perspective.aspect),f=x,g=2*Math.atan(Math.tan(x/2)*p);u=Math.max(c/Math.tan(f/2),c/Math.tan(g/2))*1.05,u=Math.max(u,wn(i)*o*6),u=Math.min(u,3e4)}else{let x=n.canvas.clientHeight,p=Math.max(c/Math.max(1e-6,n.orthographic.top),.001);u=x*.5*p*1.1}let d=new L().subVectors(a,n.currentPosition());d.lengthSq()<1e-6&&d.set(0,0,1),d.normalize().multiplyScalar(u);let m=new L().addVectors(a,d),v=Hm(m,a);n.flyTo(a,u,v,Vm)}farthestNeighbor(t,e){let n=-1,i=-1,r=t.renderPositions[e*3],o=t.renderPositions[e*3+1],a=t.renderPositions[e*3+2];for(let c of this.neighbors){let l=t.renderPositions[c*3]-r,h=t.renderPositions[c*3+1]-o,u=t.renderPositions[c*3+2]-a,d=l*l+h*h+u*u;d>i&&(i=d,n=c)}return n}applyDisplacement(t){let e=this.host.state();if(!e)return;let n=e.graph.nodes.length;this.pushAmount.length!==n&&(this.pushAmount=new Float32Array(n),this.scaleAmount=new Float32Array(n));let i=this.pushAmount,r=1-Math.exp(-t/.12),o=this.selected,a=new Set(this.neighbors),c=o>=0?e.positions[o*3]:0,l=o>=0?e.positions[o*3+1]:0,h=o>=0?e.positions[o*3+2]:0;for(let u=0;u<n;u++){let d=o>=0&&a.has(u)?1:0;i[u]+=(d-i[u])*r;let m=u===o?km:1;this.scaleAmount[u]+=(m-this.scaleAmount[u])*r,this.scaleAmount[u]===0&&(this.scaleAmount[u]=1);let v=e.positions[u*3],x=e.positions[u*3+1],p=e.positions[u*3+2],f=i[u];if(f>.001&&o>=0){let g=v-c,_=x-l,b=p-h,S=Math.sqrt(g*g+_*_+b*b);if(S>.001){let T=f*zm*wn(e.graph.nodes[u])*this.host.nodes.worldUnit;v+=g/S*T,x+=_/S*T,p+=b/S*T}}e.renderPositions[u*3]=v,e.renderPositions[u*3+1]=x,e.renderPositions[u*3+2]=p}this.host.nodes.writeMatrices(e.renderPositions,this.scaleAmount)}setPathMode(t){this.pathMode=t,this.pathFrom=-1,this.pathTo=-1,this.host.edges.clearHighlight(),this.host.onStatus(t?"\u8DEF\u5F84\u67E5\u627E\uFF1A\u4F9D\u6B21\u70B9\u51FB\u4E24\u4E2A\u8282\u70B9\uFF08Esc \u53D6\u6D88\uFF09":"")}handlePathPick(t){let e=this.host.state();if(!e)return;if(this.pathFrom<0){this.pathFrom=t,this.host.onStatus("\u8D77\u70B9\uFF1A"+e.graph.nodes[t].label+"\uFF0C\u518D\u70B9\u4E00\u4E2A\u7EC8\u70B9");return}this.pathTo=t;let n=Yo(e.neighbors,this.pathFrom,this.pathTo);if(!n.length){this.host.onStatus("\u8FD9\u4E24\u4E2A\u8282\u70B9\u4E4B\u95F4\u6CA1\u6709\u8DEF\u5F84"),this.host.edges.clearHighlight(),this.pathFrom=-1;return}this.host.edges.highlightPath(n,e.renderPositions),this.host.onStatus("\u6700\u77ED\u8DEF\u5F84\uFF1A"+(n.length-1)+" \u8DF3\uFF0C"+n.length+" \u4E2A\u8282\u70B9"),this.pathFrom=-1,this.pathTo=-1}bind(){let t=this.host.scene.canvas;t.addEventListener("pointerdown",this.onPointerDown),t.addEventListener("pointermove",this.onPointerMove),t.addEventListener("pointerup",this.onPointerUp),t.addEventListener("pointercancel",this.onPointerUp),t.addEventListener("wheel",this.onWheel,{passive:!1}),t.addEventListener("dblclick",this.onDoubleClick),t.addEventListener("contextmenu",this.onContextMenu),window.addEventListener("keydown",this.onKeyDown)}resetView(){this.select(-1);let t=this.host.state(),e=this.host.scene.frameRadius(t?.graph?Qi(t):500);this.host.scene.reset(e),this.host.onStatus("\u5DF2\u590D\u4F4D")}dispose(){if(this.disposed)return;this.disposed=!0;let t=this.host.scene.canvas;t.removeEventListener("pointerdown",this.onPointerDown),t.removeEventListener("pointermove",this.onPointerMove),t.removeEventListener("pointerup",this.onPointerUp),t.removeEventListener("pointercancel",this.onPointerUp),t.removeEventListener("wheel",this.onWheel),t.removeEventListener("dblclick",this.onDoubleClick),t.removeEventListener("contextmenu",this.onContextMenu),window.removeEventListener("keydown",this.onKeyDown)}};function Qi(s){let t=1,e=s.positions;for(let n=0;n<s.graph.nodes.length;n++){let i=Math.hypot(e[n*3],e[n*3+1],e[n*3+2]);i>t&&(t=i)}return t}function Yo(s,t,e){if(t<0||e<0)return[];if(t===e)return[t];let n=new Int32Array(s.length).fill(-1),i=new Uint8Array(s.length),r=[t];i[t]=1;for(let o=0;o<r.length;o++){let a=r[o];for(let c of s[a]??[])if(!i[c]){if(i[c]=1,n[c]=a,c===e){let l=[e],h=e;for(;n[h]>=0;)h=n[h],l.push(h);return l.reverse()}r.push(c)}}return[]}var ts={fact:"\u4E8B\u5B9E",knowledge:"\u77E5\u8BC6",decision:"\u51B3\u7B56",preference:"\u504F\u597D",procedure:"\u6D41\u7A0B",experience:"\u7ECF\u9A8C",task:"\u4EFB\u52A1",turn:"\u5BF9\u8BDD",tool:"\u5DE5\u5177",artifact:"\u4EA7\u7269",concept:"\u6982\u5FF5",entity:"\u5B9E\u4F53",person:"\u4EBA\u7269",project:"\u9879\u76EE",term:"\u672F\u8BED",memory:"\u8BB0\u5FC6",evidence:"\u8BC1\u636E",source:"\u6765\u6E90",document:"\u6587\u6863",scope:"\u4F5C\u7528\u57DF",day:"\u65E5\u671F",chunk:"\u5207\u5757"},Zo={semantic:"\u8BCD\u4E49\u8111\u56FE",hierarchy:"\u5C42\u7EA7\u8111\u56FE",timeline:"\u65F6\u95F4\u7EBF",evidence:"\u8BC1\u636E\u94FE"},hr=class{constructor(t,e){this.els={};this.kindChips=new Map;this.minimap=null;this.minimapCtx=null;this.handlers=e,this.root=document.createElement("div"),this.root.className="mem-brain-ui",this.root.innerHTML=Gm,t.appendChild(this.root),this.cacheElements(),this.wire(),this.minimap=this.els.minimap,this.minimapCtx=this.minimap.getContext("2d")}cacheElements(){let t=["views","dimsToggle","kindChips","scopeSelect","rangeSelect","search","searchList","minimap","stats","legend","watermark","exportBtn","resetBtn","pathBtn","status","loading","note"];for(let e of t){let n=this.root.querySelector('[data-el="'+e+'"]');n&&(this.els[e]=n)}}wire(){this.els.views.addEventListener("click",t=>{let e=t.target.closest("button[data-view]");e&&e.dataset.view&&this.handlers.onView(e.dataset.view)}),this.els.dimsToggle.addEventListener("click",t=>{let e=t.target.closest("button[data-dims]");e&&e.dataset.dims&&this.handlers.onDims(Number(e.dataset.dims))}),this.els.scopeSelect.addEventListener("change",()=>this.emitFilter()),this.els.rangeSelect.addEventListener("change",()=>this.emitFilter()),this.els.kindChips.addEventListener("click",t=>{let e=t.target.closest("button[data-kind]");e&&(e.classList.toggle("is-off"),this.emitFilter())}),this.els.search.addEventListener("input",()=>{this.handlers.onSearch(this.els.search.value.trim())}),this.els.searchList.addEventListener("click",t=>{let e=t.target.closest("button[data-hit]");e&&e.dataset.hit!==void 0&&this.handlers.onSearchPick(Number(e.dataset.hit))}),this.els.exportBtn.addEventListener("click",()=>this.handlers.onExport()),this.els.resetBtn.addEventListener("click",()=>this.handlers.onReset()),this.els.pathBtn.addEventListener("click",()=>{this.els.pathBtn.classList.toggle("is-active"),this.handlers.onPathMode(this.els.pathBtn.classList.contains("is-active"))}),window.addEventListener("keydown",t=>{let e=t.target,n=e!==null&&(e.tagName==="INPUT"||e.tagName==="TEXTAREA");if(t.key==="/"&&!n){t.preventDefault();let i=this.els.search;i.focus(),i.select()}})}emitFilter(){let t=new Set;for(let e of this.kindChips){let[n,i]=e;i.classList.contains("is-off")||t.add(n)}this.handlers.onFilter({kinds:t,scope:this.els.scopeSelect.value,range:this.els.rangeSelect.value})}render(t){for(let e of Array.from(this.els.views.querySelectorAll("button[data-view]")))e.classList.toggle("is-active",e.dataset.view===t.view);this.els.dimsToggle.style.display=t.view==="hierarchy"?"":"none";for(let e of Array.from(this.els.dimsToggle.querySelectorAll("button[data-dims]")))e.classList.toggle("is-active",Number(e.dataset.dims)===t.dims);this.els.watermark.style.display=t.demo?"":"none",this.els.loading.style.display=t.loading?"":"none",this.els.note.textContent!==t.note&&(this.els.note.textContent=t.note),this.els.stats.innerHTML="<div><span>\u8282\u70B9</span><b>"+t.nodeCount.toLocaleString()+"</b></div><div><span>\u8FB9</span><b>"+t.edgeCount.toLocaleString()+"</b></div><div><span>\u6807\u7B7E</span><b>"+t.labels+'</b></div><div><span>\u5E27\u7387</span><b class="'+(t.fps>0&&t.fps<40?"is-warn":"")+'">'+(t.fps>0?t.fps.toFixed(0):"--")+"</b></div><div><span>\u5E03\u5C40</span><b>"+(t.layoutMode==="worker"?"Worker":"\u4E3B\u7EBF\u7A0B")+"</b></div>"}renderLegend(t,e){let n=new Set;for(let r of t.nodes)n.add(r.kind);let i=Array.from(n).sort();this.kindChips.clear(),this.els.kindChips.innerHTML="",this.els.legend.innerHTML="";for(let r of i){let o=e[r]??e.default??"#8fa3bd",a=document.createElement("button");a.type="button",a.dataset.kind=r,a.className="mem-chip",a.innerHTML='<i style="background:'+o+'"></i>'+lr(ts[r]??r),this.els.kindChips.appendChild(a),this.kindChips.set(r,a);let c=document.createElement("div");c.className="mem-legend-row",c.innerHTML='<i style="background:'+o+'"></i><span>'+lr(ts[r]??r)+"</span>",this.els.legend.appendChild(c)}i.length||(this.els.legend.innerHTML='<div class="mem-muted">\u6CA1\u6709\u8282\u70B9</div>')}renderScopes(t){let e=this.els.scopeSelect,n=e.value;e.innerHTML='<option value="">\u5168\u90E8\u4F5C\u7528\u57DF</option>';for(let i of t.slice(0,200)){let r=document.createElement("option");r.value=i,r.textContent=i,e.appendChild(r)}n&&(e.value=n)}renderSearch(t){let e=this.els.searchList;if(!t.length){e.innerHTML="",e.classList.remove("is-open");return}e.innerHTML=t.slice(0,12).map(n=>'<button type="button" data-hit="'+n.index+'"><b>'+lr(n.label)+"</b><span>"+lr(ts[n.kind]??n.kind)+"</span></button>").join(""),e.classList.add("is-open")}setStatus(t){this.els.status.textContent!==t&&(this.els.status.textContent=t)}drawMinimap(t,e,n,i){let r=this.minimap,o=this.minimapCtx;if(!r||!o)return;let a=Math.min(2,window.devicePixelRatio||1),c=r.clientWidth||160,l=r.clientHeight||160;(r.width!==Math.round(c*a)||r.height!==Math.round(l*a))&&(r.width=Math.round(c*a),r.height=Math.round(l*a)),o.setTransform(a,0,0,a,0,0),o.clearRect(0,0,c,l),o.fillStyle="rgba(7, 13, 21, 0.72)",o.fillRect(0,0,c,l);let h=e.length;if(!h)return;let u=1/0,d=-1/0,m=1/0,v=-1/0;for(let S=0;S<h;S++){let T=t[S*3],C=t[S*3+1];T<u&&(u=T),T>d&&(d=T),C<m&&(m=C),C>v&&(v=C)}let x=Math.max(.001,d-u),p=Math.max(.001,v-m),f=6,g=Math.min((c-f*2)/x,(l-f*2)/p),_=(c-x*g)/2,b=(l-p*g)/2;for(let S=0;S<h;S++){let T=_+(t[S*3]-u)*g,C=l-(b+(t[S*3+1]-m)*g);o.fillStyle=S===i?"#ffffff":n[e[S]]??"#8fa3bd";let P=S===i?2.6:1.1;o.fillRect(T-P,C-P,P*2,P*2)}o.strokeStyle="rgba(120, 200, 240, 0.45)",o.lineWidth=1,o.strokeRect(_,b,x*g,p*g)}onMinimapClick(t){let e=this.minimap;e&&e.addEventListener("click",n=>{let i=e.getBoundingClientRect();t((n.clientX-i.left)/Math.max(1,i.width),(n.clientY-i.top)/Math.max(1,i.height))})}dispose(){this.root.remove()}};function lr(s){return s.replace(/[&<>"']/g,t=>t==="&"?"&amp;":t==="<"?"&lt;":t===">"?"&gt;":t==='"'?"&quot;":"&#39;")}var Gm=['<div class="mem-topbar">','  <div class="mem-group mem-views" data-el="views">','    <button type="button" data-view="semantic" class="is-active">\u8BCD\u4E49\u8111\u56FE</button>','    <button type="button" data-view="hierarchy">\u5C42\u7EA7\u8111\u56FE</button>','    <button type="button" data-view="timeline">\u65F6\u95F4\u7EBF</button>','    <button type="button" data-view="evidence">\u8BC1\u636E\u94FE</button>',"  </div>",'  <div class="mem-group mem-dims" data-el="dimsToggle" style="display:none">','    <button type="button" data-dims="2">2D \u6B63\u4EA4</button>','    <button type="button" data-dims="3">3D \u5F84\u5411</button>',"  </div>",'  <div class="mem-spacer"></div>','  <div class="mem-searchbox">','    <input data-el="search" type="search" placeholder="\u641C\u7D22\u8282\u70B9\uFF08/\uFF09" autocomplete="off" spellcheck="false">','    <div class="mem-search-list" data-el="searchList"></div>',"  </div>",'  <div class="mem-group">','    <button type="button" data-el="resetBtn" title="\u590D\u4F4D\u89C6\u89D2\uFF08Space\uFF09">\u590D\u4F4D</button>','    <button type="button" data-el="pathBtn" title="\u8DEF\u5F84\u67E5\u627E\uFF1A\u4F9D\u6B21\u70B9\u4E24\u4E2A\u8282\u70B9">\u8DEF\u5F84</button>','    <button type="button" data-el="exportBtn" title="\u5BFC\u51FA\u5F53\u524D\u753B\u9762\u4E3A PNG">\u5BFC\u51FA PNG</button>',"  </div>","</div>",'<div class="mem-filter">','  <div class="mem-filter-title">\u8FC7\u6EE4</div>','  <div class="mem-chips" data-el="kindChips"></div>','  <div class="mem-filter-row">','    <label>\u4F5C\u7528\u57DF<select data-el="scopeSelect"><option value="">\u5168\u90E8\u4F5C\u7528\u57DF</option></select></label>',"  </div>",'  <div class="mem-filter-row">','    <label>\u65F6\u95F4<select data-el="rangeSelect">','      <option value="all">\u5168\u90E8</option>','      <option value="7d">\u8FD1 7 \u5929</option>','      <option value="30d">\u8FD1 30 \u5929</option>','      <option value="365d">\u8FD1\u4E00\u5E74</option>',"    </select></label>","  </div>","</div>",'<div class="mem-watermark" data-el="watermark" style="display:none">\u6F14\u793A\u6570\u636E</div>','<div class="mem-loading" data-el="loading" style="display:none">\u5E03\u5C40\u8BA1\u7B97\u4E2D\u2026</div>','<div class="mem-minimap-wrap"><canvas data-el="minimap" class="mem-minimap" width="160" height="160"></canvas></div>','<div class="mem-stats" data-el="stats"></div>','<div class="mem-legend" data-el="legend"></div>','<div class="mem-statusbar"><span data-el="status"></span><span class="mem-note" data-el="note"></span></div>'].join("");function es(){function e(g){let _=g>>>0;return function(){_=_+1831565813>>>0;let S=_;return S=Math.imul(S^S>>>15,S|1),S^=S+Math.imul(S^S>>>7,S|61),((S^S>>>14)>>>0)/4294967296}}function n(g){let _=2166136261;for(let b=0;b<g.length;b++)_=Math.imul(_^g.charCodeAt(b),16777619);return _>>>0}function i(g,_){return typeof g=="number"&&isFinite(g)&&g>0?g:_}function r(g){return{positions:new Float32Array(0),dims:g,meta:{radius:1}}}function o(g,_,b,S){let T=0,C=0,P=0;for(let y=0;y<S;y++)T+=g[y],C+=_[y],P+=b[y];T/=S,C/=S,P/=S;for(let y=0;y<S;y++)g[y]-=T,_[y]-=C,b[y]-=P}function a(g,_,b,S,T,C){let P=new Float32Array(S*3),y=1/0,w=-1/0,F=1/0,B=-1/0,W=1/0,R=-1/0;for(let k=0;k<S;k++)P[k*3]=g[k],P[k*3+1]=_[k],P[k*3+2]=b[k],g[k]<y&&(y=g[k]),g[k]>w&&(w=g[k]),_[k]<F&&(F=_[k]),_[k]>B&&(B=_[k]),b[k]<W&&(W=b[k]),b[k]>R&&(R=b[k]);S||(y=w=F=B=W=R=0);let D=Math.max(w-y,B-F,T===3?R-W:0),H={radius:Math.max(1,D*.5),bounds:{minX:y,maxX:w,minY:F,maxY:B,minZ:W,maxZ:R},...C};return{positions:P,dims:T,meta:H}}function c(){return{mass:new Float64Array(0),comX:new Float64Array(0),comY:new Float64Array(0),comZ:new Float64Array(0),half:new Float64Array(0),child:new Int32Array(0),start:new Int32Array(0),count:new Int32Array(0),points:new Int32Array(0),root:0,cells:0,bufA:new Int32Array(0),bufB:new Int32Array(0),stackF:new Float64Array(0),stackI:new Int32Array(0)}}function l(g,_,b,S,T){if(!T)return g.cells=0,g.root=-1,g;let C=1/0,P=1/0,y=1/0,w=-1/0,F=-1/0,B=-1/0;for(let M=0;M<T;M++)_[M]<C&&(C=_[M]),b[M]<P&&(P=b[M]),S[M]<y&&(y=S[M]),_[M]>w&&(w=_[M]),b[M]>F&&(F=b[M]),S[M]>B&&(B=S[M]);let W=(C+w)/2,R=(P+F)/2,D=(y+B)/2,H=Math.max(w-C,F-P,B-y,1e-6)/2,k=Math.max(64,T*2+8);g.mass.length<k&&(g.mass=new Float64Array(k),g.comX=new Float64Array(k),g.comY=new Float64Array(k),g.comZ=new Float64Array(k),g.half=new Float64Array(k),g.child=new Int32Array(k*8),g.start=new Int32Array(k),g.count=new Int32Array(k)),g.points.length<T&&(g.points=new Int32Array(T));let{mass:N,comX:V,comY:K,comZ:$,half:ct,child:G,start:J,count:ot,points:nt}=g,ht=0,xt=0;g.bufA.length<T&&(g.bufA=new Int32Array(T),g.bufB=new Int32Array(T));let Y=g.bufA,lt=g.bufB;for(let M=0;M<T;M++)Y[M]=M;let pt=Math.max(64,T+8);g.stackF.length<pt*8&&(g.stackF=new Float64Array(pt*8),g.stackI=new Int32Array(pt*2));let U=g.stackF,bt=g.stackI,et=0;function at(M,O,tt,j){let Q=ht++;ct[Q]=M,V[Q]=O,K[Q]=tt,$[Q]=j,N[Q]=0,J[Q]=-1,ot[Q]=0;let _t=Q*8;return G[_t]=-1,G[_t+1]=-1,G[_t+2]=-1,G[_t+3]=-1,G[_t+4]=-1,G[_t+5]=-1,G[_t+6]=-1,G[_t+7]=-1,Q}let it=at(H,W,R,D);bt[et*2]=it,bt[et*2+1]=0,U[et*8]=0,U[et*8+1]=T,U[et*8+2]=W,U[et*8+3]=R,U[et*8+4]=D,U[et*8+5]=H,U[et*8+6]=0,et++;let wt=new Int32Array(8),Mt=new Int32Array(8),E=new Int32Array(8);for(;et>0;){et--;let M=bt[et*2],O=bt[et*2+1],tt=U[et*8],j=U[et*8+1],Q=U[et*8+2],_t=U[et*8+3],ft=U[et*8+4],yt=U[et*8+5],At=j-tt,Ut=0,st=0,Xt=0;for(let rt=tt;rt<j;rt++){let St=Y[rt];Ut+=_[St],st+=b[St],Xt+=S[St]}if(N[M]=At,V[M]=Ut/At,K[M]=st/At,$[M]=Xt/At,ot[M]=At,At<=1||O>=20){J[M]=xt;for(let rt=tt;rt<j;rt++)nt[xt++]=Y[rt];continue}wt[0]=wt[1]=wt[2]=wt[3]=0,wt[4]=wt[5]=wt[6]=wt[7]=0;for(let rt=tt;rt<j;rt++){let St=Y[rt],Wt=(_[St]>=Q?1:0)|(b[St]>=_t?2:0)|(S[St]>=ft?4:0);wt[Wt]++}let Ft=tt;for(let rt=0;rt<8;rt++)Mt[rt]=Ft,E[rt]=Ft,Ft+=wt[rt];for(let rt=tt;rt<j;rt++){let St=Y[rt],Wt=(_[St]>=Q?1:0)|(b[St]>=_t?2:0)|(S[St]>=ft?4:0);lt[E[Wt]++]=St}let Ct=yt*.5;for(let rt=0;rt<8;rt++){if(!wt[rt])continue;let St=Q+(rt&1?Ct:-Ct),Wt=_t+(rt&2?Ct:-Ct),jt=ft+(rt&4?Ct:-Ct),Ot=at(Ct,St,Wt,jt);G[M*8+rt]=Ot,bt[et*2]=Ot,bt[et*2+1]=O+1,U[et*8]=Mt[rt],U[et*8+1]=Mt[rt]+wt[rt],U[et*8+2]=St,U[et*8+3]=Wt,U[et*8+4]=jt,U[et*8+5]=Ct,et++}let Tt=Y;Y=lt,lt=Tt,g.bufA=Y,g.bufB=lt}return g.root=it,g.cells=ht,g}function h(g,_,b,S,T,C,P,y,w){let F=T[_],B=C[_],W=P[_],R=0,D=0,H=0,k=0;w[k++]=g.root;let{mass:N,comX:V,comY:K,comZ:$,half:ct,child:G,start:J,count:ot,points:nt}=g;for(;k>0;){let ht=w[--k],xt=J[ht];if(xt>=0){let et=ot[ht];for(let at=xt;at<xt+et;at++){let it=nt[at];if(it===_)continue;let wt=F-T[it],Mt=B-C[it],E=W-P[it],M=wt*wt+Mt*Mt+E*E;M<1e-9&&(M=1e-9);let O=Math.sqrt(M),tt=b/O;R+=wt/O*tt,D+=Mt/O*tt,H+=E/O*tt}continue}let Y=F-V[ht],lt=B-K[ht],pt=W-$[ht],U=Y*Y+lt*lt+pt*pt;U<1e-9&&(U=1e-9);let bt=Math.sqrt(U);if(2*ct[ht]/bt<S){let et=b*N[ht]/bt;R+=Y/bt*et,D+=lt/bt*et,H+=pt/bt*et}else for(let et=0;et<8;et++){let at=G[ht*8+et];at>=0&&k<w.length&&(w[k++]=at)}}y[0]=R,y[1]=D,y[2]=H}function u(g,_){let b=g.length,S=new Map;for(let W=0;W<b;W++)S.set(g[W].id,W);let T=new Int32Array(_.length),C=new Int32Array(_.length),P=new Float64Array(_.length),y=0;for(let W=0;W<_.length;W++){let R=S.get(_[W].src),D=S.get(_[W].dst);R===void 0||D===void 0||R===D||(T[y]=R,C[y]=D,P[y]=_[W].weight>0?_[W].weight:1,y++)}let w=new Float64Array(b);for(let W=0;W<y;W++)w[T[W]]+=1,w[C[W]]+=1;let F=new Float64Array(b),B=new Float64Array(b);return{n:b,byId:S,es:T,et:C,ew:P,m:y,degree:w,nodeMass:F,ideal:B,fillIdeal(W){for(let R=0;R<b;R++){let D=Math.max(0,Math.min(1,g[R].importance||0));F[R]=1+Math.min(6,Math.sqrt(w[R])),B[R]=W*(.9+.6*D+.2*Math.log1p(w[R]))}}}}function d(g,_,b){let S=g.length;if(!S)return r(3);let T=i(b.spacing,60),C=Math.max(1,Math.floor(i(b.iterations,160))),P=i(b.theta,.9),y=e(i(b.seed,1)),w=T,F=w*w,B=new Float64Array(S),W=new Float64Array(S),R=new Float64Array(S),D=Math.PI*(3-Math.sqrt(5)),H=w*Math.cbrt(Math.max(1,S))*.55;for(let bt=0;bt<S;bt++){let at=1-2*(S===1?.5:bt/(S-1)),it=Math.sqrt(Math.max(0,1-at*at)),wt=D*bt+n(g[bt].id)%1e3*.001;B[bt]=Math.cos(wt)*it*H+(y()-.5)*w*.2,W[bt]=at*H+(y()-.5)*w*.2,R[bt]=Math.sin(wt)*it*H+(y()-.5)*w*.2}let k=u(g,_);k.fillIdeal(w);let{es:N,et:V,ew:K,m:$,nodeMass:ct,ideal:G}=k,J=new Float64Array(S*3),ot=new Float64Array(3),nt=new Int32Array(Math.max(64,S+8)*8),ht=c(),xt=[],Y=new Float64Array(S),lt=new Float64Array(S*3);for(let bt=0;bt<S;bt++)Y[bt]=H*.02;let pt=w*2,U=w*1e-4;for(let bt=0;bt<C;bt++){J.fill(0),l(ht,B,W,R,S);for(let at=0;at<S;at++)h(ht,at,F,P,B,W,R,ot,nt),J[at*3]+=ot[0],J[at*3+1]+=ot[1],J[at*3+2]+=ot[2];for(let at=0;at<$;at++){let it=N[at],wt=V[at],Mt=B[wt]-B[it],E=W[wt]-W[it],M=R[wt]-R[it],O=Math.sqrt(Mt*Mt+E*E+M*M);O<1e-6&&(Mt=y()-.5,E=y()-.5,M=y()-.5,O=Math.sqrt(Mt*Mt+E*E+M*M)||1);let tt=(G[it]+G[wt])*.5,j=O*O/tt*K[at],Q=Mt/O,_t=E/O,ft=M/O;J[it*3]+=Q*j,J[it*3+1]+=_t*j,J[it*3+2]+=ft*j,J[wt*3]-=Q*j,J[wt*3+1]-=_t*j,J[wt*3+2]-=ft*j}let et=0;for(let at=0;at<S;at++){let it=at*3,wt=J[it]/ct[at],Mt=J[it+1]/ct[at],E=J[it+2]/ct[at],M=Math.sqrt(wt*wt+Mt*Mt+E*E);if(et+=J[it]*J[it]+J[it+1]*J[it+1]+J[it+2]*J[it+2],M<=0)continue;let O=wt/M,tt=Mt/M,j=E/M;O*lt[it]+tt*lt[it+1]+j*lt[it+2]>0?Y[at]=Math.min(pt,Y[at]*1.2):Y[at]*=.5,Y[at]<U&&(Y[at]=U),lt[it]=O,lt[it+1]=tt,lt[it+2]=j;let Q=Math.min(Y[at],M);B[at]+=O*Q,W[at]+=tt*Q,R[at]+=j*Q}xt.push(et)}return o(B,W,R,S),a(B,W,R,S,3,{energy:xt,iterations:C,theta:P})}function m(g,_,b,S){let T=_.length;if(!T)return 0;let C=i(S.spacing,60),P=i(S.theta,.9),y=C*C,w=new Float64Array(T),F=new Float64Array(T),B=new Float64Array(T);for(let nt=0;nt<T;nt++)w[nt]=g[nt*3]||0,F[nt]=g[nt*3+1]||0,B[nt]=g[nt*3+2]||0;let W=u(_,b);W.fillIdeal(C);let{es:R,et:D,ew:H,m:k,ideal:N}=W,V=new Float64Array(T),K=new Float64Array(T),$=new Float64Array(T),ct=new Float64Array(3),G=new Int32Array(Math.max(64,T+8)*8),J=l(c(),w,F,B,T);for(let nt=0;nt<T;nt++)h(J,nt,y,P,w,F,B,ct,G),V[nt]+=ct[0],K[nt]+=ct[1],$[nt]+=ct[2];for(let nt=0;nt<k;nt++){let ht=R[nt],xt=D[nt],Y=w[xt]-w[ht],lt=F[xt]-F[ht],pt=B[xt]-B[ht],U=Math.sqrt(Y*Y+lt*lt+pt*pt)+1e-6,bt=U*U/((N[ht]+N[xt])*.5)*H[nt],et=Y/U,at=lt/U,it=pt/U;V[ht]+=et*bt,K[ht]+=at*bt,$[ht]+=it*bt,V[xt]-=et*bt,K[xt]-=at*bt,$[xt]-=it*bt}let ot=0;for(let nt=0;nt<T;nt++)ot+=V[nt]*V[nt]+K[nt]*K[nt]+$[nt]*$[nt];return ot/T}function v(g){let _=g.length,b=new Map;for(let P=0;P<_;P++)b.set(g[P].id,P);let S=new Int32Array(_).fill(-1),T=new Array(_);for(let P=0;P<_;P++)T[P]=[];for(let P=0;P<_;P++){let y=g[P].parent;if(!y)continue;let w=b.get(y);w===void 0||w===P||(S[P]=w)}for(let P=0;P<_;P++){let y=S[P],w=0;for(;y>=0&&w<=_;){if(y===P){S[P]=-1;break}y=S[y],w++}}let C=[];for(let P=0;P<_;P++)S[P]<0?C.push(P):T[S[P]].push(P);return{parent:S,children:T,roots:C}}function x(g,_,b){let S=g.length;if(!S)return r(2);let T=b.dims===2?2:3,C=b.radial!==void 0?b.radial:T===3,P=i(b.slotGap,1),y=i(b.nodeWidth,1),{parent:w,children:F,roots:B}=v(g),W=new Int32Array(S).fill(-1),R=[],D=[];for(let Y=B.length-1;Y>=0;Y--)D.push(B[Y]);for(;D.length;){let Y=D.pop();if(W[Y]>=0)continue;W[Y]=w[Y]<0?0:W[w[Y]]+1,R.push(Y);let lt=F[Y];for(let pt=lt.length-1;pt>=0;pt--)W[lt[pt]]<0&&D.push(lt[pt])}for(let Y=0;Y<S;Y++)W[Y]<0&&(W[Y]=0,R.push(Y));let H=new Float64Array(S),k=0;for(let Y=0;Y<R.length;Y++){let lt=R[Y];F[lt].length||(H[lt]=k,k+=P)}for(let Y=R.length-1;Y>=0;Y--){let lt=R[Y],pt=F[lt];if(!pt.length)continue;let U=0;for(let bt=0;bt<pt.length;bt++)U+=H[pt[bt]];H[lt]=U/pt.length}let N=0;for(let Y=0;Y<S;Y++)W[Y]>N&&(N=W[Y]);let V=new Array(N+1);for(let Y=0;Y<=N;Y++)V[Y]=[];for(let Y=0;Y<S;Y++)V[W[Y]].push(Y);for(let Y=0;Y<=N;Y++){let lt=V[Y];lt.sort((pt,U)=>H[pt]-H[U]||(g[pt].id<g[U].id?-1:1));for(let pt=1;pt<lt.length;pt++){let U=H[lt[pt-1]];H[lt[pt]]-U<y&&(H[lt[pt]]=U+y)}}let K=1;for(let Y=0;Y<=N;Y++)K=Math.max(K,V[Y].length);let $=Math.min(48,Math.max(2.4,K*.9)),ct=b.levelGap!==void 0&&b.levelGap>0?Math.max($,b.levelGap):$,G=new Float64Array(S),J=new Float64Array(S),ot=new Float64Array(S);if(C){let Y=Math.max(1,k),lt=Y*Math.PI*2/Math.max(1,N+1);for(let pt=0;pt<S;pt++){let U=W[pt],bt=U===0?0:U*ct,et=H[pt]/Y*Math.PI*2,at=U%2?Math.PI/Math.max(8,Y):0,it=U===0?0:bt;G[pt]=Math.cos(et+at)*it,ot[pt]=Math.sin(et+at)*it,J[pt]=-U*ct*.3}}else for(let Y=0;Y<S;Y++)G[Y]=H[Y],J[Y]=-W[Y]*ct,ot[Y]=0;let nt=1/0,ht=-1/0;for(let Y=0;Y<S;Y++)G[Y]<nt&&(nt=G[Y]),G[Y]>ht&&(ht=G[Y]);let xt=(nt+ht)/2;for(let Y=0;Y<S;Y++)G[Y]-=xt;return a(G,J,ot,S,T,{maxDepth:N,radial:C,layers:N+1,nodeWidth:y})}function p(g,_,b){let S=g.length;if(!S)return r(3);let T=i(b.bandGap,4),C=i(b.spacing,2.4),P=new Array(S);for(let D=0;D<S;D++)P[D]=D;P.sort((D,H)=>{let k=g[D].time||0,N=g[H].time||0;return k!==N?k-N:g[D].id<g[H].id?-1:g[D].id>g[H].id?1:0});let y=1/0;for(let D=0;D<S;D++)g[D].time>0&&g[D].time<y&&(y=g[D].time);isFinite(y)||(y=0);let w=new Float64Array(S),F=new Float64Array(S),B=new Float64Array(S),W=0,R=0;for(let D=0;D<S;D++){let H=P[D],k=g[H].time||0,N=k>0?Math.floor((k-y)/864e5):W;N!==W&&(W=N,R=0),w[H]=k>0?(k-y)/36e5:0,B[H]=N*T;let V=R%4;F[H]=(V===0||V===3?1:-1)*C*(1+Math.floor(R/4)*.15),R++}return o(w,F,B,S),a(w,F,B,S,3,{bands:W+1,dayMs:864e5})}function f(g,_,b){let S=g.length;if(!S)return r(3);let T=i(b.layerGap,26),C=i(b.spacing,7),P=new Map;for(let N=0;N<S;N++)P.set(g[N].id,N);let y=new Int32Array(S),w=!1;for(let N=0;N<S;N++){let V=g[N].layer;typeof V=="number"&&(y[N]=V,V>0&&(w=!0))}if(!w){y.fill(0);for(let N=0;N<S;N++){let V=g[N].parent,K=V?P.get(V):void 0;y[N]=K===void 0?0:Math.min(2,y[K]+1)}}let F=new Map;for(let N=0;N<S;N++){let V=(g[N].parent||"kind:"+g[N].kind)+"#L"+y[N],K=F.get(V);K?K.push(N):F.set(V,[N])}let B=Array.from(F.keys()).sort(),W=new Float64Array(S),R=new Float64Array(S),D=new Float64Array(S),H=0;for(let N=0;N<S;N++)y[N]>H&&(H=y[N]);for(let N=0;N<=H;N++){let V=[];for(let $=0;$<B.length;$++){let ct=F.get(B[$]);ct.length&&y[ct[0]]===N&&V.push(B[$])}if(!V.length)continue;let K=N*T;for(let $=0;$<V.length;$++){let ct=F.get(V[$]),G=$/V.length*Math.PI*2,J=Math.max(1,Math.floor(Math.max(3,8-N)));for(let ot=0;ot<ct.length;ot++){let nt=ct[ot],ht=Math.floor(ot/J),xt=ot%J-(J-1)/2,Y=K+ht*C,lt=xt*C*.62;W[nt]=Math.cos(G)*Y-Math.sin(G)*lt,D[nt]=Math.sin(G)*Y+Math.cos(G)*lt,R[nt]=-N*C*.55}}}let k=0;for(let N=0;N<S;N++)if(W[N]===0&&D[N]===0){let V=k++/Math.max(1,S)*Math.PI*2;W[N]=Math.cos(V)*C,D[N]=Math.sin(V)*C}return o(W,R,D,S),a(W,R,D,S,3,{layers:H+1})}return{semantic:d,hierarchy:x,timeline:p,evidence:f,energy:m}}function ur(s,t,e,n,i){let r=i??es();switch(s){case"hierarchy":return r.hierarchy(t,e,n);case"timeline":return r.timeline(t,e,n);case"evidence":return r.evidence(t,e,n);case"semantic":default:return r.semantic(t,e,n)}}function fl(s,t,e){let n=t>4e3?80:t>1500?120:180;return{dims:e,iterations:n,spacing:s==="hierarchy"?1:60,slotGap:1,levelGap:3.2,nodeWidth:1,bandGap:4,layerGap:26,radial:s==="hierarchy"?e===3:void 0,seed:20240517,theta:.9}}function Wm(){return["const layoutKernel = ("+es.toString()+");","const kernel = layoutKernel();","self.onmessage = function (event) {","  var msg = event.data;",'  if (!msg || msg.type !== "layout") return;',"  try {","    var fn = kernel[msg.view] || kernel.semantic;","    var result = fn(msg.nodes, msg.edges, msg.opts || {});","    var positions = result.positions;","    self.postMessage({",'      type: "done", requestId: msg.requestId, positions: positions,',"      dims: result.dims, meta: result.meta","    }, [positions.buffer]);","  } catch (err) {","    self.postMessage({",'      type: "error", requestId: msg.requestId,',"      message: String((err && err.message) || err)","    });","  }","};"].join(`
`)}var dr=class{constructor(){this.worker=null;this.objectUrl=null;this.nextId=1;this.pending=new Map;this.fallback=null;this.unavailableReason=null;let t=null;try{let e=Wm(),n=new Blob([e],{type:"text/javascript"});this.objectUrl=URL.createObjectURL(n),this.worker=new Worker(this.objectUrl),this.worker.onmessage=i=>this.onMessage(i.data),this.worker.onerror=()=>{this.demote("worker \u8FD0\u884C\u65F6\u62A5\u9519")}}catch(e){t=e instanceof Error?e.message:String(e),this.worker=null}this.mode=this.worker?"worker":"main",this.unavailableReason=this.worker?null:t??"worker \u4E0D\u53EF\u7528"}demote(t){if(this.worker){try{this.worker.terminate()}catch{}this.worker=null}this.objectUrl&&(URL.revokeObjectURL(this.objectUrl),this.objectUrl=null),this.fallback=this.fallback??es();let e=Array.from(this.pending.values());this.pending.clear();for(let n of e)n.reject(new Error(t))}onMessage(t){let e=this.pending.get(t.requestId);if(e){if(this.pending.delete(t.requestId),t.type==="error"){e.reject(new Error(t.message));return}e.resolve({positions:t.positions,dims:t.dims,meta:t.meta})}}run(t,e,n,i){if(!this.worker)try{return Promise.resolve(ur(t,e,n,i,this.fallback??es()))}catch(a){return Promise.reject(a instanceof Error?a:new Error(String(a)))}for(let[a,c]of this.pending)this.pending.delete(a),c.reject(new Error("superseded"));let r=this.nextId++,o={type:"layout",requestId:r,view:t,nodes:e,edges:n,opts:i};return new Promise((a,c)=>{this.pending.set(r,{resolve:a,reject:c}),this.worker?.postMessage(o)})}dispose(){this.demote("disposed"),this.fallback=null}};var Xm=new Set(["semantic","hypernym","hyponym","part_of","instance_of","causes","contradicts","supports","supersedes","derived_from","mentions","temporal_next","alias","prerequisite","contains","in_scope","evidence","document","chunk"]);function cn(s,t,e=""){for(let n of t){let i=s[n];if(typeof i=="string"&&i.trim())return i.trim();if(typeof i=="number")return String(i)}return e}function fr(s,t,e=0){for(let n of t){let i=s[n];if(typeof i=="number"&&isFinite(i))return i;if(typeof i=="string"&&i.trim()&&isFinite(Number(i)))return Number(i)}return e}function qm(s){for(let t of["time","recorded_at","created_at","valid_from","updated_at"]){let e=s[t];if(typeof e=="number"&&isFinite(e))return e<1e12?e*1e3:e;if(typeof e=="string"&&e.trim()){let n=Date.parse(e);if(!Number.isNaN(n))return n}}return 0}function Ym(s,t=24){let e=s.replace(/\s+/g," ").trim();return e.length<=t?e:e.slice(0,t-1)+"\u2026"}function Zm(s,t){let e=Array.isArray(s.nodes)?s.nodes:[],n=[],i=new Map;for(let u=0;u<e.length;u++){let d=e[u],m=cn(d,["id","node_id","key"],"node-"+u);if(i.has(m))continue;i.set(m,m);let v=Ym(cn(d,["label","title","name","summary"],m)),x=cn(d,["kind","type","category"],"default"),p=cn(d,["scope","scope_id","workspace"],"");n.push({id:m,label:v,kind:x,scope:p,degree:fr(d,["degree","weight","in_degree","connections"],0),importance:Jo(fr(d,["importance","weight","score"],.5)),time:qm(d),parent:cn(d,["parent","parent_id","group"],"")||null})}let r=Array.isArray(s.edges)?s.edges:[],o=[],a=new Set,c=new Map;for(let u=0;u<r.length;u++){let d=r[u],m=cn(d,["src","source","from","a"]),v=cn(d,["dst","target","to","b"]);if(!m||!v||m===v||!i.has(m)||!i.has(v))continue;let x=cn(d,["rel","relation","type","kind"],"semantic"),p=m+"|"+v+"|"+x;a.has(p)||(a.add(p),o.push({id:cn(d,["id","edge_id"],"e"+u),src:m,dst:v,rel:x,weight:Jo(fr(d,["weight","strength","score"],.6)),confidence:Jo(fr(d,["confidence"],.5))}),c.set(m,(c.get(m)??0)+1),c.set(v,(c.get(v)??0)+1))}for(let u of n){let d=c.get(u.id)??0;u.degree?u.degree=Math.max(u.degree,d):u.degree=d}let l=s.meta&&typeof s.meta=="object"?{...s.meta}:{};return o.length===0||o.some(u=>Xm.has(u.rel))||(l.unknownRelations=!0),{view:t,nodes:n,edges:o,meta:l,demo:!1}}function Jo(s){return isFinite(s)?Math.max(0,Math.min(1,s)):0}async function ml(s,t,e=2e3){let n=performance.now(),i=new URLSearchParams({view:s,limit:String(e)});t&&i.set("scope",t);let r=typeof AbortController<"u"?new AbortController:null,o=r?setTimeout(()=>r.abort(),3500):null;try{let a=await fetch("/api/graph?"+i.toString(),{headers:{Accept:"application/json"},signal:r?.signal});if(!a.ok)throw new Error("HTTP "+a.status);let c=await a.json(),l=Zm(c,s);if(!l.nodes.length)throw new Error("\u56FE\u6570\u636E\u4E3A\u7A7A");return{graph:l,error:null,tookMs:performance.now()-n}}catch(a){let c=a instanceof Error?a.message:String(a);return{graph:Km(s,460),error:c,tookMs:performance.now()-n}}finally{o&&clearTimeout(o)}}var Jm=[{name:"\u8BB0\u5FC6\u53EC\u56DE",kind:"concept",children:["\u6DF7\u5408\u68C0\u7D22","RRF \u878D\u5408","\u9884\u7B97\u6253\u5305","\u91CD\u6392\u5E8F","MMR \u53BB\u5197\u4F59","\u4F5C\u7528\u57DF\u7EE7\u627F"]},{name:"\u8BC1\u636E\u4E0E\u4FE1\u4EFB",kind:"concept",children:["\u8BC1\u636E\u7C7B\u578B","\u4FE1\u4EFB\u6743\u91CD","\u4EA4\u53C9\u9A8C\u8BC1","\u51B2\u7A81\u68C0\u6D4B","\u6765\u6E90\u6838\u9A8C","\u5F15\u7528\u7247\u6BB5"]},{name:"\u667A\u80FD\u4F53\u534F\u4F5C",kind:"concept",children:["MCP \u534F\u8BAE","\u4F1A\u8BDD\u751F\u547D\u5468\u671F","\u5FC3\u8DF3\u63A2\u9488","\u4EFB\u52A1\u59D4\u6D3E","\u5171\u4EAB\u5DE5\u4F5C\u533A","\u5199\u5165\u786E\u8BA4"]},{name:"\u5DE5\u4F5C\u6D41\u5F15\u64CE",kind:"concept",children:["DAG \u6267\u884C\u5668","\u8282\u70B9\u5904\u7406\u5668","\u964D\u7EA7\u7B56\u7565","\u6B65\u9AA4\u8BB0\u5F55","\u91CD\u8BD5\u8BED\u4E49","\u89E6\u53D1\u6761\u4EF6"]},{name:"\u6587\u6863\u4E0E\u5207\u5757",kind:"concept",children:["\u8BED\u4E49\u5207\u5757","\u6807\u9898\u6811","\u4EE3\u7801\u5757\u8BC6\u522B","\u516C\u5F0F\u89E3\u6790","\u7D22\u5F15\u91CD\u5EFA","\u539F\u8DEF\u5F84\u4FDD\u7559"]}],pl=["fact","knowledge","decision","preference","procedure","experience","task"];function Km(s,t=460){let e=[],n=[],i=Date.now(),r=[],o=[];Jm.forEach((p,f)=>{let g="concept-"+f;r.push(g),e.push({id:g,label:p.name,kind:"concept",scope:"workspace:memora",degree:0,importance:.9,time:i-(f+1)*864e5*3,parent:null}),p.children.forEach((_,b)=>{let S="concept-"+f+"-"+b;o.push(S),e.push({id:S,label:_,kind:"term",scope:"workspace:memora",degree:0,importance:.55,time:i-(f*6+b*3+2)*864e5,parent:g}),n.push({id:"h-"+S,src:g,dst:S,rel:"hyponym",weight:.8,confidence:.9})})});let c=["docs/ARCHITECTURE.md","tools/control.py","tests/unit/test_retrieval.py","\u4F1A\u8BDD\u8BB0\u5F55 2024-11-05","\u5B98\u65B9 MCP \u89C4\u8303","\u7528\u6237\u53E3\u8FF0","\u8FD0\u884C\u65E5\u5FD7 run#118"].map((p,f)=>{let g="src-"+f;return e.push({id:g,label:p,kind:"source",scope:"global",degree:0,importance:.35,time:i-(10+f)*864e5,parent:null}),g}),l=Math.max(60,Math.floor((t-e.length)*.62)),h=["semantic","supports","derived_from","causes","contradicts","prerequisite","mentions"],u=[],d=20240517,m=()=>(d=Math.imul(d,1664525)+1013904223>>>0,d/4294967296);for(let p=0;p<l;p++){let f="mem-"+p;u.push(f);let g=o[Math.floor(m()*o.length)],_=pl[Math.floor(m()*pl.length)];e.push({id:f,label:$m(p,_),kind:_,scope:"workspace:memora",degree:0,importance:.25+m()*.6,time:i-Math.floor(Math.pow(m(),1.8)*40)*864e5-Math.floor(m()*864e5),parent:g}),n.push({id:"pe-"+p,src:g,dst:f,rel:"mentions",weight:.4+m()*.4,confidence:.6});let b=1+Math.floor(m()*3);for(let S=0;S<b;S++){let T=u[Math.floor(m()*Math.max(1,u.length-1))];!T||T===f||n.push({id:"se-"+p+"-"+S,src:f,dst:T,rel:h[Math.floor(m()*h.length)],weight:.25+m()*.7,confidence:.4+m()*.5})}}let v=Math.max(40,t-e.length-8);for(let p=0;p<v;p++){let f="ev-"+p,g=u[Math.floor(m()*u.length)],_=c[Math.floor(m()*c.length)],b=["user_stated","agent_asserted","tool_output","document","web","verification"];e.push({id:f,label:"\u8BC1\u636E "+(p+1)+" \xB7 "+jm(b[Math.floor(m()*b.length)]),kind:"evidence",scope:"workspace:memora",degree:0,importance:.3+m()*.3,time:i-Math.floor(m()*40)*864e5,parent:g}),n.push({id:"ev-e-"+p,src:g,dst:f,rel:"evidence_for",weight:.7,confidence:.8}),n.push({id:"ev-s-"+p,src:f,dst:_,rel:"derived_from",weight:.6,confidence:.7})}let x=new Map;for(let p of n)x.set(p.src,(x.get(p.src)??0)+1),x.set(p.dst,(x.get(p.dst)??0)+1);for(let p of e)p.degree=x.get(p.id)??0;return{view:s,nodes:e,edges:n,meta:{total:e.length,source:"demo",generatedAt:Date.now()},demo:!0}}function $m(s,t){let e={fact:["SQLite \u662F\u4E8B\u52A1\u771F\u6E90","Markdown \u662F\u53EF\u8BFB\u955C\u50CF","\u5411\u91CF\u7EF4\u5EA6\u56FA\u5B9A 256","WAL \u6A21\u5F0F\u4E0B\u5E76\u53D1\u8BFB\u5B89\u5168"],knowledge:["BM25 \u4E0E\u5411\u91CF\u5206\u6570\u7684\u91CF\u7EB2\u4E0D\u540C","RRF \u53EA\u4F9D\u8D56\u6392\u540D","\u56FE\u53EC\u56DE\u6CBF\u8FB9\u6269\u6563 2 \u8DF3","\u91CD\u6392\u6A21\u578B\u5403 cross-encoder"],decision:["\u9009\u62E9\u6807\u51C6\u5E93\u5B9E\u73B0\u540E\u7AEF","\u8111\u56FE\u7528 three.js \u800C\u975E canvas2d","\u964D\u7EA7\u5FC5\u987B\u53EF\u89C2\u6D4B","\u5DE5\u4F5C\u6D41\u8282\u70B9\u7F3A\u5931\u8BB0\u4E3A noop"],preference:["\u7528\u6237\u5F3A\u8C03\u4E2D\u6587\u6587\u6848","\u504F\u597D\u6DF1\u8272\u754C\u9762","\u62D2\u7EDD\u4F2A\u9020\u6210\u529F\u72B6\u6001","\u5BFC\u51FA\u8981\u80FD\u76F4\u63A5\u5206\u4EAB"],procedure:["\u5148\u5207\u5757\u518D\u5165\u5E93","\u5BFC\u5165\u540E\u91CD\u5EFA\u7D22\u5F15","\u5BA1\u6838\u540E\u5199\u955C\u50CF","\u51B2\u7A81\u5148\u6807\u8BB0\u5F55\u540E\u88C1\u51B3"],experience:["5000 \u8282\u70B9\u5FC5\u987B\u8D70\u5B9E\u4F8B\u5316","\u6807\u7B7E\u907F\u8BA9\u8981\u5728\u50CF\u7D20\u7A7A\u95F4\u505A","BH \u8FD1\u4F3C\u8BEF\u5DEE 10% \u91CF\u7EA7","\u5E03\u5C40\u653E Worker \u4E0D\u5361 UI"],task:["\u8865\u9F50\u8111\u56FE\u56DB\u89C6\u56FE","\u63A5\u5165 MCP HTTP \u4F20\u8F93","\u5B9E\u73B0\u590D\u4E60 SM-2","\u5B8C\u6210\u79BB\u7EBF\u964D\u7EA7\u77E9\u9635"]},n=e[t]??e.fact;return n[s%n.length]+" #"+(s+1)}function jm(s){return{user_stated:"\u7528\u6237\u9648\u8FF0",agent_asserted:"\u667A\u80FD\u4F53\u65AD\u8A00",tool_output:"\u5DE5\u5177\u8F93\u51FA",document:"\u6587\u6863",web:"\u7F51\u9875",verification:"\u6838\u9A8C",derived:"\u63A8\u5BFC",code_run:"\u4EE3\u7801\u8FD0\u884C"}[s]??s}var Qm=.2,pr=120,tg=45,eg=55,gl=20,ng=["semantic","hierarchy","timeline","evidence"];function ig(s){let t=new URLSearchParams(s),e=t.get("view")??"";return{view:ng.includes(e)?e:"semantic",focus:(t.get("focus")??"").trim()}}var Ko=class{constructor(t){this.view="semantic";this.dims=3;this.state=null;this.filter={kinds:new Set,scope:"",range:"all"};this.fullGraph=null;this.frustum=new Mi;this.projScreen=new Zt;this.tmpVec=new L;this.tmp2=new Lt;this.viewport={width:1,height:1};this.fps=0;this.frameCount=0;this.fpsWindowStart=0;this.lowStreak=0;this.highStreak=0;this.lodLevel="high";this.labelBudget=pr;this.stardust=null;this.statusText="";this.note="";this.disposed=!1;this.rafId=0;this.lastLayoutMs=0;this.lastMinimapAt=0;this.lastPanelAt=0;this.layoutError=null;this.layoutTrace=[];this.lastCalls=0;this.lastTriangles=0;this.viewSeq=0;this.lastFetch=null;this.focusId="";this.resizeHandler=null;this.mount=t,t.innerHTML="",this.root=document.createElement("div"),this.root.className="mem-brain-root",this.canvas=document.createElement("canvas"),this.canvas.className="mem-brain-canvas",this.root.appendChild(this.canvas),t.appendChild(this.root),this.scene=new rr(this.canvas),this.nodes=new or({maxLabels:pr,labelChurn:Qm}),this.edges=new ar,this.layoutClient=new dr,this.scene.scene.add(this.nodes.group),this.scene.scene.add(this.edges.group),this.stardust=this.createStardust(),this.scene.scene.add(this.stardust),ia(),this.interaction=new cr({scene:this.scene,nodes:this.nodes,edges:this.edges,state:()=>this.state,onSelect:e=>this.onSelect(e),onStatus:e=>this.setStatus(e),projection:()=>this.scene.projectionMode}),this.ui=new hr(this.root,{onView:e=>void this.setView(e),onDims:e=>void this.setDims(e),onFilter:e=>this.applyFilter(e),onSearch:e=>this.runSearch(e),onSearchPick:e=>this.pickSearchHit(e),onExport:()=>this.exportPng(),onReset:()=>this.interaction.resetView(),onPathMode:e=>this.interaction.setPathMode(e)}),this.ui.onMinimapClick((e,n)=>this.minimapClick(e,n)),this.bindResize(),this.startClock()}async boot(){let t=ig(window.location.search);this.view=t.view,this.focusId=t.focus,this.setStatus("\u6B63\u5728\u52A0\u8F7D\u56FE\u6570\u636E\u2026");let e=await this.load(this.view);this.setStatus(e.error?"\u5DF2\u5207\u6362\u5230\u6F14\u793A\u6570\u636E":"\u52A0\u8F7D\u5B8C\u6210\uFF0C\u8017\u65F6 "+e.tookMs.toFixed(0)+"ms"),await this.rebuild(!0),this.applyFocus()}async load(t){let e=await ml(t,this.filter.scope,2e3);return this.lastFetch={view:t,ok:!e.error,nodes:e.graph.nodes.length,error:e.error},this.fullGraph=e.graph,this.note=e.error?"\u540E\u7AEF /api/graph \u4E0D\u53EF\u7528\uFF08"+e.error+"\uFF09\uFF0C\u5F53\u524D\u4E3A\u5185\u7F6E\u6F14\u793A\u6570\u636E":"\u6570\u636E\u6765\u81EA /api/graph",{error:e.error,tookMs:e.tookMs}}applyFocus(){let t=this.focusId;if(!t||!this.state)return;let e=this.state.graph.nodes.findIndex(n=>n.id===t);e>=0?(this.focusId="",this.interaction.select(e,1,!0)):this.setStatus("\u5F53\u524D\u89C6\u56FE\u91CC\u6CA1\u6709\u8282\u70B9 "+t)}async setView(t){if(this.view===t&&this.state)return;this.view=t;let e=++this.viewSeq;this.dims=t==="hierarchy"&&this.dims===2?2:3,this.scene.setProjection(t==="hierarchy"&&this.dims===2?"2d":"perspective"),this.setStatus("\u6B63\u5728\u52A0\u8F7D"+(Zo[t]??t)+"\u2026");let n=await this.load(t);e===this.viewSeq&&(await this.rebuild(!0),this.interaction.resetSelection(),this.applyFocus(),this.setStatus((Zo[t]??t)+(n.error?"\uFF08\u6F14\u793A\u6570\u636E\uFF09":"")))}async setDims(t){this.dims=t,this.view==="hierarchy"&&(this.scene.setProjection(t===2?"2d":"perspective"),await this.rebuild(!0),this.interaction.resetSelection())}async rebuild(t){let e=this.fullGraph;if(!e)return;let n=this.filterGraph(e);this.ui.renderLegend(n,this.colorMap(n)),this.ui.renderScopes(Array.from(new Set(e.nodes.map(v=>v.scope).filter(Boolean)))),this.ui.render(this.uiState(!0,0,0));let i=n.nodes.map(v=>({id:v.id,degree:v.degree,importance:v.importance,time:v.time,kind:v.kind,parent:v.parent,layer:n.view==="evidence"?ag(v.kind):void 0})),r=n.edges.map(v=>({src:v.src,dst:v.dst,weight:v.weight})),o=fl(n.view,n.nodes.length,this.dims);n.view==="hierarchy"&&(o.dims=this.dims,o.radial=this.dims===3);let a=performance.now(),c;try{c=await this.layoutClient.run(n.view,i,r,o),this.layoutError=null}catch(v){this.layoutError=v instanceof Error?v.message:String(v),c=ur(n.view,i,r,o)}if(this.disposed)return;this.lastLayoutMs=performance.now()-a,this.layoutTrace.push({view:n.view,dims:o.dims,radial:o.radial,resultDims:c.dims,n:n.nodes.length}),this.layoutTrace.length>6&&this.layoutTrace.shift();let l=new Map;n.nodes.forEach((v,x)=>l.set(v.id,x));let h=new Array(n.nodes.length);for(let v=0;v<h.length;v++)h[v]=[];for(let v of n.edges){let x=l.get(v.src),p=l.get(v.dst);x===void 0||p===void 0||x===p||(h[x].push(p),h[p].push(x))}let u=new Float32Array(c.positions);this.state={graph:n,positions:c.positions,renderPositions:u,index:l,neighbors:h,dims:c.dims};let d=Qi(this.state),m=n.view==="hierarchy"?og():ul(d);if(this.nodes.setWorldUnit(m),this.nodes.build(n,u),this.edges.setOpacity(1),this.edges.build(n,u,l),this.interaction.resetSelection(),this.updateViewport(!0),t&&(n.view==="hierarchy"&&this.dims===2?this.scene.setPose(new L(0,0,0),this.scene.frameRadius(d),0,Math.PI/2):this.scene.setPose(new L(0,0,0),this.scene.frameRadius(d)),this.scene.projectionMode!=="perspective")){let x=rg(this.state.positions,n.nodes.length),p=Math.max(1,(x.maxX-x.minX)/2),f=Math.max(1,(x.maxY-x.minY)/2),g=Math.max(.2,this.viewport.width/Math.max(1,this.viewport.height)),_=Math.max(f,p/g)*1.16;this.scene.setPose(new L((x.minX+x.maxX)/2,(x.minY+x.maxY)/2,0),this.scene.frameRadius(d),0,Math.PI/2),this.scene.fitOrtho(_)}this.ui.render(this.uiState(!1,n.nodes.length,n.edges.length)),this.setStatus("\u5E03\u5C40 "+this.lastLayoutMs.toFixed(0)+"ms \xB7 "+n.nodes.length+" \u8282\u70B9 / "+n.edges.length+" \u8FB9")}filterGraph(t){let{kinds:e,scope:n,range:i}=this.filter,r=i==="all"?0:Date.now()-Number(i.replace("d",""))*864e5,o=h=>!(e.size&&!e.has(h.kind)||n&&h.scope!==n||r&&h.time&&h.time<r),a=t.nodes.filter(o),c=new Set(a.map(h=>h.id)),l=t.edges.filter(h=>c.has(h.src)&&c.has(h.dst));return{...t,view:this.view,nodes:a,edges:l}}applyFilter(t){this.filter=t,this.rebuild(!1)}colorMap(t){let e={};for(let n of t.nodes)e[n.kind]=Sn(n.kind);return e.default=Sn("default"),e}startClock(){this.fpsWindowStart=performance.now();let t=e=>{this.disposed||(this.rafId=requestAnimationFrame(t),this.frame(e))};this.rafId=requestAnimationFrame(t)}frame(t){let e=this.state;this.frameCount++,t-this.fpsWindowStart>=500&&(this.fps=this.frameCount*1e3/(t-this.fpsWindowStart),this.frameCount=0,this.fpsWindowStart=t,this.adjustLod()),e&&(this.scene.update(t),this.interaction.applyDisplacement(1/60),this.nodes.updateHalo(t,e.renderPositions),this.refreshFrustum(),this.updateLabels(t));let n=this.scene.renderer;n.autoClear=!0,n.render(this.scene.scene,this.scene.camera);let i=n.info.render.calls,r=n.info.render.triangles;n.autoClear=!1,n.render(this.nodes.overlayScene,this.nodes.overlayCamera),n.autoClear=!0,this.lastCalls=i+n.info.render.calls,this.lastTriangles=r+n.info.render.triangles,e&&t-this.lastMinimapAt>200&&(this.lastMinimapAt=t,this.ui.drawMinimap(e.renderPositions,e.graph.nodes.map(o=>o.kind),this.colorMap(e.graph),this.interaction.selection)),e&&t-this.lastPanelAt>500&&(this.lastPanelAt=t,this.ui.render(this.uiState(!1,e.graph.nodes.length,e.graph.edges.length)))}updateLabels(t){let e=this.state;if(!e)return;let n=this.interaction.selection,i=new Set(this.interaction.selectedNeighbors),r=new Float32Array(e.graph.nodes.length);for(let o=0;o<e.graph.nodes.length;o++){let a=e.graph.nodes[o].degree+e.graph.nodes[o].importance*3;i.has(o)&&(a+=1e3),o===n&&(a+=1e4),r[o]=a}this.nodes.updateLabels(this.frustum,(o,a)=>(this.tmpVec.set(e.renderPositions[o*3],e.renderPositions[o*3+1],e.renderPositions[o*3+2]),this.tmpVec.project(this.scene.camera),a.x=(this.tmpVec.x*.5+.5)*this.viewport.width,a.y=(-this.tmpVec.y*.5+.5)*this.viewport.height,a),r,e.renderPositions,this.viewport),this.tmp2}adjustLod(){this.fps<=0||(this.fps<tg?(this.lowStreak++,this.highStreak=0):this.fps>eg?(this.highStreak++,this.lowStreak=0):(this.lowStreak=0,this.highStreak=0),this.lodLevel==="high"&&this.lowStreak>=gl?(this.lodLevel="low",this.labelBudget=Math.max(24,Math.floor(pr/2)),this.nodes.setLabelBudget(this.labelBudget),this.nodes.setLod("low"),this.edges.setBow(.1),this.setStatus("\u5E27\u7387 "+this.fps.toFixed(0)+" fps\uFF0C\u5DF2\u964D\u5230\u4F4E LOD\uFF08\u6807\u7B7E "+this.labelBudget+"\uFF09")):this.lodLevel==="low"&&this.highStreak>=gl*3&&(this.lodLevel="high",this.labelBudget=pr,this.nodes.setLabelBudget(this.labelBudget),this.nodes.setLod("high"),this.edges.setBow(.22),this.setStatus("\u5E27\u7387\u6062\u590D\uFF0C\u5DF2\u5347\u56DE\u9AD8 LOD")))}refreshFrustum(){let t=this.scene.camera;t.updateMatrixWorld(),this.projScreen.multiplyMatrices(t.projectionMatrix,t.matrixWorldInverse),this.frustum.setFromProjectionMatrix(this.projScreen)}updateViewport(t){let e=this.root.clientWidth||window.innerWidth,n=this.root.clientHeight||window.innerHeight;this.viewport={width:e,height:n},this.scene.resize(),this.nodes.resizeOverlay(e,n);let i=this.scene.camera;i.updateMatrixWorld(),i instanceof Object&&"updateProjectionMatrix"in i&&i.updateProjectionMatrix(),this.projScreen.multiplyMatrices(i.projectionMatrix,i.matrixWorldInverse),this.frustum.setFromProjectionMatrix(this.projScreen),t&&this.scene.update(performance.now())}bindResize(){let t=!1,e=()=>{t||(t=!0,requestAnimationFrame(()=>{if(t=!1,this.updateViewport(!1),this.state){let n=Qi(this.state);this.scene.reset(this.scene.frameRadius(n))}}))};window.addEventListener("resize",e),this.resizeHandler=e}onSelect(t){let e=this.state;if(!e||t<0){this.setStatus("\u672A\u9009\u4E2D");return}let n=e.graph.nodes[t];this.setStatus("\u9009\u4E2D\uFF1A"+n.label+"\uFF08"+(ts[n.kind]??n.kind)+"\uFF09\xB7 "+(e.neighbors[t]?.length??0)+" \u6761\u76F4\u8FDE \xB7 "+this.interaction.selectedNeighbors.length+" \u4E2A\u9AD8\u4EAE")}runSearch(t){let e=this.state;if(!e)return;if(!t){this.ui.renderSearch([]);return}let n=t.toLowerCase(),i=[];for(let r=0;r<e.graph.nodes.length&&i.length<40;r++){let o=e.graph.nodes[r];(o.label.toLowerCase().includes(n)||o.id.toLowerCase().includes(n))&&i.push({index:r,label:o.label,kind:o.kind})}this.ui.renderSearch(i),this.ui.setStatus(i.length?"\u627E\u5230 "+i.length+" \u4E2A\u8282\u70B9":"\u6CA1\u6709\u5339\u914D\u7684\u8282\u70B9")}pickSearchHit(t){t<0||(this.interaction.select(t,1,!0),this.ui.renderSearch([]))}minimapClick(t,e){let n=this.state;if(!n)return;let i=1/0,r=-1/0,o=1/0,a=-1/0;for(let l=0;l<n.graph.nodes.length;l++){let h=n.renderPositions[l*3],u=n.renderPositions[l*3+1];h<i&&(i=h),h>r&&(r=h),u<o&&(o=u),u>a&&(a=u)}let c=new L(i+(r-i)*t,o+(a-o)*(1-e),0);this.scene.setPose(c,this.scene.currentDistance)}exportPng(){let t=this.scene.renderer;t.autoClear=!0,t.render(this.scene.scene,this.scene.camera),t.autoClear=!1,t.render(this.nodes.overlayScene,this.nodes.overlayCamera),t.autoClear=!0;let e=this.canvas.toDataURL("image/png"),n=document.createElement("a");n.href=e,n.download="memora-brain-"+this.view+"-"+new Date().toISOString().slice(0,19).replace(/[:T]/g,"")+".png",n.click(),this.setStatus("\u5DF2\u5BFC\u51FA PNG")}setStatus(t){this.statusText!==t&&(this.statusText=t,this.ui.setStatus(t))}get __debug(){return{ready:this.state!==null,nodes:this.nodes.count,edges:this.edges.segments,calls:this.lastCalls,triangles:this.lastTriangles,labels:this.nodes.labelCount,fps:Math.round(this.fps),view:this.view,dims:this.dims,demo:this.fullGraph?.demo===!0,lastFetch:this.lastFetch,layoutMode:this.layoutClient.mode,layoutMs:Math.round(this.lastLayoutMs),layoutError:this.layoutError,layoutTrace:this.layoutTrace,labelStats:this.nodes.labelStats,selection:this.interaction.selection,flightActive:this.scene.flight.active,projection:this.scene.projectionMode,lod:this.lodLevel,labelBudget:this.labelBudget,status:this.statusText,uiState:this.uiState(!1,0,0)}}get __events(){return this.interaction.eventCounts}get __lastPick(){return this.interaction.lastPick}__instanceProbe(){let t=this.state;if(!t)return{none:!0};let e=this.nodes.mesh,n=[],i=0,r=-1,o=new Zt;for(let a=0;a<t.graph.nodes.length;a++){e.getMatrixAt(a,o);let c=Math.max(Math.hypot(o.elements[0],o.elements[1],o.elements[2]),Math.hypot(o.elements[4],o.elements[5],o.elements[6]),Math.hypot(o.elements[8],o.elements[9],o.elements[10]));c>i&&(i=c,r=a),a<4&&n.push({i:a,scale:c,tx:o.elements[12],ty:o.elements[13],tz:o.elements[14]})}return{worldUnit:this.nodes.worldUnit,drawCount:this.nodes.count,instanceCount:e.instanceMatrix.count,layoutRadius:Qi(t),maxWorldRadius:i,maxIndex:r,maxDegree:r>=0?t.graph.nodes[r].degree:-1,maxImportance:r>=0?t.graph.nodes[r].importance:-1,samples:n}}__projectionProbe(){let t=this.state;if(!t)return{none:!0};let e=this.scene.camera,n=[];for(let i=0;i<Math.min(3,t.graph.nodes.length);i++){let r=new L(t.renderPositions[i*3],t.renderPositions[i*3+1],t.renderPositions[i*3+2]).project(e);n.push({x:r.x,y:r.y,z:r.z})}return{samples:n,camPos:[e.position.x,e.position.y,e.position.z],camNear:e.near,camFar:e.far,isPerspective:e.isPerspectiveCamera===!0,mwi:e.matrixWorldInverse.elements.slice(12,15),mw:e.matrixWorld.elements.slice(12,15),proj:e.projectionMatrix.elements.slice(10,15)}}__loadScale(t){return this.fullGraph=sg(t),this.note="\u89C4\u6A21\u81EA\u68C0\uFF1A"+t+" \u4E2A\u5408\u6210\u8282\u70B9",this.rebuild(!0)}__displacement(){let t=this.state;if(!t)return{none:!0};let e=this.interaction.selection,n=this.interaction.selectedNeighbors;if(e<0)return{selected:-1,maxPush:0,selectedScale:0};let i=0;for(let h of n.slice(0,50)){let u=t.renderPositions[h*3]-t.positions[h*3],d=t.renderPositions[h*3+1]-t.positions[h*3+1],m=t.renderPositions[h*3+2]-t.positions[h*3+2];i=Math.max(i,Math.hypot(u,d,m))}let r=new Zt;this.nodes.mesh.getMatrixAt(e,r);let o=Math.hypot(r.elements[0],r.elements[1],r.elements[2]),a=new Zt,c=n.length?n[0]:0;this.nodes.mesh.getMatrixAt(c,a);let l=Math.hypot(a.elements[0],a.elements[1],a.elements[2]);return{selected:e,neighbors:n.length,maxPush:i,selectedScale:o,neighborScale:l,ratio:l>0?o/l:0}}__zoomForTest(t){this.scene.zoom(t)}__exportDataUrl(){let t=this.scene.renderer;return t.autoClear=!0,t.render(this.scene.scene,this.scene.camera),t.autoClear=!1,t.render(this.nodes.overlayScene,this.nodes.overlayCamera),t.autoClear=!0,this.canvas.toDataURL("image/png")}__layoutInfo(){let t=this.state;if(!t)return{none:!0};let e=1/0,n=-1/0,i=1/0,r=-1/0;for(let o=0;o<t.graph.nodes.length;o++)e=Math.min(e,t.positions[o*3+1]),n=Math.max(n,t.positions[o*3+1]),i=Math.min(i,t.positions[o*3+2]),r=Math.max(r,t.positions[o*3+2]);return{view:this.view,dimsOption:this.dims,layoutDims:t.dims,projection:this.scene.projectionMode,ySpan:n-e,zSpan:r-i,orthoZoom:this.scene.orthoZoom,parented:t.graph.nodes.filter(o=>o.parent).length}}async __setView(t){await this.setView(t)}async __setDims(t){await this.setDims(t)}__search(t){let e=this.state;if(!e)return[];let n=t.toLowerCase(),i=[];for(let r=0;r<e.graph.nodes.length&&i.length<10;r++){let o=e.graph.nodes[r];o.label.toLowerCase().includes(n)&&i.push({index:r,label:o.label})}return i}__path(t,e){let n=this.state;return n?Yo(n.neighbors,t,e):[]}__pick(t,e){return this.interaction.pick(t,e)}__select(t,e=1){this.interaction.select(t,e,!0)}__screenOf(t){let e=this.state;if(!e||t<0||t>=e.graph.nodes.length)return null;let n=this.canvas.getBoundingClientRect(),i=new L(e.renderPositions[t*3],e.renderPositions[t*3+1],e.renderPositions[t*3+2]).project(this.scene.camera);return{x:n.left+(i.x*.5+.5)*n.width,y:n.top+(-i.y*.5+.5)*n.height}}uiState(t,e,n){return{view:this.view,dims:this.dims,demo:this.fullGraph?.demo===!0,loading:t,nodeCount:e||(this.state?.graph.nodes.length??0),edgeCount:n||(this.state?.graph.edges.length??0),fps:this.fps,labels:this.nodes.labelCount,layoutMode:this.layoutClient.mode,filter:this.filter,note:this.note||""}}createStardust(){let e=new Float32Array(4200),n=987654321,i=()=>(n=Math.imul(n,1664525)+1013904223>>>0,n/4294967296);for(let c=0;c<1400;c++){let l=i()*2-1,h=i()*Math.PI*2,u=3200+i()*9800,d=Math.sqrt(1-l*l);e[c*3]=Math.cos(h)*d*u,e[c*3+1]=l*u,e[c*3+2]=Math.sin(h)*d*u}let r=new pe;r.setAttribute("position",new ee(e,3));let o=new Ji({color:8829148,size:2.4,sizeAttenuation:!1,transparent:!0,opacity:.5,depthWrite:!1}),a=new tr(r,o);return a.frustumCulled=!1,a.renderOrder=-1,a}dispose(){this.disposed=!0,cancelAnimationFrame(this.rafId),this.resizeHandler&&window.removeEventListener("resize",this.resizeHandler),this.interaction.dispose(),this.ui.dispose(),this.layoutClient.dispose(),this.nodes.dispose(),this.edges.dispose(),this.scene.dispose()}};function sg(s){let t=[],e=[],n=Date.now(),i=1234567,r=()=>(i=Math.imul(i,1664525)+1013904223>>>0,i/4294967296),o=[];for(let l=0;l<40;l++){let h="c-"+l;t.push({id:h,label:"\u4E3B\u9898 "+l,kind:"concept",scope:"synthetic",degree:0,importance:.9,time:n,parent:null});for(let u=0;u<5;u++){let d=h+"-"+u;o.push(d),t.push({id:d,label:"\u5B50\u4E3B\u9898 "+l+"."+u,kind:"term",scope:"synthetic",degree:0,importance:.5,time:n,parent:h}),e.push({id:"e-"+d,src:h,dst:d,rel:"hyponym",weight:.8,confidence:.9})}}let a=Math.max(0,s-t.length);for(let l=0;l<a;l++){let h="m-"+l,u=["fact","knowledge","decision","preference","procedure","experience","task"][l%7];t.push({id:h,label:"\u8BB0\u5FC6\u6761\u76EE "+l,kind:u,scope:"synthetic",degree:0,importance:.2+r()*.7,time:n-Math.floor(r()*40)*864e5,parent:o[l%o.length]}),e.push({id:"pe-"+l,src:o[l%o.length],dst:h,rel:"mentions",weight:.5,confidence:.6});for(let d=0;d<2;d++){let m="m-"+Math.floor(r()*Math.max(1,a));m!==h&&e.push({id:"se-"+l+"-"+d,src:h,dst:m,rel:"semantic",weight:.3+r()*.6,confidence:.5})}}let c=new Map;for(let l of e)c.set(l.src,(c.get(l.src)??0)+1),c.set(l.dst,(c.get(l.dst)??0)+1);for(let l of t)l.degree=c.get(l.id)??0;return{view:"semantic",nodes:t,edges:e,meta:{source:"synthetic"},demo:!0}}function rg(s,t){let e=1/0,n=-1/0,i=1/0,r=-1/0;for(let o=0;o<t;o++){let a=s[o*3],c=s[o*3+1];a<e&&(e=a),a>n&&(n=a),c<i&&(i=c),c>r&&(r=c)}return t?{minX:e,maxX:n,minY:i,maxY:r}:{minX:0,maxX:0,minY:0,maxY:0}}function og(){return .16}function ag(s){return s==="source"||s==="document"||s==="chunk"?2:s==="evidence"?1:0}function cg(){let s=document.getElementById("mem-brain")??document.getElementById("mem-root")??document.body.appendChild(Object.assign(document.createElement("div"),{id:"mem-brain"}));return s.classList&&s.classList.add("mem-brain-host"),s}function lg(){let s=document.documentElement.style;s.height="100%",s.margin="0",s.background="#070b12";let t=document.body.style;t.height="100%",t.margin="0",t.overflow="hidden",t.background="#070b12"}function _l(){lg(),hg(cg())}async function hg(s){let t=new Ko(s),e=t;window.__memBrain=e,await t.boot(),e.__ready=!0}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",_l,{once:!0}):_l();})();
/*! Bundled license information:

three/build/three.module.js:
  (**
   * @license
   * Copyright 2010-2023 Three.js Authors
   * SPDX-License-Identifier: MIT
   *)
*/
