/**
 * Memora desktop shell.
 *
 * This file used to be a one-shot launcher: read one stdout line, load the window, and treat any
 * backend exit as fatal. That is fine on a machine where nothing goes wrong and useless on one where
 * something does: an occupied port, a cold start slower than the timeout, or a backend that dies
 * twenty minutes later all produced the same outcome -- a dialog with one sentence in it and no
 * record of what happened.
 *
 * The shell is now a supervisor. It picks a port the backend can actually bind, decides readiness by
 * asking the backend who it is instead of trusting an announcement, restarts a backend that dies,
 * keeps a rolling diagnostics log, and takes the whole process tree down with it. The parts that are
 * testable without Electron live in ./health.cjs.
 *
 * Boundaries that must not move: contextIsolation/sandbox stay on, nodeIntegration stays off, only
 * the origin this shell launched is navigable, every permission request is denied, and opening an
 * external link is limited to https with no credentials, query or fragment. None of that is relaxed
 * for diagnostics; the log strips credentials instead.
 */
const {app,BrowserWindow,dialog,shell}=require('electron');
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const health=require('./health.cjs');
let backend,window,base,quitting=false,relaunching=false,ready=false,cleanup=null,log=null,lastExit='';
const smoke=process.argv.includes('--smoke-test');
const root=path.resolve(__dirname,'..');
const VERSION=require('./package.json').version;
// Fixed port for the packaged app (tools/paths.py PRODUCT_PORT), deliberately outside the ranges
// dev-serve.ps1 and runtime_manager.py use, so a dev session and a packaged copy can run together.
// An occupied port is now a fallback rather than a failure, but the base stays a literal: it is the
// documented convention, and tools/verify_editions.py reads it out of this file.
const PORT_BASE=18765;
const PORT_LAST=18795;
// Restart budget. Three attempts with growing backoff ride out a transient failure (a locked
// database during a backup, a slow antivirus scan) without hiding a permanent one behind a loop.
const RESTART_DELAYS=[500,1500,4000];
function projectDirectory(){let directory=path.dirname(app.isPackaged?process.execPath:__filename);for(let i=0;i<7;i++){if(fs.existsSync(path.join(directory,'pyproject.toml'))&&fs.existsSync(path.join(directory,'memora','core.py')))return directory;const parent=path.dirname(directory);if(parent===directory)break;directory=parent;}return null;}
const project=projectDirectory();
if(project&&!smoke){const userData=path.join(project,'runtime','desktop-userdata');fs.mkdirSync(userData,{recursive:true});app.setPath('userData',userData);}

// Every interesting moment goes to <data>/desktop.log as well as to stderr. A support report that
// says "it did not start" is unactionable; one that says "port 18765 busy, 18766 chosen, backend
// rejected the status probe after 45s" is a fix.
//
// stdout IS OPTIONAL AND ITS ABSENCE MUST NOT THROW. A packaged Windows app launched by double-click
// has no console attached: process.stdout is backed by a closed pipe, and writing to it raises EPIPE.
// The error surfaces as an EVENT on the stream (or as an async rejection), not on the synchronous
// stack, so a try/catch around console.log cannot catch it -- it becomes an uncaught exception and
// Electron shows a JavaScript-error dialog over a program that is otherwise working. Both halves are
// handled here: the stream error is swallowed, and the whole write is guarded so a synchronous throw
// (EPIPE on a flushed handle) cannot escape either.
let consoleUsable=true;
for(const stream of [process.stdout,process.stderr]){
  if(!stream)continue;
  stream.on('error',()=>{consoleUsable=false;});
}
function record(message){
  const line=typeof message==='string'?message:String(message);
  if(consoleUsable){
    try{console.log('[memora] '+line);}catch{consoleUsable=false;}
  }
  if(log)log.write(line);
}

/** An explicitly requested port is a contract: if it is taken we fail loudly rather than move. */
function explicitPort(){
  const raw=process.env.MEMORA_PORT;
  if(raw===undefined||raw==='')return null;
  const port=Number(raw);
  return Number.isInteger(port)&&port>0&&port<65536?port:null;
}

function backendCommand(){
  if(app.isPackaged)return {executable:path.join(process.resourcesPath,'backend',process.platform==='win32'?'memora-backend.exe':'memora-backend'),args:[]};
  const local=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  return {executable:process.env.MEMORA_PYTHON||(fs.existsSync(local)?local:'python'),args:['-m','memora']};
}

function workbenchUrl(origin){
  return origin+(process.env.MEMORA_PROJECT?'/?project='+encodeURIComponent(process.env.MEMORA_PROJECT):'');
}

async function stopBackend(){
  const child=backend;
  backend=null;
  if(!child)return;
  try{if(child.exitCode===null&&child.signalCode===null)child.kill();}catch{}
  // A failed spawn (missing interpreter) has no pid and never fires exit; waiting on it would stall
  // the first restart attempt for a second and a half for nothing.
  if(!child.pid)return;
  if(await health.waitForExit(child,1500))return;
  if(process.platform==='win32'){
    // child.kill() signals one process. A backend that forked a worker leaves the SQLite file open
    // through the grandchild, and the next launch meets a locked database.
    const killed=await health.killTree(child.pid);
    record('taskkill /PID '+child.pid+' /T /F -> '+(killed?'ok':'failed'));
  }
}

/**
 * Spawn the backend and wait until it answers as ours.
 *
 * SQLite spills temporary files during ALTER TABLE / CREATE INDEX and on Windows cannot do that
 * across volumes: a data directory on D: with TEMP on C: fails with the bare 'unable to open
 * database file' on first run. Pinning TEMP/TMP inside the data directory keeps scratch space on
 * the same volume as the database.
 */
async function startBackend(data){
  const {executable,args}=backendCommand();
  const requested=explicitPort();
  if(requested!==null)record('MEMORA_PORT='+requested+' (explicit: an occupied port is reported, not replaced)');
  const port=requested!==null?requested:await health.pickPort(PORT_BASE,PORT_LAST);
  if(requested===null)record(port?'port scan chose '+port+' (window '+PORT_BASE+'-'+PORT_LAST+')':'no free port in '+PORT_BASE+'-'+PORT_LAST+'; asking the backend for an OS-assigned one');
  const scratchDir=path.join(data,'.tmp');
  try{fs.mkdirSync(scratchDir,{recursive:true});}catch{}
  backend=spawn(executable,[...args,'--data',data,'serve',...(port?['--port',String(port)]:['--port','0'])],{cwd:app.isPackaged?app.getPath('userData'):root,env:{...process.env,PYTHONUNBUFFERED:'1',TEMP:scratchDir,TMP:scratchDir},windowsHide:true,stdio:['ignore','pipe','pipe']});
  record('backend spawned pid '+backend.pid+' port '+(port||'auto'));
  backend.stderr.on('data',chunk=>{record('backend stderr: '+chunk.toString().replace(/\s+$/,''));process.stderr.write(chunk);});
  const readiness=health.createReadiness({child:backend,expected:{port:port||null,version:VERSION,dataDir:health.canonicalPath(data)},log:record});
  let origin;
  try{origin=await readiness.promise;}
  catch(error){
    record('backend not ready: '+((error&&error.message)||error));
    lastExit=(error&&error.message)||String(error);
    await stopBackend();
    throw error;
  }
  record('backend ready at '+origin);
  return origin;
}

function showReconnect(info){
  if(!window||window.isDestroyed())return;
  // A blank window is indistinguishable from a hung application, and the user's only move then is
  // to kill and relaunch -- the exact behaviour this supervisor exists to replace. The page is a
  // data: URL with no script, so it works while the process that would serve assets is down.
  record('showing reconnect page (attempt '+info.attempt+'/'+info.total+')');
  void Promise.resolve(window.loadURL(health.reconnectUrl({...info,version:VERSION}))).catch(error=>record('reconnect page failed to load: '+((error&&error.message)||error)));
}

/**
 * Restart the backend after an unexpected exit.
 *
 * Bounded on purpose: three attempts, then the user is told and the app closes. Unlimited retries
 * would turn a broken install into a window that flickers forever; no retries is what this shell
 * did before. A deliberate quit never reaches here -- before-quit sets the flag first.
 */
async function recover(){
  if(quitting||relaunching||!window||!ready)return;
  relaunching=true;
  try{
    const outcome=await health.runRecovery({
      delays:RESTART_DELAYS,
      // A quit during the backoff wins: the user closed the window, and a backend that reappears
      // one second later has no window to serve.
      cancelled:()=>quitting,
      onAttempt:({attempt,total,delayMs})=>{
        record('restart attempt '+attempt+'/'+total+' in '+delayMs+'ms (cause: '+lastExit+')');
        showReconnect({attempt,total,retryInMs:delayMs,reason:lastExit});
      },
      attempt:()=>startBackend(dataDirectory),
    });
    if(outcome.recovered){
      base=outcome.value;
      record('backend recovered at '+base+'; reloading the workbench');
      if(window&&!window.isDestroyed())await window.loadURL(workbenchUrl(base));
      return;
    }
    if(outcome.cancelled)return;
    record('restart budget exhausted after '+outcome.attempts+' attempts; giving up: '+((outcome.error&&outcome.error.message)||''));
    if(!smoke)dialog.showErrorBox('Memora 无法连接本地后端','自动重启 '+outcome.attempts+' 次均失败，应用将退出。诊断日志：'+path.join(dataDirectory,'desktop.log'));
    app.quit();
  }finally{relaunching=false;}
}

let dataDirectory='';
async function launch(){
  // Where the database lives. An explicit override wins. A packaged copy ships its own `data/`
  // folder next to the executable -- empty schema-valid databases, a `markdown/` store and a `{}`
  // settings template -- so unpacking the ZIP and double-clicking is the whole install instead of
  // scattering state into %APPDATA%. A source checkout falls back to its own ./data, and a
  // detached install uses userData. An explicit override still wins for tests and scripts.
  const portable=app.isPackaged?path.resolve(path.dirname(process.execPath),'data'):null;
  dataDirectory=process.env.MEMORA_DATA||process.env.MM_DATA||
    (portable||(project?path.join(project,'data'):path.join(app.getPath('userData'),'memory')));
  try{fs.mkdirSync(dataDirectory,{recursive:true});}catch{}
  log=health.createLogger(path.join(dataDirectory,'desktop.log'));
  record('shell start version '+VERSION+' '+(app.isPackaged?'packaged':'source')+(smoke?' (smoke)':'')+' data '+dataDirectory);
  if(!smoke){
    let managed=process.env.MEMORA_RUNTIME_URL;
    if(!managed&&project){try{managed=JSON.parse(fs.readFileSync(path.join(project,'runtime','active.json'),'utf8').replace(/^\uFEFF/,'' )).url;}catch{}}
    if(managed){
      // Adopting an already-running managed backend saves a full start. The old probe gave it
      // 1800ms and swallowed the reason; a backend that is up but slow (index rebuild) is not the
      // same as one that is absent, and the log now says which of the two happened.
      try{
        const u=new URL(managed);
        if(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password){
          await health.probeStatus(u.origin,{version:VERSION,dataDir:health.canonicalPath(dataDirectory)},5000);
          base=u.origin;
          record('attached to managed backend '+base);
        }else record('managed backend url rejected by the loopback rule: '+managed);
      }catch(error){record('managed backend not adopted ('+managed+'): '+((error&&error.message)||error));}
    }
  }
  if(!base)base=await startBackend(dataDirectory);
  ready=true;
  window=new BrowserWindow({title:'Memora · 记忆体',show:!smoke,width:1460,height:950,minWidth:860,minHeight:650,backgroundColor:'#f6f7f3',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.setMenuBarVisibility(false);
  // `base` is deliberately read at call time rather than captured: a recovered backend may sit on a
  // different port, and the whitelist has to follow it or the reload is blocked by our own guard.
  const allowed=url=>{try{return new URL(url).origin===base;}catch{return false;}};
  const external=url=>{try{const u=new URL(url);return (!u.username&&!u.password&&!u.search&&!u.hash&&u.protocol==='https:')||/^codex:\/\/threads\/[0-9a-f-]{36}$/i.test(url);}catch{return false;}};
  window.webContents.setWindowOpenHandler(({url})=>{if(allowed(url)){const child=new BrowserWindow({parent:window,width:1250,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});child.setMenuBarVisibility(false);child.webContents.setWindowOpenHandler(()=>({action:'deny'}));child.webContents.on('will-navigate',(e,target)=>{if(!allowed(target))e.preventDefault();});void child.loadURL(url);}else if(external(url))void shell.openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(!allowed(url)){event.preventDefault();if(external(url))void shell.openExternal(url);}});
  window.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  window.webContents.on('did-fail-load',(_event,code,description,url,isMainFrame)=>{if(isMainFrame)record('load failed '+code+' '+description+' for '+url);});
  // A wedged renderer is usually a stuck request against a backend that just died; reloading once
  // is cheaper than making the user notice, and the attempt is logged so a reload loop is visible.
  window.on('unresponsive',()=>{record('renderer unresponsive; reloading the window');window.webContents.reload();});
  window.on('responsive',()=>record('renderer responsive again'));
  window.on('closed',()=>{window=null;app.quit();});
  if(backend){
    // The supervisor listener is attached once, after readiness: a child that dies DURING startup is
    // a startup failure (handled by startBackend), not a crash to recover from. Smoke runs skip it
    // entirely -- they quit on purpose seconds later, and a restart there would outlive the test.
    const supervisor=(code,signal)=>{if(quitting||smoke)return;lastExit='exit code '+code+' signal '+signal;record('backend exited unexpectedly (code '+code+', signal '+signal+')');void recover();};
    if(backend.exitCode!==null||backend.signalCode!==null)supervisor(backend.exitCode,backend.signalCode);
    else backend.on('exit',supervisor);
  }
  // In smoke mode the window has to be judged, not waited on forever: a headless or sandboxed
  // session can leave loadURL pending until something kills the process, and a run that never
  // finishes proves nothing either way. Ten seconds is far past a loopback document load.
  const loaded=smoke?await Promise.race([window.loadURL(workbenchUrl(base)).then(()=>true).catch(error=>{record('load failed: '+((error&&error.message)||error));return false;}),new Promise(resolve=>setTimeout(()=>resolve('timeout'),10000))]):await window.loadURL(workbenchUrl(base)).then(()=>true);
  if(smoke){
    if(loaded!==true){record('smoke: the window did not finish loading ('+loaded+')');app.exit(1);return;}
    // The smoke contract is a STDOUT line; a run under `electron --smoke-test` has a console, but a
    // packaged --smoke-test launched by a script may not. Guarded for the same EPIPE reason as
    // record() -- losing the line is acceptable, an uncaught exception is not.
    if(consoleUsable){try{console.log('MEMORA_DESKTOP_READY '+window.webContents.getTitle());}catch{}}
    app.quit();
  }
}

if(!app.requestSingleInstanceLock())app.quit();
else{app.on('second-instance',()=>{if(window){window.restore();window.focus();}});app.whenReady().then(launch).catch(error=>{
  // A startup failure must leave a trace: showErrorBox is invisible when the shell cannot open a
  // window (headless, remote session, sandboxed launch), and a dialog nobody sees is indistinguishable
  // from a silent crash. Write the reason next to the data first, then show the box.
  record('startup failed: '+((error&&error.stack)||error));
  try{const trace=path.join(dataDirectory||process.env.MEMORA_DATA||path.join(app.getPath('userData'),'memory'),'startup-error.log');fs.mkdirSync(path.dirname(trace),{recursive:true});fs.writeFileSync(trace,new Date().toISOString()+' '+((error&&error.stack)||error)+'\n');}catch{}
  // app.exit skips will-quit, so the tree has to be taken down here or the backend outlives a
  // failed smoke run and holds the data directory for the next one.
  if(smoke){try{if(backend)backend.kill();}catch{}if(consoleUsable){try{console.error(error.message);}catch{}}app.exit(1);}else{dialog.showErrorBox('Memora 无法启动',String(error&&error.message||error));app.quit();}});}

app.on('before-quit',()=>{
  // Set first: the supervisor checks this flag, and a deliberate quit must never look like a crash
  // and trigger a restart against the user's wishes.
  if(quitting)return;
  quitting=true;
  record('shell quitting');
  try{if(backend&&backend.exitCode===null&&backend.signalCode===null)backend.kill();}catch{}
});

app.on('will-quit',event=>{
  // Windows does not take descendants down with the parent, and this app owns the backend tree.
  // Stopping it from here is asynchronous, so quit is deferred once -- with a hard time budget,
  // because an unbounded wait turns an ordinary window close into a frozen application.
  if(cleanup)return;
  const pid=backend&&backend.pid&&backend.exitCode===null&&backend.signalCode===null?backend.pid:null;
  if(!pid)return;
  event.preventDefault();
  const started=Date.now();
  cleanup=(async()=>{
    try{await Promise.race([health.killTree(pid),new Promise(resolve=>setTimeout(resolve,2500))]);}catch{}
    record('process tree '+pid+' stopped in '+(Date.now()-started)+'ms');
    try{if(backend)backend.kill();}catch{}
    app.quit();
  })();
});

app.on('window-all-closed',()=>app.quit());
