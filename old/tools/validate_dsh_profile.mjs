// Real shipped DSH sdk-minimal profile, local Qwen conversation model, real MCP and memory models.
import path from 'node:path';import fs from 'node:fs/promises';import {pathToFileURL} from 'node:url';
import os from 'node:os';
const root=path.resolve(import.meta.dirname,'..'),
      dsh=process.env.MEMORA_DSH_ROOT||path.join(os.homedir(),'.dsh');
const runId=Date.now().toString(36),project='dsh-check-'+runId;
const {DeepSeekHarness}=await import(pathToFileURL(path.join(dsh,'app/src/packages/sdk/client/lib/index.js')).href);
const home=path.join(root,'artifacts/dsh-profile-test'),workspace=path.join(home,'workspace');await fs.mkdir(workspace,{recursive:true});
const overlay=path.join(home,'memora.cordis.yml');const q=s=>JSON.stringify(s.replaceAll('\\','/'));
await fs.writeFile(overlay,`- insert:
    - id: memory-memora-validation
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memora
        transport: stdio
        command: ${q(path.join(root,'.venv/Scripts/python.exe'))}
        args: ['-m', memora, '--data', ${q(path.join(root,'data'))}, mcp]
        cwd: ${q(root)}
        env: {PYTHONUTF8: '1', TEMP: ${q(path.join(root,'runtime/tmp'))}, TMP: ${q(path.join(root,'runtime/tmp'))}}
        toolCallTimeoutMs: 120000
    - id: memora-lifecycle-validation
      name: ${q(path.join(root,'integrations/dsh/memora-plugin.mjs'))}
      config:
        project: ${project}
        url: 'http://127.0.0.1:18184/mcp'
        tokenFile: ${q(path.join(root,'data/mcp-token'))}
        outbox: ${q(path.join(home,'outbox'))}
        llmModule: ${q(path.join(dsh,'app/src/packages/llm/llm/lib/index.js'))}
`);
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/KEY|PASSWORD|SECRET|TOKEN/i.test(k)));
Object.assign(env,{DEEPSEEK_API_KEY:'local-fixture-only',DEEPSEEK_BASE_URL:'http://127.0.0.1:18182/v1',DSH_CONTEXT_WINDOW:'8192',TEMP:path.join(root,'runtime/tmp'),TMP:path.join(root,'runtime/tmp')});
const harness=new DeepSeekHarness({dshBin:path.join(dsh,'app/src/apps/cli/lib/bin.js'),profile:'sdk-minimal',dshHome:home,processCwd:workspace,cwd:workspace,
 patches:[overlay],provider:'deepseek-official',model:'qwen3.8-2b-judge',maxTokens:512,initializeTimeoutMs:60000,requestTimeoutMs:90000,env});
try{
 const first=await harness.run('请记住：我的验证饮品是桂花乌龙 memora-dsh-check。',{sessionId:'memora-validation-a-'+runId});
 let completed=false;
 for(let attempt=0;attempt<60;attempt++){
  const response=await fetch('http://127.0.0.1:8765/api/agent/jobs?project='+project);const jobs=(await response.json()).items;
  completed=jobs.some(j=>j.input.external_id==='memora-validation-a-'+runId&&j.status==='done'&&j.output.memories?.some(m=>m.status==='approved'));
  if(completed)break;await new Promise(r=>setTimeout(r,1000));
 }
 if(!completed)throw new Error('Automatic accumulation did not produce an approved memory within 60 seconds');
 const second=await harness.run('我之前提到的验证饮品是什么？只根据已提供的记忆回答。',{sessionId:'memora-validation-b-'+runId});
 const evidence=second.events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='memora-context');
 const report={real_shipped_profile:'sdk-minimal',project,local_conversation_model:'qwen3.8-2b-judge',firstResponse:first.finalResponse,secondResponse:second.finalResponse,
   automatic_memory_contexts:evidence.length,firstSessionMessages:first.events.filter(e=>e.type==='user/message'||e.type==='assistant/message').length,
   isolated_dsh_home:true,used_cloud_credentials:false};
 await fs.writeFile(path.join(home,'validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 if(!evidence.length)throw new Error('No automatic recalled context in the second real DSH session');
}finally{await harness.close();}
