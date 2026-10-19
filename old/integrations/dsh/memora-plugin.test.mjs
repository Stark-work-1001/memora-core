import test from 'node:test';import assert from 'node:assert/strict';
import {extractSessionTurns,readSessionTurns,apply} from './memora-plugin.mjs';
test('archive only real user and assistant text, preserving event IDs and original dates',()=>{
 const events=[{seq:0,time:1000,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'A real user request'}]}},
 {seq:1,time:2000,type:'user/message',data:{source:{kind:'memora-context'},content:[{type:'text',text:'Recalled memory must not feed itself back'}]}},
 {seq:2,time:3000,type:'tool/result',data:{message:{content:[{type:'text',text:'Private tool output'}]}}},
 {seq:3,time:4000,type:'assistant/message',data:{message:{content:[{type:'thinking',text:'Not archived'},{type:'text',text:'Final response'}]}}}];
 const session={seq:events.length,eventAt:i=>events[i]};
 const turns=extractSessionTurns(session);assert.deepEqual(turns.map(t=>t.seq),[0,3]);assert.deepEqual(turns.map(t=>t.role),['user','assistant']);
 assert.equal(turns[0].created,'1970-01-01T00:00:01.000Z');assert.equal(extractSessionTurns(session,3).length,1);
});

test('modern snapshot session keeps raw user messages and stable sequence numbers',async()=>{
 const events=[{seq:9,time:1000,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'A durable request'}]}},
  {seq:12,time:2000,type:'assistant/message',data:{message:{content:[{type:'text',text:'Recorded outcome'}]}}}];
 const agent={session:{id:'session',snapshotEvents:after=>events.filter(e=>e.seq>=after)}};
 assert.deepEqual((await readSessionTurns(agent,10)).map(t=>t.seq),[12]);
});

test('observation lease is released and earlier turns are not redelivered',async()=>{
 let disposed=0;
 const query={observeSession:async(id,options)=>{
  assert.equal(id,'s');assert.equal(options.projectionMode,'none');
  return {events:[{seq:4,time:1000,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'source'}]}}],dispose(){disposed++;}};
 }};
 assert.deepEqual(await readSessionTurns({session:{id:'s'}},5,query),[]);
 assert.equal(disposed,1);
});

test('missing message adapter does not prevent lifecycle registration',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'memora-lifecycle-'));
 const handlers=new Map();
 try{
  await apply({on(name,fn){handlers.set(name,fn);}}, {project:'test',outbox:root,url:'http://127.0.0.1:1/mcp',tokenFile:path.join(root,'missing')});
  assert.ok(handlers.has('agent/turn-stopping'));assert.ok(handlers.has('agent/pre-step'));
  await handlers.get('dispose')();
 }finally{
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('memora-lifecycle-'));
  await fs.rm(root,{recursive:true,force:true});
 }
});
